/**
 * Replays real Boston 311 requests in time order and measures how often a new request already had
 * an open request of the same type nearby, which is the case CityDesk's duplicate check catches.
 *
 *   pnpm replay:dupes                  # replay the last 30 days
 *   pnpm replay:dupes -- --days 14     # a shorter replay
 *
 * Method. Requests are fetched from Boston's public Open311 API one day at a time and cached under
 * .citydesk/replay/. They are then walked in the order they were filed. For each request R we ask
 * the same question report_issue asks: is there a request of the same service type, still open at
 * the moment R was filed, filed within the window before R, and within the radius of R? "Open at
 * that moment" is judged from today's data: the earlier request is open now, or it was closed after
 * R was filed (see wasOpenAt in apps/citydesk/src/dedupe.ts).
 *
 * Writes results/dupes.json. Every number in it comes from this run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BOSTON, Open311Client, Open311Error, haversineMeters, type CityConfig, type ServiceRequest } from 'open311-mcp';
import { wasOpenAt } from '../apps/citydesk/src/dedupe.ts';
import { loadEnv, USER_AGENT } from './lib/env.ts';

loadEnv();

const { values } = parseArgs({
  options: {
    days: { type: 'string', default: '30' },
    radius: { type: 'string', default: '50' },
    window: { type: 'string', default: '30' },
    'per-minute': { type: 'string' },
    refresh: { type: 'boolean', default: false },
  },
});

const DAY_MS = 86_400_000;
const replayDays = Number(values.days);
const radiusM = Number(values.radius);
const windowDays = Number(values.window);
const root = resolve(import.meta.dirname, '..');
const cacheDir = resolve(root, '.citydesk', 'replay');
mkdirSync(cacheDir, { recursive: true });

// Stay under the keyless limit (about 10 a minute) and leave room for the dev server.
const perMinute = Number(values['per-minute'] ?? (process.env.BOSTON_OPEN311_API_KEY ? 30 : 6));
const city: CityConfig = { ...BOSTON, production: { ...BOSTON.production!, rateLimitPerMinute: perMinute } };
const client = new Open311Client(city, { userAgent: USER_AGENT, limiters: new Map(), maxRetries: 3, timeoutMs: 60_000 });

const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
// Whole UTC days, ending with yesterday so every day in the replay is complete.
const endDay = Math.floor(Date.now() / DAY_MS) * DAY_MS;
const replayStart = endDay - replayDays * DAY_MS;
const fetchStart = replayStart - windowDays * DAY_MS;

async function loadDay(dayStart: number): Promise<ServiceRequest[]> {
  const file = resolve(cacheDir, `${ymd(dayStart)}.json`);
  if (!values.refresh && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as ServiceRequest[];
  daysDownloaded++;
  let rows: ServiceRequest[] | undefined;
  for (let attempt = 1; rows === undefined; attempt++) {
    try {
      rows = await client.searchRequests({
        startDate: new Date(dayStart),
        endDate: new Date(dayStart + DAY_MS - 1000),
        limit: 20_000,
        maxPages: 40,
      });
    } catch (err) {
      // The city asked us to slow down: wait a few minutes and try the same day again.
      if (!(err instanceof Open311Error) || !err.retryable || attempt >= 5) throw err;
      console.error(`[replay] ${ymd(dayStart)}: ${err.code}, waiting ${attempt * 3} minutes`);
      await new Promise((r) => setTimeout(r, attempt * 180_000));
    }
  }
  const slim = rows.map((r) => ({
    service_request_id: r.service_request_id,
    status: r.status,
    service_name: r.service_name,
    service_code: r.service_code,
    requested_datetime: r.requested_datetime,
    updated_datetime: r.updated_datetime,
    lat: r.lat,
    long: r.long,
  })) as ServiceRequest[];
  writeFileSync(file, JSON.stringify(slim));
  return slim;
}

const started = Date.now();
let daysDownloaded = 0;
const all: ServiceRequest[] = [];
const totalDays = (endDay - fetchStart) / DAY_MS;
for (let day = fetchStart, i = 1; day < endDay; day += DAY_MS, i++) {
  const rows = await loadDay(day);
  all.push(...rows);
  if (i % 5 === 0 || day + DAY_MS >= endDay) {
    console.error(`[replay] ${i}/${totalDays} days loaded, ${all.length} requests so far (${Math.round((Date.now() - started) / 1000)}s)`);
  }
}

// One entry per request, in filing order.
const byId = new Map(all.map((r) => [r.service_request_id, r]));
const requests = [...byId.values()].sort((a, b) => a.requested_datetime.localeCompare(b.requested_datetime));

interface Indexed {
  r: ServiceRequest;
  t: number;
}
const byService = new Map<string, Indexed[]>();
for (const r of requests) {
  if (!r.service_code || r.lat === undefined || r.long === undefined) continue;
  const list = byService.get(r.service_code) ?? [];
  list.push({ r, t: Date.parse(r.requested_datetime) });
  byService.set(r.service_code, list);
}

/** Requests of one service bucketed into cells a little larger than the largest radius we test. */
const CELL_DEG = 0.0025; // about 280 m north-south and 205 m east-west at Boston's latitude
const cellOf = (lat: number, long: number): [number, number] => [Math.floor(lat / CELL_DEG), Math.floor(long / CELL_DEG)];

