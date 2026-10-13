import { describe, expect, it } from 'vitest';
import { BOSTON, NEW_HAVEN, Open311Client, Open311Error, RateLimiter, type CityConfig } from '../src/index.ts';
import { fakeFetch, fakeTime, fixture, fixtureJson, jsonResponse, type Route } from './helpers.ts';

const BOSTON_BASE = 'https://311.boston.gov/open311/v2';

function client(city: CityConfig, routes: Route[], env: Record<string, string | undefined> = {}) {
  const net = fakeFetch(...routes);
  const time = fakeTime();
  const c = new Open311Client(city, {
    fetch: net.fetch,
    env,
    now: time.now,
    sleep: time.sleep,
    limiters: new Map<string, RateLimiter>(),
  });
  return { c, ...net, time };
}

/** Boston with an 8-row page size so the two recorded pages exercise paging. */
const bostonSmallPages: CityConfig = { ...BOSTON, production: { ...BOSTON.production!, pageSize: 8 } };

describe('services', () => {
  it('lists the fileable services from the recorded Boston response', async () => {
    const { c, calls } = client(BOSTON, [
      (call) => (call.url.pathname.endsWith('/services.json') ? jsonResponse(fixture('boston/services.json')) : undefined),
    ]);
    const services = await c.listServices();
    expect(services).toHaveLength(6);
    expect(services.map((s) => s.service_name)).toContain('Rodent Sighting');
    expect(services.find((s) => s.service_name === 'Other')?.metadata).toBe(false);
    expect(calls[0]!.url.href).toBe(`${BOSTON_BASE}/services.json`);
    expect(calls[0]!.headers.get('user-agent')).toMatch(/open311-mcp/);
  });

  it('adds the API key when the configured environment variable is set', async () => {
    const { c, calls } = client(
      BOSTON,
      [() => jsonResponse(fixture('boston/services.json'))],
      { BOSTON_OPEN311_API_KEY: 'k-123' },
    );
    await c.listServices();
    expect(calls[0]!.url.searchParams.get('api_key')).toBe('k-123');
  });

  it('sends the reference point to servers that scope by location (SeeClickFix)', async () => {
    const { c, calls } = client(NEW_HAVEN, [() => jsonResponse(fixture('seeclickfix/services.json'))]);
    const services = await c.listServices('test');
    expect(calls[0]!.url.host).toBe('test.seeclickfix.com');
    expect(calls[0]!.url.searchParams.get('lat')).toBe('41.3083');
    expect(calls[0]!.url.searchParams.get('long')).toBe('-72.9279');
    // SeeClickFix codes are numbers on the wire; the client always hands back strings.
    expect(services.find((s) => s.service_name === 'Street Light')?.service_code).toBe('10639');
    expect(services.find((s) => s.service_name === 'Street Light')?.organization).toBeTruthy();
  });

  it('returns a service definition with ordered attributes', async () => {
    const { c, calls } = client(BOSTON, [() => jsonResponse(fixture('boston/service_definition.json'))]);
    const def = await c.getServiceDefinition('8638e79a-2a0a-4d3a-9624-792ec40b0691');
    expect(def?.attributes).toHaveLength(4);
    expect(def?.attributes[0]).toMatchObject({ required: true, datatype: 'singlevaluelist' });
    expect(def?.attributes[0]?.values.map((v) => v.name)).toEqual(['Yes', 'No']);
    expect(calls[0]!.url.pathname).toBe('/open311/v2/services/8638e79a-2a0a-4d3a-9624-792ec40b0691.json');
  });

  it('percent-encodes service codes with spaces, colons and ampersands', async () => {
    const { c, calls } = client(BOSTON, [() => jsonResponse({ service_code: 'x', attributes: [] })]);
    await c.getServiceDefinition('Transportation - Traffic Division:Enforcement & Abandoned Vehicles:Abandoned Vehicles');
    expect(calls[0]!.url.href).toContain('Enforcement%20%26%20Abandoned%20Vehicles%3AAbandoned%20Vehicles.json');
  });

  it('treats an unknown service code (JSON 404) and an HTML 404 page as "no definition"', async () => {
    const json404 = client(BOSTON, [() => jsonResponse(fixture('boston/error_invalid_service.json'), 404)]);
    expect(await json404.c.getServiceDefinition('acb41f11-e581-42bc-a0a5-877cb3a07747')).toBeUndefined();

    const html404 = client(BOSTON, [
      () => new Response(fixture('boston/not_found.html'), { status: 404, headers: { 'content-type': 'text/html' } }),
    ]);
    expect(await html404.c.getServiceDefinition('input.Rodent Sighting')).toBeUndefined();
  });
});

