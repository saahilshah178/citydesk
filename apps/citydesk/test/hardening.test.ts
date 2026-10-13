/**
 * Behaviour that matters because the deployed server is public and its demo token is handed to
 * every browser: one caller must not be able to spend what belongs to everyone, read another
 * household's data, or learn about the account behind the service.
 */
import { SOURCE_IP_HEADER } from 'open311-mcp';
import { describe, expect, it } from 'vitest';
import { DEVICE_HEADER, VIEWER_IP_HEADER, callerOf, resolveUser } from '../src/app.ts';
import type { ErrorResult, IssueResult, ScheduleResult } from '../src/contract.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { harness, TOKEN } from './harness.ts';

const graffiti = { issue_type: 'graffiti', description: 'Graffiti', location: '700 Boylston Street', file_even_if_duplicate: true };

describe('filing ceilings', () => {
  it('one household hammering the tool does not use up the allowance of the others', async () => {
    const h = harness({ config: { maxFilingsPerUserPerHour: 2, maxFilingsPerHour: 5 } });
    const noisy = await h.connect('household-0001', '203.0.113.1');
    for (let i = 0; i < 2; i++) expect((await h.call<IssueResult>(noisy, 'report_issue', graffiti)).data.outcome).toBe('filed');
    for (let i = 0; i < 6; i++) expect((await h.call<ErrorResult>(noisy, 'report_issue', graffiti)).data.error.code).toBe('rate_limited');

    // Three more households can still file: the overall ceiling of 5 counts reports filed, not attempts.
    for (const [n, address] of ['203.0.113.2', '203.0.113.3', '203.0.113.4'].entries()) {
      const other = await h.connect(`household-100${n}`, address);
      expect((await h.call<IssueResult>(other, 'report_issue', graffiti)).data.outcome).toBe('filed');
    }
    expect(await h.runtime.sandbox.store.list()).toHaveLength(5);
  });

  it('claiming to be a new household each time does not get around the limit per network address', async () => {
    const h = harness({ config: { maxFilingsPerUserPerHour: 1, maxFilingsPerCallerPerHour: 3, maxFilingsPerHour: 100 } });
    const outcomes: string[] = [];
    for (let i = 0; i < 6; i++) {
      const client = await h.connect(`rotating-device-${i}`, '203.0.113.9');
      outcomes.push((await h.call<IssueResult | ErrorResult>(client, 'report_issue', graffiti)).data.outcome);
    }
    expect(outcomes).toEqual(['filed', 'filed', 'filed', 'error', 'error', 'error']);
    // Someone else, elsewhere, is unaffected.
    const elsewhere = await h.connect('household-elsewhere', '203.0.113.200');
    expect((await h.call<IssueResult>(elsewhere, 'report_issue', graffiti)).data.outcome).toBe('filed');
  });

  it('a refusal is remembered locally: repeated attempts cost no further database writes', async () => {
    const store = new MemoryStore();
    let increments = 0;
    const counting = Object.assign(Object.create(Object.getPrototypeOf(store)) as MemoryStore, store, {
      increment: async (name: string, ttl: number) => (increments++, store.increment(name, ttl)),
    });
    const h = harness({ store: counting, sandboxStore: store.sandboxStore(), config: { maxFilingsPerUserPerHour: 1 } });
    const client = await h.connect('household-0001');
    await h.call(client, 'report_issue', graffiti);
    await h.call(client, 'report_issue', graffiti);
    const after = increments;
    for (let i = 0; i < 5; i++) await h.call(client, 'report_issue', graffiti);
    expect(increments).toBe(after);
  });
});