/**
 * How many replayed requests had a match under the given rule. Requests are visited in filing order
 * and only compared with earlier requests in the same or a neighboring cell, which is exact as long
 * as the radius is smaller than a cell.
 */
function replay(radius: number, window: number): { replayed: number; matched: number; byService: Map<string, { name: string; replayed: number; matched: number }> } {
  if (radius > 200) throw new RangeError('radius must be at most 200 m for the cell index to be exact');
  let replayed = 0;
  let matched = 0;
  const perService = new Map<string, { name: string; replayed: number; matched: number }>();
  for (const [code, list] of byService) {
    const stats = { name: list[0]!.r.service_name ?? code, replayed: 0, matched: 0 };
    const cells = new Map<string, Indexed[]>();
    for (const cur of list) {
      const [cy, cx] = cellOf(cur.r.lat!, cur.r.long!);
      if (cur.t >= replayStart) {
        stats.replayed++;
        const earliest = cur.t - window * DAY_MS;
        let hit = false;
        for (let dy = -1; dy <= 1 && !hit; dy++) {
          for (let dx = -1; dx <= 1 && !hit; dx++) {
            const bucket = cells.get(`${cy + dy},${cx + dx}`);
            if (!bucket) continue;
            // Buckets are in filing order: walk back from the newest until the window is exhausted.
            for (let k = bucket.length - 1; k >= 0; k--) {
              const prev = bucket[k]!;
              if (prev.t < earliest) break;
              if (prev.t >= cur.t || !wasOpenAt(prev.r, cur.t)) continue;
              if (haversineMeters(cur.r.lat!, cur.r.long!, prev.r.lat!, prev.r.long!) <= radius) {
                hit = true;
                break;
              }
            }
          }
        }
        if (hit) stats.matched++;
      }
      const key = `${cy},${cx}`;
      const bucket = cells.get(key);
      if (bucket) bucket.push(cur);
      else cells.set(key, [cur]);
    }
    replayed += stats.replayed;
    matched += stats.matched;
    if (stats.replayed > 0) perService.set(code, stats);
  }
  return { replayed, matched, byService: perService };
}

const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);
const main = replay(radiusM, windowDays);

/** Share of each service's requests (whole fetched period) that the city still lists as open today. */
const stillOpen = new Map<string, number>();
for (const [code, list] of byService) {
  stillOpen.set(code, pct(list.filter((x) => x.r.status === 'open').length, list.length));
}

/**
 * Defects in fixed things (a pothole, a dead streetlight, a broken sidewalk slab): a second report
 * near an open one is most likely the same problem. Listed by name so the group is easy to audit;
 * requests for something new (a new sign, a new crosswalk) are left out.
 */
const FIXED_INFRASTRUCTURE = new Set([
  'Pothole',
  'Sidewalk Repair',
  'Street Light Outage',
  'Street Light Other',
  'Street Light Electrical Safety',
  'Street Light Knockdown',
  'Park Light Outage',
  'Traffic Signal Request',
  'Traffic Signal Knockdown',
  'Missing / Knocked Down Sign',
  'Missing Sign',
  'Damaged Sign',
  'Damaged/Faded Sign',
  'Sign Knockdown',
  'Crosswalk Maintenance',
  'Road Marking Maintenance',
  'Lane Divider',
  'Illegal Graffiti',
  'Fallen Tree or Branches',
  'Broken Park Equipment',
  'Broken Public Waste Receptacle',
]);

