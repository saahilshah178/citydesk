/**
 * Duplicate detection: is there already an open request of the same type close to this spot?
 *
 * The rule is deliberately simple and explainable: same service type, still open, filed within the
 * recent window, and within `radiusMeters` (50 m by default) of the reported location.
 */
import { haversineMeters, type ServiceRequest } from 'open311-mcp';

export interface DedupeOptions {
  radiusMeters: number;
  windowDays: number;
  /** Epoch milliseconds of "now". Requests filed after this are ignored. */
  now: number;
  /** Most matches to return. Default 3. */
  max?: number;
}

export interface DuplicateMatch {
  request: ServiceRequest;
  distanceMeters: number;
}

const DAY_MS = 86_400_000;

/**
 * Returns the open requests that would make a new report at `at` a duplicate, nearest first.
 * `candidates` must already be limited to the same service type as the new report.
 */
export function findDuplicates(
  candidates: readonly ServiceRequest[],
  at: { lat: number; long: number },
  opts: DedupeOptions,
): DuplicateMatch[] {
  const earliest = opts.now - opts.windowDays * DAY_MS;
  const matches: DuplicateMatch[] = [];
  for (const request of candidates) {
    if (request.status !== 'open') continue;
    if (request.lat === undefined || request.long === undefined) continue;
    const filed = Date.parse(request.requested_datetime);
    if (Number.isNaN(filed) || filed < earliest || filed > opts.now) continue;
    const distanceMeters = haversineMeters(at.lat, at.long, request.lat, request.long);
    if (distanceMeters <= opts.radiusMeters) matches.push({ request, distanceMeters });
  }
  matches.sort(
    (a, b) => a.distanceMeters - b.distanceMeters || b.request.requested_datetime.localeCompare(a.request.requested_datetime),
  );
  return matches.slice(0, opts.max ?? 3);
}

/**
 * Whether a request was still open at time `t`, judged from what the city reports today: it is open
 * now, or it is closed and its last update (the closing) came after `t`. Used by the historical replay.
 */
export function wasOpenAt(request: ServiceRequest, t: number): boolean {
  const filed = Date.parse(request.requested_datetime);
  if (Number.isNaN(filed) || filed > t) return false;
  if (request.status === 'open') return true;
  const updated = request.updated_datetime ? Date.parse(request.updated_datetime) : NaN;
  return Number.isNaN(updated) ? false : updated > t;
}