describe('request search', () => {
  const pages: Route = (call) => {
    if (!call.url.pathname.endsWith('/requests.json')) return undefined;
    const page = call.url.searchParams.get('page') ?? '1';
    if (page === '1') return jsonResponse(fixture('boston/requests_page1.json'));
    if (page === '2') return jsonResponse(fixture('boston/requests_page2.json'));
    return jsonResponse([]);
  };

  it('pages until the server runs out and returns newest first', async () => {
    const { c, calls } = client(bostonSmallPages, [pages]);
    const requests = await c.searchRequests();
    expect(requests).toHaveLength(16);
    expect(calls.map((x) => x.url.searchParams.get('page'))).toEqual([null, '2', '3']);
    expect(calls[0]!.url.searchParams.get('per_page')).toBe('8');
    const dates = requests.map((r) => r.requested_datetime);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(requests[0]).toMatchObject({ status: expect.stringMatching(/open|closed/) });
    expect(typeof requests[0]!.lat).toBe('number');
  });

  it('stops at the limit without fetching more pages than needed', async () => {
    const { c, calls } = client(bostonSmallPages, [pages]);
    const requests = await c.searchRequests({ limit: 5 });
    expect(requests).toHaveLength(5);
    expect(calls).toHaveLength(1);
  });

  it('passes service code, status and W3C dates to the server', async () => {
    const { c, calls } = client(BOSTON, [() => jsonResponse(fixture('boston/potholes_open.json'))]);
    await c.searchRequests({
      serviceCode: '9aaa7721-e212-4d16-a77e-d8f8d2f4ba28',
      status: 'open',
      startDate: new Date('2026-09-13T00:00:00.000Z'),
      endDate: new Date('2026-10-13T12:00:00.000Z'),
    });
    const q = calls[0]!.url.searchParams;
    expect(q.get('service_code')).toBe('9aaa7721-e212-4d16-a77e-d8f8d2f4ba28');
    expect(q.get('status')).toBe('open');
    expect(q.get('start_date')).toBe('2026-09-13T00:00:00Z');
    expect(q.get('end_date')).toBe('2026-10-13T12:00:00Z');
  });

  it('applies the bounding box in the client, since Boston ignores spatial parameters', async () => {
    const all = fixtureJson<Array<{ lat: number; long: number }>>('boston/potholes_open.json');
    const { c, calls } = client(BOSTON, [() => jsonResponse(fixture('boston/potholes_open.json'))]);
    // East Boston only.
    const bbox = [-71.05, 42.36, -70.99, 42.4] as const;
    const inBox = await c.searchRequests({ bbox });
    const expected = all.filter((r) => r.long >= bbox[0] && r.long <= bbox[2] && r.lat >= bbox[1] && r.lat <= bbox[3]);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(all.length);
    expect(inBox).toHaveLength(expected.length);
    expect(calls[0]!.url.searchParams.has('lat')).toBe(false);
    expect(calls[0]!.url.searchParams.has('bbox')).toBe(false);
  });

  it('finds requests within a radius of a point, nearest first', async () => {
    const { c } = client(BOSTON, [() => jsonResponse(fixture('boston/potholes_open.json'))]);
    // 1079-1089 Commonwealth Ave, the first recorded pothole.
    const near = { lat: 42.3525, long: -71.125, radiusMeters: 50 };
    const hits = await c.searchRequests({ near });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.address).toBe('1079-1089 Commonwealth Ave, Boston, MA 02215');
    expect(await c.searchRequests({ near: { ...near, radiusMeters: 1 } })).toHaveLength(0);
  });

  it('splits a date range longer than 90 days into windows the server accepts', async () => {
    const { c, calls } = client(BOSTON, [() => jsonResponse([])]);
    await c.searchRequests({
      startDate: new Date('2026-04-01T00:00:00Z'),
      endDate: new Date('2026-10-01T00:00:00Z'),
    });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      const span = Date.parse(call.url.searchParams.get('end_date')!) - Date.parse(call.url.searchParams.get('start_date')!);
      expect(span).toBeLessThanOrEqual(90 * 86_400_000);
    }
    expect(calls[0]!.url.searchParams.get('end_date')).toBe('2026-10-01T00:00:00Z');
    expect(calls.at(-1)!.url.searchParams.get('start_date')).toBe('2026-04-01T00:00:00Z');
  });

  it('normalizes SeeClickFix rows: numeric IDs become strings, offsets become UTC', async () => {
    const { c, calls } = client(NEW_HAVEN, [
      (call) => (call.url.searchParams.get('page') ? jsonResponse([]) : jsonResponse(fixture('seeclickfix/requests.json'))),
    ]);
    const requests = await c.searchRequests({}, 'test');
    expect(requests).toHaveLength(8);
    expect(requests[0]!.service_request_id).toMatch(/^\d+$/);
    expect(requests[0]!.requested_datetime).toMatch(/Z$/);
    expect(calls[0]!.url.searchParams.get('lat')).toBe('41.3083');
  });
});