function group(label: string, include: (name: string) => boolean): { label: string; services: string[]; replayed: number; matched: number; percent: number } {
  const members = [...main.byService.values()].filter((sv) => include(sv.name));
  const replayed = members.reduce((a, sv) => a + sv.replayed, 0);
  const matched = members.reduce((a, sv) => a + sv.matched, 0);
  return { label, services: members.map((sv) => sv.name).sort(), replayed, matched, percent: pct(matched, replayed) };
}
const inReplay = requests.filter((r) => Date.parse(r.requested_datetime) >= replayStart);
const located = inReplay.filter((r) => r.service_code && r.lat !== undefined && r.long !== undefined);

const result = {
  ranAt: new Date().toISOString(),
  source: `${BOSTON.production!.baseUrl}/requests.json`,
  method:
    'Requests replayed in filing order. A request counts as matched when an earlier request of the same service_code ' +
    'was still open at the moment it was filed, had been filed within the window, and lay within the radius.',
  parameters: { radius_m: radiusM, window_days: windowDays },
  replay_period: { from: ymd(replayStart), to: ymd(endDay - DAY_MS), days: replayDays },
  lookback_from: ymd(fetchStart),
  requests: {
    fetched_including_lookback: requests.length,
    in_replay_period: inReplay.length,
    replayed_with_coordinates_and_service: main.replayed,
    without_coordinates_or_service: inReplay.length - located.length,
  },
  matched: { count: main.matched, percent_of_replayed: pct(main.matched, main.replayed) },
  sensitivity: {
    by_radius_m: [10, 25, 50, 100, 200].map((radius) => {
      const r = replay(radius, windowDays);
      return { radius_m: radius, matched: r.matched, percent: pct(r.matched, r.replayed) };
    }),
    by_window_days: [1, 7, 14, 30].filter((w) => w <= windowDays).map((window) => {
      const r = replay(radiusM, window);
      return { window_days: window, matched: r.matched, percent: pct(r.matched, r.replayed) };
    }),
  },
  groups: [
    group('Fixed infrastructure (potholes, streetlights, sidewalks, signals, signs, graffiti, fallen trees)', (name) => FIXED_INFRASTRUCTURE.has(name)),
    group('Everything except Illegal Parking', (name) => name !== 'Illegal Parking'),
    group('Illegal Parking only', (name) => name === 'Illegal Parking'),
  ],
  by_service: [...main.byService.entries()]
    .filter(([, s]) => s.replayed >= 20)
    .sort((a, b) => b[1].replayed - a[1].replayed)
    .slice(0, 25)
    .map(([code, s]) => ({
      service_name: s.name,
      replayed: s.replayed,
      matched: s.matched,
      percent: pct(s.matched, s.replayed),
      still_open_today_percent: stillOpen.get(code) ?? 0,
    })),
  caveats: [
    'Boston leaves most Illegal Parking requests marked open (see still_open_today_percent), so almost any new one near an earlier one matches. That one service drives the overall rate; read the groups.',
    'A match means "an open request of the same type existed nearby", not that a human confirmed it was the same problem.',
    'Boston records many requests at an address point or intersection, so two different problems at one address (two cars parked illegally on different days) count as a match.',
    'Whether an earlier request was open at the time is inferred from its current status and last-updated time; a request closed and later edited looks open for longer than it was.',
    'The window means requests filed up to that many days earlier; requests older than the lookback period are not seen.',
  ],
  data: {
    days_fetched: totalDays,
    days_downloaded_this_run: daysDownloaded,
    days_read_from_local_cache: totalDays - daysDownloaded,
    note: 'Requests are downloaded once per day of data at a few requests a minute and cached under .citydesk/replay/.',
  },
  run_seconds: Math.round((Date.now() - started) / 1000),
};

mkdirSync(resolve(root, 'results'), { recursive: true });
writeFileSync(resolve(root, 'results', 'dupes.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(
  `Replayed ${main.replayed} requests from ${result.replay_period.from} to ${result.replay_period.to}: ` +
    `${main.matched} (${result.matched.percent_of_replayed}%) had an open request of the same type within ${radiusM} m. Saved results/dupes.json`,
);
