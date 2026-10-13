import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DynamoStore } from '../src/store/dynamo.ts';
import { MemoryStore } from '../src/store/memory.ts';
import type { TrackedRequest, UserStore } from '../src/store/types.ts';
import { FakeDynamo } from './fakeDynamo.ts';

const NOW = Date.parse('2026-10-13T12:00:00Z');

function tracked(id: string, relation: 'filed' | 'followed', since: string): TrackedRequest {
  return {
    request_id: `boston/${id}`,
    endpoint_id: 'boston',
    service_request_id: id,
    relation,
    since,
    service_name: 'Pothole',
    address: '700 Boylston St',
  };
}

const stores: Array<[string, () => { store: UserStore; fake?: FakeDynamo }]> = [
  ['MemoryStore', () => ({ store: new MemoryStore() })],
  [
    'DynamoStore',
    () => {
      const fake = new FakeDynamo();
      return { store: new DynamoStore({ tableName: 'citydesk-test', client: fake, now: () => NOW }), fake };
    },
  ],
];

describe.each(stores)('%s: the UserStore contract', (_name, make) => {
  it('lists a user\'s requests newest first and keeps users apart', async () => {
    const { store } = make();
    await store.track('alice', tracked('a', 'followed', '2026-10-10T10:00:00.000Z'));
    await store.track('alice', tracked('b', 'filed', '2026-10-12T10:00:00.000Z'));
    await store.track('bob', tracked('c', 'filed', '2026-10-11T10:00:00.000Z'));
    expect((await store.list('alice')).map((r) => r.service_request_id)).toEqual(['b', 'a']);
    expect((await store.list('bob')).map((r) => r.service_request_id)).toEqual(['c']);
    expect(await store.list('carol')).toEqual([]);
    expect(await store.get('alice', 'boston/a')).toMatchObject({ relation: 'followed', address: '700 Boylston St' });
    expect(await store.get('bob', 'boston/a')).toBeUndefined();
  });

  it('never downgrades a filed request to followed, and keeps the original date', async () => {
    const { store } = make();
    await store.track('alice', tracked('a', 'filed', '2026-10-10T10:00:00.000Z'));
    const merged = await store.track('alice', tracked('a', 'followed', '2026-10-13T10:00:00.000Z'));
    expect(merged).toMatchObject({ relation: 'filed', since: '2026-10-10T10:00:00.000Z' });
    expect(await store.list('alice')).toHaveLength(1);
    // Following first and filing later does upgrade.
    await store.track('alice', tracked('b', 'followed', '2026-10-10T10:00:00.000Z'));
    expect((await store.track('alice', tracked('b', 'filed', '2026-10-11T10:00:00.000Z'))).relation).toBe('filed');
  });

  it('records the last status seen, clears a note that went away, and ignores untracked requests', async () => {
    const { store } = make();
    await store.track('alice', tracked('a', 'followed', '2026-10-10T10:00:00.000Z'));
    await store.snapshot('alice', 'boston/a', { status: 'open', status_notes: 'Crew assigned', checked: '2026-10-13T12:00:00.000Z' });
    expect(await store.get('alice', 'boston/a')).toMatchObject({ last_status: 'open', last_status_notes: 'Crew assigned' });
    await store.snapshot('alice', 'boston/a', { status: 'closed', checked: '2026-10-14T12:00:00.000Z' });
    const after = await store.get('alice', 'boston/a');
    expect(after).toMatchObject({ last_status: 'closed', last_checked: '2026-10-14T12:00:00.000Z', relation: 'followed' });
    expect(after?.last_status_notes).toBeUndefined();

    await store.snapshot('alice', 'boston/never-tracked', { status: 'open', checked: '2026-10-13T12:00:00.000Z' });
    expect(await store.get('alice', 'boston/never-tracked')).toBeUndefined();
    expect(await store.list('alice')).toHaveLength(1);
  });

  it('saves a home address per user without mixing it into the request list', async () => {
    const { store } = make();
    expect(await store.getHomeAddress('alice')).toBeUndefined();
    await store.setHomeAddress('alice', { address_id: '156199', address: '700 Boylston St', zip_code: '02116', saved_at: '2026-10-13T12:00:00.000Z' });
    expect(await store.getHomeAddress('alice')).toMatchObject({ address: '700 Boylston St', address_id: '156199' });
    expect(await store.getHomeAddress('bob')).toBeUndefined();
    expect(await store.list('alice')).toEqual([]);
  });
});

describe.each(stores)('%s: counters', (_name, make) => {
  it('counts up per name', async () => {
    const { store } = make();
    expect(await store.increment('filings#alice#1', 7200)).toBe(1);
    expect(await store.increment('filings#alice#1', 7200)).toBe(2);
    expect(await store.increment('filings#bob#1', 7200)).toBe(1);
    expect(await store.increment('filings#alice#2', 7200)).toBe(1);
  });
});

