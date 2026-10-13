import { describe, expect, it } from 'vitest';
import { normalizeRequest, type ServiceRequest } from 'open311-mcp';
import { fixtureJson } from '../../../packages/open311-mcp/test/helpers.ts';
import { findDuplicates, wasOpenAt } from '../src/dedupe.ts';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const DAY = 86_400_000;
const HERE = { lat: 42.3493, long: -71.0782 };
/** Degrees of latitude for a distance in meters. */
const north = (meters: number): number => meters / 111_195;

function req(over: Partial<ServiceRequest> & { id: string }): ServiceRequest {
  const { id, ...rest } = over;
  return {
    service_request_id: id,
    status: 'open',
    service_code: 'pothole',
    service_name: 'Pothole',
    requested_datetime: new Date(NOW - DAY).toISOString(),
    lat: HERE.lat,
    long: HERE.long,
    ...rest,
  };
}

const opts = { radiusMeters: 50, windowDays: 30, now: NOW };

describe('findDuplicates', () => {
  it('matches an open request inside the radius and rejects one just outside it', () => {
    const inside = req({ id: 'inside', lat: HERE.lat + north(49) });
    const outside = req({ id: 'outside', lat: HERE.lat + north(51) });
    const hits = findDuplicates([outside, inside], HERE, opts);
    expect(hits.map((h) => h.request.service_request_id)).toEqual(['inside']);
    expect(hits[0]!.distanceMeters).toBeGreaterThan(48);
    expect(hits[0]!.distanceMeters).toBeLessThan(50);
  });

  it('ignores closed requests', () => {
    expect(findDuplicates([req({ id: 'closed', status: 'closed' })], HERE, opts)).toEqual([]);
  });

  it('ignores requests older than the window, and requests from the future', () => {
    const old = req({ id: 'old', requested_datetime: new Date(NOW - 31 * DAY).toISOString() });
    const edge = req({ id: 'edge', requested_datetime: new Date(NOW - 29 * DAY).toISOString() });
    const future = req({ id: 'future', requested_datetime: new Date(NOW + 60_000).toISOString() });
    expect(findDuplicates([old, edge, future], HERE, opts).map((h) => h.request.service_request_id)).toEqual(['edge']);
  });

  it('ignores requests with no coordinates or an unreadable date', () => {
    const noPoint = req({ id: 'no-point', lat: undefined, long: undefined });
    const badDate = req({ id: 'bad-date', requested_datetime: 'not a date' });
    expect(findDuplicates([noPoint, badDate], HERE, opts)).toEqual([]);
  });

  it('orders by distance, then by recency, and caps the list', () => {
    const far = req({ id: 'far', lat: HERE.lat + north(40) });
    const near = req({ id: 'near', lat: HERE.lat + north(5) });
    const sameSpotOld = req({ id: 'same-old', requested_datetime: new Date(NOW - 5 * DAY).toISOString() });
    const sameSpotNew = req({ id: 'same-new', requested_datetime: new Date(NOW - 1 * DAY).toISOString() });
    const all = [far, near, sameSpotOld, sameSpotNew];
    expect(findDuplicates(all, HERE, { ...opts, max: 10 }).map((h) => h.request.service_request_id)).toEqual([
      'same-new',
      'same-old',
      'near',
      'far',
    ]);
    expect(findDuplicates(all, HERE, opts)).toHaveLength(3);
    expect(findDuplicates(all, HERE, { ...opts, max: 1 })).toHaveLength(1);
  });

  it('honors a configurable radius', () => {
    const at80 = req({ id: 'at-80', lat: HERE.lat + north(80) });
    expect(findDuplicates([at80], HERE, opts)).toHaveLength(0);
    expect(findDuplicates([at80], HERE, { ...opts, radiusMeters: 100 })).toHaveLength(1);
  });

  it('finds the recorded Boston pothole from a point across the street, and nothing from a mile away', () => {
    const potholes = fixtureJson<unknown[]>('boston/potholes_open.json')
      .map(normalizeRequest)
      .filter((r): r is ServiceRequest => r !== undefined);
    // Address point of 1079 Commonwealth Ave from Boston's address records.
    const hits = findDuplicates(potholes, { lat: 42.352524, long: -71.124523 }, opts);
    expect(hits[0]!.request.address).toBe('1079-1089 Commonwealth Ave, Boston, MA 02215');
    expect(Math.round(hits[0]!.distanceMeters)).toBe(36);
    expect(findDuplicates(potholes, { lat: 42.3665, long: -71.106 }, opts)).toEqual([]);
  });
});

describe('wasOpenAt (used by the historical replay)', () => {
  const filed = NOW - 10 * DAY;
  const closed = NOW - 4 * DAY;
  const base = { requested_datetime: new Date(filed).toISOString() };

  it('an open request was open at any time after it was filed', () => {
    const r = req({ id: 'a', ...base });
    expect(wasOpenAt(r, filed + 1)).toBe(true);
    expect(wasOpenAt(r, NOW)).toBe(true);
    expect(wasOpenAt(r, filed - 1)).toBe(false);
  });

  it('a closed request was open until its last update', () => {
    const r = req({ id: 'b', ...base, status: 'closed', updated_datetime: new Date(closed).toISOString() });
    expect(wasOpenAt(r, closed - 1)).toBe(true);
    expect(wasOpenAt(r, closed + 1)).toBe(false);
  });

  it('a closed request with no update time is never assumed open', () => {
    expect(wasOpenAt(req({ id: 'c', ...base, status: 'closed' }), filed + DAY)).toBe(false);
  });
});
