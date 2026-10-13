import { describe, expect, it } from 'vitest';
import {
  BOSTON,
  NEW_HAVEN,
  Open311Client,
  RateLimiter,
  WriteBlockedError,
  assertWriteAllowed,
  parseCities,
  productionWritesAllowed,
  type CityConfig,
} from '../src/index.ts';
import { fakeFetch, jsonResponse } from './helpers.ts';

const input = { serviceCode: '10407', lat: 41.3083, long: -72.9279, description: 'Pothole' };

function client(city: CityConfig, env: Record<string, string | undefined>) {
  const net = fakeFetch(() => jsonResponse([{ service_request_id: 1346400, token: null, service_notice: 'ok' }], 201));
  return { c: new Open311Client(city, { fetch: net.fetch, env, limiters: new Map<string, RateLimiter>() }), calls: net.calls };
}

describe('write guard', () => {
  it('blocks a production write before any network call', async () => {
    const { c, calls } = client(BOSTON, {});
    await expect(c.createRequest(input, 'production')).rejects.toBeInstanceOf(WriteBlockedError);
    await expect(c.createRequest(input, 'production')).rejects.toMatchObject({ code: 'write_blocked', retryable: false });
    expect(calls).toHaveLength(0);
  });

  it('allows the test endpoint and posts GeoReport form fields', async () => {
    const { c, calls } = client(NEW_HAVEN, { SEECLICKFIX_API_KEY: 'scf-key' });
    const result = await c.createRequest({
      ...input,
      addressString: '165 Church St, New Haven, CT',
      attributes: { '10188': '2', '10189': ['1', '3'] },
    });
    expect(result.service_request_id).toBe('1346400');
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url.href).toBe('https://test.seeclickfix.com/open311/v2/requests.json');
    expect(call.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(call.body);
    expect(form.get('service_code')).toBe('10407');
    expect(form.get('lat')).toBe('41.3083');
    expect(form.get('address_string')).toBe('165 Church St, New Haven, CT');
    expect(form.get('attribute[10188]')).toBe('2');
    expect(form.getAll('attribute[10189][]')).toEqual(['1', '3']);
    // The key travels in the form body, never in the URL of a write.
    expect(form.get('api_key')).toBe('scf-key');
    expect(call.url.search).toBe('');
  });

  it('defaults to the test endpoint', async () => {
    const { c, calls } = client(NEW_HAVEN, {});
    await c.createRequest(input);
    expect(calls[0]!.url.host).toBe('test.seeclickfix.com');
  });

  it('only the exact string "true" opens production', async () => {
    for (const value of ['TRUE', '1', 'yes', ' true', '']) {
      expect(productionWritesAllowed({ ALLOW_PRODUCTION_WRITES: value })).toBe(false);
      const { c, calls } = client(BOSTON, { ALLOW_PRODUCTION_WRITES: value });
      await expect(c.createRequest(input, 'production')).rejects.toBeInstanceOf(WriteBlockedError);
      expect(calls).toHaveLength(0);
    }
    const { c, calls } = client(BOSTON, { ALLOW_PRODUCTION_WRITES: 'true' });
    await c.createRequest(input, 'production');
    expect(calls[0]!.url.host).toBe('311.boston.gov');
  });

  it('refuses a "test" endpoint that points at the production server', () => {
    const miswired: CityConfig = {
      ...BOSTON,
      test: { ...BOSTON.production!, id: 'boston-test', kind: 'test', baseUrl: 'https://311.boston.gov/open311/v2/' },
    };
    expect(() => assertWriteAllowed(miswired, miswired.test!, {})).toThrow(/production server/);
  });

  it('never retries a POST after a network failure, so a request cannot be filed twice', async () => {
    let attempts = 0;
    const net = fakeFetch(() => {
      attempts++;
      throw new TypeError('socket hang up');
    });
    const c = new Open311Client(NEW_HAVEN, { fetch: net.fetch, env: {}, sleep: async () => {}, limiters: new Map() });
    await expect(c.createRequest(input)).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(attempts).toBe(1);
  });

  it('rejects a create with no location or no service code before calling the server', async () => {
    const { c, calls } = client(NEW_HAVEN, {});
    await expect(c.createRequest({ serviceCode: '10407' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(c.createRequest({ serviceCode: '', lat: 1, long: 1 })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(calls).toHaveLength(0);
  });
});

describe('city config', () => {
  it('accepts a two-city config', () => {
    const cities = parseCities([JSON.parse(JSON.stringify(BOSTON)), JSON.parse(JSON.stringify(NEW_HAVEN))]);
    expect(Object.keys(cities)).toEqual(['boston', 'new-haven']);
  });

  it('rejects a test endpoint on the production server, bad boxes, and duplicate IDs', () => {
    const base = JSON.parse(JSON.stringify(NEW_HAVEN)) as CityConfig;
    expect(() => parseCities({ ...base, test: { ...base.test, baseUrl: base.production!.baseUrl } })).toThrow(/production/);
    expect(() => parseCities({ ...base, bbox: [-72, 41.3, -73, 41.2] })).toThrow(/bbox/);
    expect(() => parseCities([base, { ...base, id: 'other' }])).toThrow(/duplicate endpoint id/);
    expect(() => parseCities({ ...base, production: undefined, test: undefined })).toThrow(/at least one endpoint/);
  });
});