describe('DynamoStore specifics', () => {
  it('uses the documented keys and sets a TTL on every item', async () => {
    const fake = new FakeDynamo();
    const store = new DynamoStore({ tableName: 'citydesk-test', client: fake, now: () => NOW });
    await store.track('alice', tracked('a', 'filed', '2026-10-13T12:00:00.000Z'));
    await store.setHomeAddress('alice', { address_id: '1', address: '1 A St', saved_at: '2026-10-13T12:00:00.000Z' });
    await store.sandboxStore().put({ service_request_id: 'SB-10001', token: 't', service_code: 'sandbox-pothole', service_name: 'Pothole', requested_at: NOW });

    const keys = [...fake.items.values()].map((i) => `${String(i.pk)} | ${String(i.sk)}`).sort();
    expect(keys).toEqual([
      `SANDBOX | T#${String(NOW).padStart(15, '0')}#SB-10001`,
      'SANDBOXID | SB-10001',
      'USER#alice | PROFILE#home',
      'USER#alice | REQ#boston/a',
    ]);
    const nowSeconds = Math.floor(NOW / 1000);
    for (const item of fake.items.values()) {
      expect(item.ttl).toBeGreaterThan(nowSeconds + 80 * 86_400);
      expect(item.ttl).toBeLessThanOrEqual(nowSeconds + 180 * 86_400);
    }
    expect(fake.commands.every((c) => c.input.TableName === 'citydesk-test')).toBe(true);
    // Stored attributes never leak the table keys back to callers.
    expect(await store.get('alice', 'boston/a')).not.toHaveProperty('pk');
  });

  it('keeps counters in their own partition with a TTL, using an atomic ADD', async () => {
    const fake = new FakeDynamo();
    const store = new DynamoStore({ tableName: 'citydesk-test', client: fake, now: () => NOW });
    await store.increment('filings#all#480000', 7200);
    const command = fake.commands.at(-1)!;
    expect(command.input.Key).toEqual({ pk: 'COUNTER', sk: 'filings#all#480000' });
    expect(command.input.UpdateExpression).toBe('ADD #n :one SET #ttl = if_not_exists(#ttl, :ttl)');
    expect((command.input.ExpressionAttributeValues as Record<string, number>)[':ttl']).toBe(Math.floor(NOW / 1000) + 7200);
    // Counters never show up as a user's requests.
    expect(await store.list('all')).toEqual([]);
  });

  it('follows pagination when listing', async () => {
    const fake = new FakeDynamo();
    fake.pageSize = 2;
    const store = new DynamoStore({ tableName: 'citydesk-test', client: fake, now: () => NOW });
    for (let i = 0; i < 5; i++) await store.track('alice', tracked(`r${i}`, 'followed', `2026-10-0${i + 1}T00:00:00.000Z`));
    expect((await store.list('alice')).map((r) => r.service_request_id)).toEqual(['r4', 'r3', 'r2', 'r1', 'r0']);
    expect(fake.commands.filter((c) => c.name === 'QueryCommand')).toHaveLength(3);

    const sandbox = store.sandboxStore();
    for (let i = 0; i < 3; i++) {
      await sandbox.put({ service_request_id: `SB-${i}`, token: `t${i}`, service_code: 'sandbox-pothole', service_name: 'Pothole', requested_at: NOW + i });
    }
    expect((await sandbox.list()).map((r) => r.service_request_id)).toEqual(['SB-2', 'SB-1', 'SB-0']);
    expect(await sandbox.get('SB-1')).toMatchObject({ token: 't1' });
    expect(await sandbox.get('SB-9')).toBeUndefined();
  });

  it('reads only the sandbox requests it is asked for, however many are stored', async () => {
    const fake = new FakeDynamo();
    const store = new DynamoStore({ tableName: 'citydesk-test', client: fake, now: () => NOW });
    const sandbox = store.sandboxStore();
    const HOUR = 3_600_000;
    // 700 requests over the past 29 days: what three and a half hours at the filing cap would leave behind.
    for (let i = 0; i < 700; i++) {
      await sandbox.put({ service_request_id: `SB-${i}`, token: `t${i}`, service_code: 'sandbox-pothole', service_name: 'Pothole', requested_at: NOW - i * HOUR });
    }
    fake.itemsRead = 0;
    const lastDay = await sandbox.list({ since: NOW - 20 * HOUR });
    expect(lastDay).toHaveLength(21);
    expect(fake.itemsRead).toBe(21);

    fake.itemsRead = 0;
    const newest = await sandbox.list({ limit: 50 });
    expect(newest.map((r) => r.service_request_id).slice(0, 3)).toEqual(['SB-0', 'SB-1', 'SB-2']);
    expect(newest).toHaveLength(50);
    expect(fake.itemsRead).toBe(50);

    // A lookup by ID is one GetItem, not a query.
    const queries = fake.commands.filter((c) => c.name === 'QueryCommand').length;
    expect(await sandbox.get('SB-650')).toMatchObject({ token: 't650' });
    expect(fake.commands.filter((c) => c.name === 'QueryCommand')).toHaveLength(queries);
    expect(fake.commands.at(-1)).toMatchObject({ name: 'GetCommand', input: { Key: { pk: 'SANDBOXID', sk: 'SB-650' } } });
  });
});

describe('MemoryStore persistence', () => {
  it('survives a restart when given a file, which is what makes "the next day" work locally', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'citydesk-')), 'store.json');
    const first = new MemoryStore(file);
    await first.track('alice', tracked('a', 'filed', '2026-10-13T12:00:00.000Z'));
    await first.setHomeAddress('alice', { address_id: '1', address: '1 A St', saved_at: '2026-10-13T12:00:00.000Z' });
    await first.sandboxStore().put({ service_request_id: 'SB-10001', token: 't', service_code: 'sandbox-pothole', service_name: 'Pothole', requested_at: NOW });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveProperty('users.alice');

    const second = new MemoryStore(file);
    expect(await second.list('alice')).toHaveLength(1);
    expect(await second.getHomeAddress('alice')).toMatchObject({ address: '1 A St' });
    expect(await second.sandboxStore().get('SB-10001')).toMatchObject({ service_name: 'Pothole' });
  });
});