describe('the city request budget', () => {
  it('a flood of status lookups cannot stop duplicate checks from working', async () => {
    const h = harness();
    const flood = await h.connect('household-flood', '203.0.113.5');
    const results = [];
    for (let i = 0; i < 12; i++) {
      results.push(await h.call<ErrorResult>(flood, 'request_status', { request_id: `boston/00000000-0000-0000-0000-0000000000${String(i).padStart(2, '0')}` }));
    }
    // The lookups ran into their own share of the per-minute budget...
    expect(results.some((r) => r.data.error.code === 'rate_limited')).toBe(true);
    // ...and another household's report still gets its duplicate check.
    const resident = await h.connect('household-0002', '203.0.113.6');
    const r = await h.call<IssueResult>(resident, 'report_issue', { issue_type: 'pothole', description: 'Pothole', location: '1079 Commonwealth Avenue' });
    expect(r.data.outcome).toBe('possible_duplicate');
  });

  it('an ID that cannot exist is rejected without asking the city', async () => {
    const h = harness();
    const client = await h.connect();
    const before = h.calls.length;
    for (const id of ['boston/has spaces', 'boston/../../etc/passwd', `boston/${'x'.repeat(200)}`, 'citydesk-sandbox/not-a-sandbox-id']) {
      const r = await h.call<ErrorResult>(client, 'request_status', { request_id: id });
      expect(r.isError).toBe(true);
      // Either our own structured error, or the schema refusing the argument before the tool runs.
      if (r.data) expect(['not_found', 'invalid_input']).toContain(r.data.error.code);
    }
    expect(h.calls.length).toBe(before);
  });
});

describe('households', () => {
  it('clients that send no device ID are kept apart by network address, not merged into one household', async () => {
    const h = harness();
    const a = await h.connect(null, '203.0.113.10');
    await h.call(a, 'collection_schedule', { address: '700 Boylston Street' });
    // Same address, still no device ID: the same household.
    expect((await h.call<ScheduleResult>(await h.connect(null, '203.0.113.10'), 'collection_schedule')).data.schedule?.address).toBe('700 Boylston St');
    // A different address without a device ID, and one sending a too-short ID, see nothing of it.
    for (const stranger of [await h.connect(null, '203.0.113.11'), await h.connect('kitchen', '203.0.113.12')]) {
      const r = await h.call<ScheduleResult>(stranger, 'collection_schedule');
      expect(r.data.outcome).toBe('needs_clarification');
    }
  });

  it('derives stable, hashed identities', () => {
    const a = resolveUser('tok', 'device-aaaa-0001', '203.0.113.1');
    expect(a.userId).toMatch(/^u_[0-9a-f]{32}$/);
    expect(resolveUser('tok', 'device-aaaa-0001', '198.51.100.99').userId).toBe(a.userId);
    expect(resolveUser('tok', 'device-bbbb-0002', '203.0.113.1').userId).not.toBe(a.userId);
    expect(resolveUser('other', 'device-aaaa-0001', '203.0.113.1').userId).not.toBe(a.userId);
    expect(resolveUser('tok', null, '203.0.113.1').userId).not.toBe(resolveUser('tok', null, '203.0.113.2').userId);
    expect(JSON.stringify(a)).not.toContain('203.0.113.1');
  });

  it('saves the home address once, not on every lookup', async () => {
    const store = new MemoryStore();
    let writes = 0;
    const counting = Object.assign(Object.create(Object.getPrototypeOf(store)) as MemoryStore, store, {
      setHomeAddress: async (...args: Parameters<MemoryStore['setHomeAddress']>) => (writes++, store.setHomeAddress(...args)),
    });
    const h = harness({ store: counting, sandboxStore: store.sandboxStore() });
    const client = await h.connect();
    for (let i = 0; i < 4; i++) await h.call(client, 'collection_schedule', { address: '700 Boylston Street' });
    await h.call(client, 'collection_schedule');
    expect(writes).toBe(1);
    await h.call(client, 'collection_schedule', { address: '10 Adams Street' });
    expect(writes).toBe(2);
  });
});

