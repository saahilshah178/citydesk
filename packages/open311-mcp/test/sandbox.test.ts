import { describe, expect, it } from 'vitest';
import { BOSTON, Open311Client, createSandbox, sandboxEndpoint, type CityConfig } from '../src/index.ts';
import { fakeTime } from './helpers.ts';

function setup(lifecycle?: { assignAfterMs: number; closeAfterMs: number } | false) {
  const time = fakeTime();
  let n = 100;
  const sandbox = createSandbox({ now: time.now, lifecycle, generateId: () => `SB-${n++}` });
  const city: CityConfig = { ...BOSTON, test: sandboxEndpoint(sandbox) };
  const client = new Open311Client(city, { env: {}, now: time.now, sleep: time.sleep, limiters: new Map() });
  return { sandbox, client, time };
}

describe('built-in Open311 sandbox, driven through the real client', () => {
  it('lists services and a definition with a required attribute', async () => {
    const { client } = setup();
    const services = await client.listServices('test');
    expect(services.map((s) => s.service_name)).toEqual(expect.arrayContaining(['Pothole', 'Street Light Outage']));
    const light = services.find((s) => s.service_name === 'Street Light Outage')!;
    expect(light.metadata).toBe(true);
    const def = await client.getServiceDefinition(light.service_code, 'test');
    expect(def?.attributes[0]).toMatchObject({ code: 'light_condition', required: true });
    expect(await client.getServiceDefinition('nope', 'test')).toBeUndefined();
  });

  it('creates a request, reads it back, and finds it by area', async () => {
    const { client } = setup();
    const created = await client.createRequest({
      serviceCode: 'sandbox-pothole',
      lat: 42.3493,
      long: -71.0782,
      addressString: '700 Boylston St, Boston, MA 02116',
      description: 'Large pothole by the library',
    });
    expect(created.service_request_id).toBe('SB-100');
    expect(created.service_notice).toMatch(/Nothing was sent to a real city/);

    const read = await client.getRequest('SB-100', 'test');
    expect(read).toMatchObject({
      service_request_id: 'SB-100',
      status: 'open',
      service_name: 'Pothole',
      address: '700 Boylston St, Boston, MA 02116',
      lat: 42.3493,
    });
    expect(await client.getRequestIdFromToken(created.token!, 'test')).toBe('SB-100');
    expect(await client.getRequest('SB-999', 'test')).toBeUndefined();

    const near = await client.searchRequests(
      { serviceCode: 'sandbox-pothole', status: 'open', near: { lat: 42.3494, long: -71.0783, radiusMeters: 50 } },
      'test',
    );
    expect(near.map((r) => r.service_request_id)).toEqual(['SB-100']);
    const far = await client.searchRequests({ near: { lat: 42.36, long: -71.06, radiusMeters: 50 } }, 'test');
    expect(far).toHaveLength(0);
  });

  it('enforces required attributes and valid values like a real server', async () => {
    const { client } = setup();
    const base = { serviceCode: 'sandbox-streetlight', lat: 42.35, long: -71.07 };
    await expect(client.createRequest(base)).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('light_condition'),
    });
    await expect(client.createRequest({ ...base, attributes: { light_condition: 'purple' } })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    const ok = await client.createRequest({ ...base, attributes: { light_condition: 'out' } });
    expect(ok.service_request_id).toBe('SB-100');
    await expect(client.createRequest({ serviceCode: 'unknown', lat: 1, long: 1 })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('moves a request through its simulated lifecycle as it ages, and says it is simulated', async () => {
    const { client, time } = setup({ assignAfterMs: 60_000, closeAfterMs: 3_600_000 });
    await client.createRequest({ serviceCode: 'sandbox-pothole', lat: 42.35, long: -71.07 });

    const fresh = await client.getRequest('SB-100', 'test');
    expect(fresh).toMatchObject({ status: 'open' });
    expect(fresh?.status_notes).toMatch(/Received/);

    time.advance(61_000);
    const assigned = await client.getRequest('SB-100', 'test');
    expect(assigned?.status).toBe('open');
    expect(assigned?.status_notes).toMatch(/Assigned to a Public Works crew\. \(Simulated/);
    expect(assigned!.updated_datetime! > fresh!.updated_datetime!).toBe(true);

    time.advance(3_600_000);
    const closed = await client.getRequest('SB-100', 'test');
    expect(closed?.status).toBe('closed');
    expect(closed?.status_notes).toMatch(/Simulated/);
    expect(await client.searchRequests({ status: 'open' }, 'test')).toHaveLength(0);
    expect(await client.searchRequests({ status: 'closed' }, 'test')).toHaveLength(1);
  });

  it('keeps requests open forever when the lifecycle is off', async () => {
    const { client, time } = setup(false);
    await client.createRequest({ serviceCode: 'sandbox-pothole', lat: 42.35, long: -71.07 });
    time.advance(365 * 86_400_000);
    expect((await client.getRequest('SB-100', 'test'))?.status).toBe('open');
  });

  it('answers with Open311 error bodies for bad paths and methods', async () => {
    const { sandbox } = setup();
    const res = await sandbox.fetch(new Request('http://x/open311/v2/requests.json', { method: 'DELETE' }));
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual([{ code: 405, description: expect.any(String) }]);
    expect((await sandbox.fetch(new Request('http://x/elsewhere'))).status).toBe(404);
    const disc = await sandbox.fetch(new Request('http://x/open311/v2/discovery.json'));
    expect(((await disc.json()) as { endpoints: Array<{ type: string }> }).endpoints[0]!.type).toBe('test');
  });
});

describe('sandbox reads stay small', () => {
  it('asks the store only for what a query can match', async () => {
    const time = fakeTime();
    const asked: Array<{ since?: number; limit?: number }> = [];
    const records = new Map<string, import('../src/index.ts').SandboxRequestRecord>();
    const HOUR = 3_600_000;
    const sandbox = createSandbox({
      now: time.now,
      lifecycle: { assignAfterMs: 60_000, closeAfterMs: 20 * HOUR },
      store: {
        put: async (r) => void records.set(r.service_request_id, r),
        get: async (id) => records.get(id),
        list: async (options = {}) => {
          asked.push(options);
          return [...records.values()].filter((r) => r.requested_at >= (options.since ?? 0)).sort((a, b) => b.requested_at - a.requested_at).slice(0, options.limit);
        },
      },
    });
    for (let i = 0; i < 40; i++) {
      records.set(`SB-${i}`, { service_request_id: `SB-${i}`, token: `t${i}`, service_code: 'sandbox-pothole', service_name: 'Pothole', lat: 42.35, long: -71.07, requested_at: time.now() - i * HOUR });
    }
    const get = async (query: string): Promise<Array<{ service_request_id: string }>> =>
      (await sandbox.fetch(new Request(`http://x/open311/v2/requests.json?${query}`))).json() as Promise<Array<{ service_request_id: string }>>;

    // Open requests cannot be older than the lifecycle's closing age, so nothing older is read.
    const open = await get('status=open&service_code=sandbox-pothole&start_date=2026-09-13T12:00:00Z');
    expect(open).toHaveLength(20);
    expect(asked.at(-1)!.since).toBe(time.now() - 20 * HOUR);

    // A plain listing reads one page.
    await get('per_page=10');
    expect(asked.at(-1)).toMatchObject({ limit: 10 });

    // Deep paging is capped rather than turned into a huge read.
    await get('per_page=300&page=100000');
    expect(asked.at(-1)!.limit).toBeLessThanOrEqual(900);

    // Lookups by ID never list.
    const before = asked.length;
    expect((await get('service_request_id=SB-3,SB-39,missing')).map((r) => r.service_request_id).sort()).toEqual(['SB-3', 'SB-39']);
    expect(asked).toHaveLength(before);
  });
});
