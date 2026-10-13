import { describe, expect, it } from 'vitest';
import { SharedDayCounter, ssmConfigSource } from '../server/aws.ts';
import { envSource, layeredSource, loadConfig } from '../server/config.ts';
import { createLimiter } from '../server/limits.ts';

describe('ssmConfigSource', () => {
  function fakeSsm(parameters: Record<string, string>, fail = false) {
    const calls: unknown[] = [];
    return {
      calls,
      client: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        send: async (command: any) => {
          calls.push(command.input);
          if (fail) throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
          return { Parameters: Object.entries(parameters).map(([Name, Value]) => ({ Name, Value })) };
        },
      } as never,
    };
  }

  it('supplies the MCP token from Parameter Store, decrypted, ahead of the environment', async () => {
    const ssm = fakeSsm({ '/citydesk/mcp-bearer-token': 'from-ssm' });
    const source = layeredSource(ssmConfigSource({ prefix: '/citydesk', client: ssm.client }), envSource({ MCP_CLIENT_TOKEN: 'from-env', MCP_URL: '/mcp' }));
    const config = await loadConfig(source);
    expect(config.mcpToken).toBe('from-ssm');
    expect(config.mcpUrl).toBe('/mcp');
    expect(ssm.calls).toEqual([{ Names: ['/citydesk/mcp-bearer-token'], WithDecryption: true }]);
  });

  it('answers only for mapped names and reads Parameter Store once per cache window', async () => {
    const ssm = fakeSsm({ '/citydesk/mcp-bearer-token': 'tok-a, tok-b' });
    let t = 0;
    const source = ssmConfigSource({ prefix: '/citydesk/', client: ssm.client, ttlMs: 1000, now: () => t });
    expect(await source('BEDROCK_MODEL_ID')).toBeUndefined();
    expect(ssm.calls).toHaveLength(0);
    expect(await source('MCP_CLIENT_TOKEN')).toBe('tok-a');
    expect(await source('MCP_CLIENT_TOKEN')).toBe('tok-a');
    expect(ssm.calls).toHaveLength(1);
    t = 1500;
    await source('MCP_CLIENT_TOKEN');
    expect(ssm.calls).toHaveLength(2);
  });

  it('falls back to the environment when Parameter Store cannot be read, without logging a secret', async () => {
    const ssm = fakeSsm({}, true);
    const logged: string[] = [];
    const source = layeredSource(
      ssmConfigSource({ prefix: '/citydesk', client: ssm.client, log: (m) => logged.push(m) }),
      envSource({ MCP_CLIENT_TOKEN: 'from-env' }),
    );
    expect((await loadConfig(source)).mcpToken).toBe('from-env');
    expect(logged).toEqual(['could not read /citydesk/* from Parameter Store: AccessDeniedException']);
  });
});

describe('SharedDayCounter', () => {
  function fakeDynamo() {
    const counts = new Map<string, number>();
    const calls: Array<Record<string, any>> = [];
    return {
      calls,
      client: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        send: async (command: any) => {
          calls.push(command.input);
          const key = command.input.Key.sk.S as string;
          counts.set(key, (counts.get(key) ?? 0) + Number(command.input.ExpressionAttributeValues[':by'].N));
          return { Attributes: { n: { N: String(counts.get(key)) } } };
        },
      } as never,
    };
  }
  const NOW = Date.parse('2026-10-13T12:00:00Z');

  it('counts day keys in DynamoDB with an atomic ADD and a TTL, and minute keys in memory', async () => {
    const dynamo = fakeDynamo();
    const store = new SharedDayCounter({ tableName: 'citydesk-user-requests', client: dynamo.client, now: () => NOW });
    expect(await store.increment('ip:203.0.113.7:1', 120)).toBe(1);
    expect(await store.increment('ip:203.0.113.7:1', 120)).toBe(2);
    expect(dynamo.calls).toHaveLength(0);

    expect(await store.increment('day:2026-10-13', 172_800)).toBe(1);
    expect(await store.increment('day:2026-10-13', 172_800)).toBe(2);
    expect(dynamo.calls[0]).toMatchObject({
      TableName: 'citydesk-user-requests',
      Key: { pk: { S: 'COUNTER' }, sk: { S: 'client-api#day:2026-10-13' } },
      UpdateExpression: 'ADD #n :by SET #ttl = if_not_exists(#ttl, :ttl)',
      ReturnValues: 'UPDATED_NEW',
    });
    expect(dynamo.calls[0]!.ExpressionAttributeValues[':ttl']).toEqual({ N: String(Math.floor(NOW / 1000) + 172_800) });
  });

  it('enforces the daily cap across two instances sharing the table', async () => {
    const dynamo = fakeDynamo();
    const settings = { perMinute: 100, dailyCap: 3 };
    const a = createLimiter(new SharedDayCounter({ tableName: 't', client: dynamo.client, now: () => NOW }), () => NOW);
    const b = createLimiter(new SharedDayCounter({ tableName: 't', client: dynamo.client, now: () => NOW }), () => NOW);
    const results = [];
    for (const limiter of [a, b, a, b]) results.push(await limiter.check({ ip: '203.0.113.7', metered: true }, settings));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(results[3]).toMatchObject({ code: 'daily_cap_reached', status: 429 });
  });

  it('fails closed when DynamoDB cannot be reached', async () => {
    const store = new SharedDayCounter({
      tableName: 't',
      client: { send: async () => { throw new Error('timeout'); } } as never,
    });
    const decision = await createLimiter(store).check({ ip: '203.0.113.7', metered: true }, { perMinute: 100, dailyCap: 10 });
    expect(decision).toMatchObject({ ok: false, status: 503, code: 'limits_unavailable' });
  });
});