describe('single request lookup', () => {
  it('returns the request', async () => {
    const { c, calls } = client(BOSTON, [() => jsonResponse(fixture('boston/request_single.json'))]);
    const expected = fixtureJson<Array<{ service_request_id: string }>>('boston/request_single.json')[0]!;
    const request = await c.getRequest(expected.service_request_id);
    expect(request?.service_request_id).toBe(expected.service_request_id);
    expect(calls[0]!.url.pathname).toBe(`/open311/v2/requests/${expected.service_request_id}.json`);
  });

  it('looks up several IDs in one call and ignores rows it did not ask for', async () => {
    const page = fixtureJson<Array<{ service_request_id: string }>>('boston/requests_page1.json');
    const wanted = [page[0]!.service_request_id, page[1]!.service_request_id, 'missing-id'];
    const { c, calls } = client(BOSTON, [() => jsonResponse(fixture('boston/requests_page1.json'))]);
    const found = await c.getRequests(wanted);
    expect(found.map((r) => r.service_request_id).sort()).toEqual(wanted.slice(0, 2).sort());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get('service_request_id')).toBe(wanted.join(','));
  });

  it('returns undefined for an unknown ID', async () => {
    const { c } = client(BOSTON, [
      () => jsonResponse([{ code: 404, description: 'Service request not found with id or token 0000' }], 404),
    ]);
    expect(await c.getRequest('0000')).toBeUndefined();
  });
});

describe('rate limiting and retries', () => {
  it('waits once the per-minute budget is used up', async () => {
    const city: CityConfig = { ...BOSTON, production: { ...BOSTON.production!, rateLimitPerMinute: 3 } };
    const { c, time, calls } = client(city, [() => jsonResponse([])]);
    for (let i = 0; i < 4; i++) await c.listServices();
    expect(calls).toHaveLength(4);
    // Three calls went straight through; the fourth waited for the window to slide.
    expect(time.sleeps).toEqual([60_000]);
  });

  it('fails fast with rate_limited instead of waiting when the caller sets a wait budget', async () => {
    const city: CityConfig = { ...BOSTON, production: { ...BOSTON.production!, rateLimitPerMinute: 2 } };
    const net = fakeFetch(() => jsonResponse([]));
    const time = fakeTime();
    const c = new Open311Client(city, { fetch: net.fetch, env: {}, now: time.now, sleep: time.sleep, limiters: new Map(), maxRateLimitWaitMs: 2000 });
    await c.listServices();
    await c.listServices();
    const err = await c.listServices().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'rate_limited', retryable: true });
    expect((err as Open311Error).details).toMatchObject({ retry_after_ms: 60_000 });
    expect(net.calls).toHaveLength(2);
    expect(time.sleeps).toEqual([]);
  });

  it('retries a GET after a 503 and after a network failure', async () => {
    let n = 0;
    const { c, calls, time } = client(BOSTON, [
      () => {
        n++;
        if (n === 1) return jsonResponse('upstream down', 503);
        if (n === 2) throw new TypeError('fetch failed');
        return jsonResponse(fixture('boston/services.json'));
      },
    ]);
    expect(await c.listServices()).toHaveLength(6);
    expect(calls).toHaveLength(3);
    expect(time.sleeps).toEqual([500, 1500]);
  });

  it('honors Retry-After on 429 and reports rate_limited when retries run out', async () => {
    const { c, calls, time } = client(BOSTON, [() => jsonResponse('slow down', 429, { 'retry-after': '2' })]);
    const err = await c.listServices().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Open311Error);
    expect(err).toMatchObject({ code: 'rate_limited', status: 429, retryable: true });
    expect(calls).toHaveLength(3);
    expect(time.sleeps).toEqual([2000, 2000]);
  });

  it('reports upstream_unavailable when the host cannot be reached', async () => {
    const { c } = client(BOSTON, [
      () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
      },
    ]);
    const err = await c.listServices('test').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'upstream_unavailable', retryable: true });
    expect((err as Error).message).toContain('ENOTFOUND');
  });

  it('reports bad_response for a 200 that is not JSON', async () => {
    const { c } = client(BOSTON, [() => new Response('<html></html>', { status: 200 })]);
    await expect(c.listServices()).rejects.toMatchObject({ code: 'bad_response', retryable: false });
  });
});