describe('per-caller request limit', () => {
  const request = (headers: Record<string, string>): Request =>
    new Request('http://localhost:8787/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}`, 'mcp-protocol-version': '2025-11-25', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

  it('answers 429 with Retry-After once one address passes its minute allowance, and recovers the next minute', async () => {
    const h = harness();
    const statuses: number[] = [];
    for (let i = 0; i < 302; i++) statuses.push((await h.app(request({ [SOURCE_IP_HEADER]: '203.0.113.50' }))).status);
    expect(statuses.slice(0, 300).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(300)).toEqual([429, 429]);
    const refused = await h.app(request({ [SOURCE_IP_HEADER]: '203.0.113.50' }));
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await h.app(request({ [SOURCE_IP_HEADER]: '203.0.113.51' }))).status).toBe(200);
    h.advance(60_000);
    expect((await h.app(request({ [SOURCE_IP_HEADER]: '203.0.113.50' }))).status).toBe(200);
  });

  it('limits each visitor behind a CDN edge separately, at the lower visitor allowance', async () => {
    const h = harness();
    const edge = { [SOURCE_IP_HEADER]: '130.176.0.1' };
    let last = 200;
    for (let i = 0; i < 61; i++) last = (await h.app(request({ ...edge, [VIEWER_IP_HEADER]: '203.0.113.60' }))).status;
    expect(last).toBe(429);
    expect((await h.app(request({ ...edge, [VIEWER_IP_HEADER]: '203.0.113.61' }))).status).toBe(200);
  });

  it('reads the caller from the adapter header and ignores a malformed visitor header', () => {
    const r = (headers: Record<string, string>) => callerOf(new Request('http://x/mcp', { headers }));
    expect(r({ [SOURCE_IP_HEADER]: '203.0.113.1' })).toEqual({ source: '203.0.113.1', visitor: '203.0.113.1' });
    expect(r({ [SOURCE_IP_HEADER]: '130.176.0.1', [VIEWER_IP_HEADER]: '2001:db8::1' })).toEqual({ source: '130.176.0.1', visitor: '2001:db8::1' });
    expect(r({ [SOURCE_IP_HEADER]: '130.176.0.1', [VIEWER_IP_HEADER]: '<script>' }).visitor).toBe('130.176.0.1');
    expect(r({ [DEVICE_HEADER]: 'x' }).source).toBe('unknown');
  });
});

describe('errors do not describe the account', () => {
  it('a failing dependency is reported generically, with the detail kept for the server log', async () => {
    const logged: Array<Record<string, unknown> | undefined> = [];
    const store = new MemoryStore();
    const failing = Object.assign(Object.create(Object.getPrototypeOf(store)) as MemoryStore, store, {
      list: async () => {
        throw Object.assign(
          new Error('User: arn:aws:sts::123456789012:assumed-role/CityDesk-McpRole/x is not authorized to perform: dynamodb:Query on resource: arn:aws:dynamodb:us-east-1:123456789012:table/citydesk-user-requests'),
          { name: 'AccessDeniedException' },
        );
      },
    });
    const h = harness({ store: failing, sandboxStore: store.sandboxStore(), log: (_event, data) => logged.push(data) });
    const r = await h.call<ErrorResult>(await h.connect(), 'my_requests');
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe('not_configured');
    const visible = JSON.stringify(r.data) + r.text;
    for (const secret of ['123456789012', 'arn:aws', 'citydesk-user-requests', 'McpRole']) expect(visible).not.toContain(secret);
    expect(JSON.stringify(logged)).toContain('123456789012');
  });

  it('a throttled dependency is a retryable rate_limited error', async () => {
    const store = new MemoryStore();
    const throttled = Object.assign(Object.create(Object.getPrototypeOf(store)) as MemoryStore, store, {
      list: async () => {
        throw Object.assign(new Error('The level of configured provisioned throughput for the table was exceeded.'), { name: 'ProvisionedThroughputExceededException' });
      },
    });
    const h = harness({ store: throttled, sandboxStore: store.sandboxStore() });
    const r = await h.call<ErrorResult>(await h.connect(), 'my_requests');
    expect(r.data.error).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(JSON.stringify(r.data)).not.toContain('provisioned throughput');
  });
});
