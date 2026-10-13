/**
 * DEVELOPMENT PREVIEW ONLY. Not part of the CityDesk server and never deployed.
 *
 * A small stateless Streamable HTTP MCP server that registers the two cards and one tool per card
 * state, each returning fixture data in the contract shape. Point an MCP Apps host at it to look at
 * the cards without the real tools, the city APIs or AWS:
 *
 *   pnpm --filter @citydesk/server preview:cards        # http://localhost:8790/mcp
 *
 * Environment:
 *   PORT                 port to listen on (default 8790)
 *   HOST                 interface to bind (default 127.0.0.1)
 *   PREVIEW_STATIC_MAP   "error" (default): static_map returns a structured error, so the cards show
 *                        their drawn placeholder. "png": it returns a synthetic PNG, to exercise the
 *                        image path.
 *
 * Only localhost browsers may call it: the Host and Origin headers are checked with the SDK's
 * localhost allowlists, and CORS is granted to exactly the origins that pass.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import {
  McpServer,
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
  validateOriginHeader,
  type CallToolResult,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import * as z from 'zod';
import {
  ISSUE_CARD_URI,
  SCHEDULE_CARD_URI,
  STATIC_MAP_TOOL,
  type CollectionSchedule,
  type ErrorResult,
  type IssueResult,
  type IssueView,
  type ScheduleResult,
  type StaticMapInput,
  type TimelineStep,
  type Weekday,
} from '../contract.ts';
import { cardOnlyToolMeta, cardToolMeta, registerCards, type CardUri } from './index.ts';

const DEFAULT_PORT = 8790;
const TIME_ZONE = 'America/New_York';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ---------- fixtures ----------

const WEEKDAYS: readonly Weekday[] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function iso(now: Date, offsetMs: number): string {
  return new Date(now.getTime() + offsetMs).toISOString();
}

function steps(now: Date, entries: Array<[label: string, state: TimelineStep['state'], offsetMs?: number]>): TimelineStep[] {
  return entries.map(([label, state, offsetMs]) =>
    offsetMs === undefined ? { label, state } : { label, state, at: iso(now, offsetMs) },
  );
}

/** A production pothole request on Commonwealth Avenue, in progress. */
function pothole(now: Date): IssueView {
  return {
    request_id: 'boston/6f1d2c9e-3b7a-4e52-9a41-0c8d5e7f2b16',
    service_request_id: '6f1d2c9e-3b7a-4e52-9a41-0c8d5e7f2b16',
    city: 'boston',
    city_name: 'Boston',
    source: 'production',
    service_code: 'Public Works Department:Highway Maintenance:Request for Pothole Repair',
    service_name: 'Pothole',
    status: 'open',
    status_notes: 'Assigned to the Public Works street maintenance crew.',
    description: 'Deep pothole in the right lane, just before the Babcock Street stop.',
    address: '1079-1089 Commonwealth Ave, Boston, MA 02215',
    lat: 42.352443,
    long: -71.124948,
    requested_datetime: iso(now, -2 * DAY - 3 * HOUR),
    updated_datetime: iso(now, -5 * HOUR),
    expected_datetime: iso(now, 3 * DAY),
    timeline: steps(now, [
      ['Reported', 'done', -2 * DAY - 3 * HOUR],
      ['In progress', 'current', -5 * HOUR],
      ['Closed', 'pending'],
    ]),
  };
}

/** The same pothole as CityDesk files it: a brand new sandbox request. */
function filedPothole(now: Date): IssueView {
  return {
    ...pothole(now),
    request_id: 'boston-sandbox/b41c7a06-58e2-4d1f-8c39-7e0a2f6d915b',
    service_request_id: 'b41c7a06-58e2-4d1f-8c39-7e0a2f6d915b',
    source: 'sandbox',
    status_notes: undefined,
    requested_datetime: iso(now, -MINUTE),
    updated_datetime: undefined,
    expected_datetime: undefined,
    relation: 'filed',
    relation_since: iso(now, -MINUTE),
    timeline: steps(now, [
      ['Reported', 'current', -MINUTE],
      ['In progress', 'pending'],
      ['Closed', 'pending'],
    ]),
  };
}

/**
 * A closed production request with a photo, shaped like a real Boston record. The media_url points
 * at Boston's public photo host; if that image is ever removed the card just hides the photo.
 */
function trashStorage(now: Date): IssueView {
  return {
    request_id: 'boston/3f7faa33-fcd0-4907-a1f4-26f26614cec2',
    service_request_id: '3f7faa33-fcd0-4907-a1f4-26f26614cec2',
    city: 'boston',
    city_name: 'Boston',
    source: 'production',
    service_code: 'acb41f11-e581-42bc-a0a5-877cb3a07747',
    service_name: 'Improper Trash Storage',
    status: 'closed',
    status_notes: 'Noted. No violation found by Code Enforcement.',
    address: '88 E Brookline St, Boston, MA 02118',
    lat: 42.33745822,
    long: -71.06978066,
    requested_datetime: iso(now, -8 * HOUR),
    updated_datetime: iso(now, -2 * HOUR),
    media_url:
      'https://spot-boston-res.cloudinary.com/image/upload/v1791873912/boston/production/f4imypaeykky4lmrpfoz.jpg',
    timeline: steps(now, [
      ['Reported', 'done', -8 * HOUR],
      ['In progress', 'done', -3 * HOUR],
      ['Closed', 'current', -2 * HOUR],
    ]),
  };
}

/**
 * A followed request with a legacy numeric ID, a five-step timeline (one more than the card shows)
 * and a photo URL that does not exist, so the card's hide-on-failure path can be seen.
 */
function streetLight(now: Date): IssueView {
  return {
    request_id: 'boston/101006120347',
    service_request_id: '101006120347',
    city: 'boston',
    city_name: 'Boston',
    source: 'production',
    service_code: 'Public Works Department:Street Lights:Street Light Outages',
    service_name: 'Street Light Outage',
    status: 'open',
    status_notes: 'Crew scheduled. Parts on order for the fixture at pole 14.',
    address: 'Boylston St & Dartmouth St, Boston, MA 02116',
    lat: 42.350157,
    long: -71.077105,
    requested_datetime: iso(now, -6 * DAY),
    updated_datetime: iso(now, -DAY),
    expected_datetime: iso(now, 4 * DAY),
    media_url: 'https://spot-boston-res.cloudinary.com/image/upload/citydesk-preview/does-not-exist.jpg',
    relation: 'followed',
    relation_since: iso(now, -10 * MINUTE),
    timeline: steps(now, [
      ['Reported', 'done', -6 * DAY],
      ['Acknowledged', 'done', -5 * DAY],
      ['Assigned to crew', 'done', -3 * DAY],
      ['In progress', 'current', -DAY],
      ['Closed', 'pending'],
    ]),
  };
}

function nearbyPotholes(now: Date): IssueView[] {
  const base = pothole(now);
  return [
    { ...base, distance_m: 12 },
    {
      ...base,
      request_id: 'boston/c0a4e1f7-92d3-4b68-a5e0-3d1f7b9c2e84',
      service_request_id: 'c0a4e1f7-92d3-4b68-a5e0-3d1f7b9c2e84',
      address: '1101 Commonwealth Ave, Boston, MA 02215',
      lat: 42.352221,
      long: -71.125532,
      distance_m: 54,
      status_notes: undefined,
      requested_datetime: iso(now, -4 * DAY),
      updated_datetime: iso(now, -4 * DAY),
      expected_datetime: undefined,
      timeline: steps(now, [
        ['Reported', 'current', -4 * DAY],
        ['In progress', 'pending'],
        ['Closed', 'pending'],
      ]),
    },
    {
      ...base,
      request_id: 'boston/101006118902',
      service_request_id: '101006118902',
      address: 'Commonwealth Ave & Babcock St, Brookline, MA 02446',
      lat: 42.351874,
      long: -71.121512,
      distance_m: 96,
      requested_datetime: iso(now, -9 * DAY),
      updated_datetime: iso(now, -7 * DAY),
      expected_datetime: undefined,
    },
  ];
}

function nearbyMixed(now: Date): IssueView[] {
  const light = streetLight(now);
  return [
    { ...light, relation: undefined, relation_since: undefined, media_url: undefined, distance_m: 35 },
    {
      // Still open, and it keeps the photo, so the featured slot of a list can show one too.
      ...trashStorage(now),
      request_id: 'boston/5e0b7c18-a3f4-4d92-8b60-f1c2d3e4a597',
      service_request_id: '5e0b7c18-a3f4-4d92-8b60-f1c2d3e4a597',
      status: 'open',
      status_notes: undefined,
      address: '39 Dartmouth St, Boston, MA 02116',
      lat: 42.3462,
      long: -71.0752,
      distance_m: 120,
      updated_datetime: undefined,
      timeline: steps(now, [
        ['Reported', 'current', -8 * HOUR],
        ['In progress', 'pending'],
        ['Closed', 'pending'],
      ]),
    },
    {
      ...pothole(now),
      request_id: 'boston/7a9e5d21-0c4b-4f3a-b6d8-12e9c3a7f540',
      service_request_id: '7a9e5d21-0c4b-4f3a-b6d8-12e9c3a7f540',
      address: '500 Boylston St, Boston, MA 02116',
      lat: 42.35032,
      long: -71.07412,
      distance_m: 210,
    },
    {
      ...light,
      request_id: 'boston/101006117730',
      service_request_id: '101006117730',
      service_name: 'Illegally Blocked Sidewalk',
      address: '647 Boylston St, Boston, MA 02116',
      lat: 42.34968,
      long: -71.07861,
      relation: undefined,
      relation_since: undefined,
      media_url: undefined,
      distance_m: 260,
      timeline: steps(now, [
        ['Reported', 'current', -DAY],
        ['In progress', 'pending'],
        ['Closed', 'pending'],
      ]),
    },
    {
      ...light,
      request_id: 'boston/d2b8f6a3-41c7-4e90-9f25-6a3c0e8d1b77',
      service_request_id: 'd2b8f6a3-41c7-4e90-9f25-6a3c0e8d1b77',
      service_name: 'Litter & Debris',
      address: 'Copley Square, Boston, MA 02116',
      lat: 42.35001,
      long: -71.07614,
      relation: undefined,
      relation_since: undefined,
      media_url: undefined,
      distance_m: 340,
    },
  ];
}

function myRequests(now: Date): IssueView[] {
  const filed = filedPothole(now);
  return [
    filed,
    streetLight(now),
    {
      ...filed,
      request_id: 'boston-sandbox/e7d1a9c4-2b65-4f08-b3a1-9c5e0d7f6a23',
      service_request_id: 'e7d1a9c4-2b65-4f08-b3a1-9c5e0d7f6a23',
      service_name: 'Illegal Dumping or Disposal',
      description: 'Mattress and two chairs left on the sidewalk.',
      address: '68 Montgomery St, Boston, MA 02116',
      lat: 42.34336366,
      long: -71.07441095,
      status: 'closed',
      requested_datetime: iso(now, -12 * DAY),
      updated_datetime: iso(now, -10 * DAY),
      relation_since: iso(now, -12 * DAY),
      timeline: steps(now, [
        ['Reported', 'done', -12 * DAY],
        ['In progress', 'done', -11 * DAY],
        ['Closed', 'current', -10 * DAY],
      ]),
    },
    { ...trashStorage(now), relation: 'followed', relation_since: iso(now, -7 * HOUR) },
    { ...pothole(now), relation: 'followed', relation_since: iso(now, -2 * DAY) },
    {
      ...filed,
      request_id: 'boston-sandbox/19c3e5b0-7f4a-4d26-8e1c-b5a2d9f03c61',
      service_request_id: '19c3e5b0-7f4a-4d26-8e1c-b5a2d9f03c61',
      service_name: 'Abandoned Vehicle',
      description: 'Grey sedan with no plates, parked for three weeks.',
      address: '171 Warren Ave, Boston, MA 02116',
      lat: 42.34394379,
      long: -71.07625678,
      requested_datetime: iso(now, -20 * DAY),
      relation_since: iso(now, -20 * DAY),
    },
  ];
}

function issue(now: Date, result: Omit<IssueResult, 'as_of'>): IssueResult {
  return { ...result, as_of: now.toISOString() };
}

// Calendar helpers for the schedule fixture (dates are YYYY-MM-DD in the city's zone).

function todayInZone(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function addDays(ymd: string, days: number): string {
  const date = new Date(`${ymd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekdayOf(ymd: string): Weekday {
  return WEEKDAYS[new Date(`${ymd}T00:00:00Z`).getUTCDay()] ?? 'Sunday';
}

function schedule(now: Date, trash: Weekday[], recycling: Weekday[]): CollectionSchedule {
  const today = todayInZone(now);
  const days = Array.from({ length: 14 }, (_, offset) => addDays(today, offset));
  const upcoming = days
    .map((date) => {
      const weekday = weekdayOf(date);
      return { date, weekday, trash: trash.includes(weekday), recycling: recycling.includes(weekday) };
    })
    .filter((day) => day.trash || day.recycling);
  return {
    // The real Boston record for this address: trashday "MTH", recollect "MTH".
    address: '700 Boylston St',
    neighborhood: 'Boston',
    zip_code: '02116',
    address_id: '156199',
    trash: { weekdays: trash, next_date: upcoming.find((day) => day.trash)?.date },
    recycling: { weekdays: recycling, next_date: upcoming.find((day) => day.recycling)?.date },
    upcoming,
    time_zone: TIME_ZONE,
    dataset: {
      name: 'Trash Schedules by Address',
      resource_id: 'fee8ee07-b8b5-4ee5-b540-5162590ba5c1',
      last_modified: iso(now, -9 * DAY),
    },
  };
}

function failure(now: Date, error: ErrorResult['error'], spoken: string): ErrorResult {
  return { outcome: 'error', spoken_summary: spoken, error, as_of: now.toISOString() };
}

// ---------- tool results ----------

function ok(data: IssueResult | ScheduleResult): CallToolResult {
  return { content: [{ type: 'text', text: data.spoken_summary }], structuredContent: { ...data } };
}

function failed(data: ErrorResult): CallToolResult {
  return { content: [{ type: 'text', text: data.spoken_summary }], structuredContent: { ...data }, isError: true };
}

interface PreviewTool {
  name: string;
  card: CardUri;
  title: string;
  result: (now: Date) => CallToolResult;
}

const COMM_AVE = { label: '1079 Commonwealth Ave, Boston', lat: 42.352443, long: -71.124948 };
const COPLEY = { label: 'Copley Square, Boston', lat: 42.35001, long: -71.07614 };

export const PREVIEW_TOOLS: readonly PreviewTool[] = [
  {
    name: 'preview_issue_filed',
    card: ISSUE_CARD_URI,
    title: 'Issue card: request filed (sandbox)',
    result: (now) =>
      ok(
        issue(now, {
          outcome: 'filed',
          spoken_summary: 'Done. I filed a pothole report for 1079 Commonwealth Avenue. This one went to the test sandbox.',
          requests: [filedPothole(now)],
          resolved_location: COMM_AVE,
        }),
      ),
  },
  {
    name: 'preview_issue_status',
    card: ISSUE_CARD_URI,
    title: 'Issue card: status of one request, in progress',
    result: (now) =>
      ok(
        issue(now, {
          outcome: 'status',
          spoken_summary: 'The pothole on Commonwealth Avenue is in progress. The city expects to finish it in three days.',
          requests: [pothole(now)],
        }),
      ),
  },
  {
    name: 'preview_issue_status_photo',
    card: ISSUE_CARD_URI,
    title: 'Issue card: closed request with a photo',
    result: (now) =>
      ok(
        issue(now, {
          outcome: 'status',
          spoken_summary: 'That request is closed. Code Enforcement found no violation.',
          requests: [trashStorage(now)],
        }),
      ),
  },
  {
    name: 'preview_issue_followed',
    card: ISSUE_CARD_URI,
    title: 'Issue card: now following (numeric ID, long timeline, missing photo)',
    result: (now) =>
      ok(
        issue(now, {
          outcome: 'followed',
          spoken_summary: 'You are now following the street light outage at Boylston and Dartmouth.',
          requests: [streetLight(now)],
        }),
      ),
  },
  {
    name: 'preview_issue_possible_duplicate',
    card: ISSUE_CARD_URI,
    title: 'Issue card: possible duplicates (3)',
    result: (now) =>
      ok(
        issue(now, {
          outcome: 'possible_duplicate',
          spoken_summary:
            'Three open pothole reports are already within 100 meters. The closest is 12 meters away and in progress. Want to follow it instead?',
          requests: nearbyPotholes(now),
          resolved_location: COMM_AVE,
          search: { radius_m: 100, window_days: 30, service_name: 'Pothole' },
        }),
      ),
  },
  {
    name: 'preview_issue_duplicate_single',
    card: ISSUE_CARD_URI,
    title: 'Issue card: one possible duplicate',
    result: (now) =>
      ok(
        issue(now, {
          outcome: 'possible_duplicate',
          spoken_summary: 'There is already an open pothole report 12 meters away, and it is in progress.',
          requests: nearbyPotholes(now).slice(0, 1),
          resolved_location: COMM_AVE,
          search: { radius_m: 100, window_days: 30, service_name: 'Pothole' },
        }),
      ),
  },
  {
    name: 'preview_issue_nearby',
    card: ISSUE_CARD_URI,
    title: 'Issue card: nearby reports (5)',
    result: (now) =>
      ok(
        issue(now, {
          outcome: 'nearby',
          spoken_summary: 'I found five open reports near Copley Square. The closest is a street light outage 35 meters away.',
          requests: nearbyMixed(now),
          resolved_location: COPLEY,
          search: { radius_m: 400, window_days: 30 },
        }),
      ),
  },
  {
    name: 'preview_issue_nearby_empty',
    card: ISSUE_CARD_URI,
    title: 'Issue card: nearby reports, none found',
    result: (now) =>
      ok(
        issue(now, {
          outcome: 'nearby',
          spoken_summary: 'There are no open reports within 150 meters of Copley Square.',
          requests: [],
          resolved_location: COPLEY,
          search: { radius_m: 150, window_days: 30 },
        }),
      ),
  },
  {
    name: 'preview_issue_requests',
    card: ISSUE_CARD_URI,
    title: 'Issue card: my requests (6, shows 5)',
    result: (now) =>
      ok(
        issue(now, {
          outcome: 'requests',
          spoken_summary: 'You have six requests. Three you filed and three you follow. Four are still open.',
          requests: myRequests(now),
        }),
      ),
  },
  {
    name: 'preview_issue_requests_empty',
    card: ISSUE_CARD_URI,
    title: 'Issue card: my requests, none yet',
    result: (now) =>
      ok(
        issue(now, {
          outcome: 'requests',
          spoken_summary: 'You have not filed or followed any requests yet. Tell me about a problem and I can report it.',
          requests: [],
        }),
      ),
  },
  {
    name: 'preview_issue_clarification',
    card: ISSUE_CARD_URI,
    title: 'Issue card: needs clarification',
    result: (now) =>
      ok(
        issue(now, {
          outcome: 'needs_clarification',
          spoken_summary: 'What kind of problem is it?',
          requests: [],
          clarification: {
            question: 'What kind of problem is it on Commonwealth Avenue?',
            options: ['Pothole', 'Broken streetlight', 'Damaged sidewalk', 'Something else'],
          },
          resolved_location: COMM_AVE,
        }),
      ),
  },
  {
    name: 'preview_issue_error',
    card: ISSUE_CARD_URI,
    title: 'Issue card: tool error',
    result: (now) =>
      failed(
        failure(
          now,
          {
            code: 'upstream_unavailable',
            message: 'Boston Open311 returned HTTP 503 after 3 attempts.',
            retryable: true,
            details: { endpoint: 'boston', attempts: 3 },
          },
          'Boston 311 is not answering right now, so I could not check that. I can try again in a minute.',
        ),
      ),
  },
  {
    name: 'preview_schedule',
    card: SCHEDULE_CARD_URI,
    title: 'Schedule card: trash and recycling on Monday and Thursday',
    result: (now) => {
      const data = schedule(now, ['Monday', 'Thursday'], ['Monday', 'Thursday']);
      return ok({
        outcome: 'schedule',
        spoken_summary: 'At 700 Boylston Street, trash and recycling are both picked up on Mondays and Thursdays.',
        schedule: data,
        as_of: now.toISOString(),
      });
    },
  },
  {
    name: 'preview_schedule_split',
    card: SCHEDULE_CARD_URI,
    title: 'Schedule card: different days, recycling once a week',
    result: (now) => {
      const data = schedule(now, ['Tuesday', 'Friday'], ['Friday']);
      return ok({
        outcome: 'schedule',
        spoken_summary: 'At 700 Boylston Street, trash goes out Tuesdays and Fridays, and recycling on Fridays.',
        schedule: data,
        as_of: now.toISOString(),
      });
    },
  },
  {
    name: 'preview_schedule_no_recycling',
    card: SCHEDULE_CARD_URI,
    title: 'Schedule card: a stream with no weekdays',
    result: (now) => {
      const data = schedule(now, ['Monday', 'Thursday'], []);
      return ok({
        outcome: 'schedule',
        spoken_summary: 'At 700 Boylston Street, trash is picked up on Mondays and Thursdays. The city lists no recycling days there.',
        schedule: data,
        as_of: now.toISOString(),
      });
    },
  },
  {
    name: 'preview_schedule_clarification',
    card: SCHEDULE_CARD_URI,
    title: 'Schedule card: needs clarification',
    result: (now) =>
      ok({
        outcome: 'needs_clarification',
        spoken_summary: 'I found more than one match. Which address did you mean?',
        clarification: {
          question: 'Which Boylston Street address did you mean?',
          options: ['700 Boylston St, 02116', '700 Boylston St, Unit 2', '70 Boylston St, 02116'],
        },
        as_of: now.toISOString(),
      }),
  },
  {
    name: 'preview_schedule_error',
    card: SCHEDULE_CARD_URI,
    title: 'Schedule card: tool error',
    result: (now) =>
      failed(
        failure(
          now,
          { code: 'location_not_found', message: 'No address in the trash schedule dataset matches "12 Nowhere Ln".', retryable: false },
          'I could not find that address in Boston. Could you give me the street number and street name again?',
        ),
      ),
  },
];

// ---------- static_map ----------

/** A minimal PNG encoder (8-bit RGB, no filtering) for the synthetic map. */
function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const start = y * (width * 3 + 1);
    rows[start] = 0; // filter: none
    rgb.copy(rows, start + 1, y * width * 3, (y + 1) * width * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A flat street grid that reads as "a map", so the card's image path can be checked offline. */
function syntheticMap(width: number, height: number): Buffer {
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const across = (((x + y * 0.22) % 132) + 132) % 132;
      const down = (((y - x * 0.14) % 104) + 104) % 104;
      const water = y - x * 0.08 > height * 0.86;
      let colour: [number, number, number] = [226, 232, 238];
      if (water) colour = [189, 211, 234];
      else if (across < 13 || down < 11) colour = [255, 255, 255];
      else if (across > 60 && across < 118 && down > 46 && down < 92 && (x + y) % 264 < 132) colour = [208, 226, 206];
      rgb.set(colour, (y * width + x) * 3);
    }
  }
  return encodePng(width, height, rgb);
}

function clampPixels(value: number): number {
  return Math.min(1024, Math.max(64, Math.round(value)));
}

function staticMap(input: StaticMapInput, mode: string): CallToolResult {
  if (mode === 'png') {
    const png = syntheticMap(clampPixels(input.width), clampPixels(input.height));
    return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] };
  }
  return failed(
    failure(
      new Date(),
      {
        code: 'not_configured',
        message: 'The preview server has no map provider. Set PREVIEW_STATIC_MAP=png for a synthetic map.',
        retryable: false,
      },
      'The map is not available.',
    ),
  );
}

// ---------- server ----------

export function buildPreviewServer(mapMode = process.env.PREVIEW_STATIC_MAP ?? 'error'): McpServer {
  const server = new McpServer({ name: 'citydesk-card-preview', version: '0.1.0' });
  registerCards(server);

  for (const tool of PREVIEW_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: `Development preview. Returns fixture data for: ${tool.title}.`,
        annotations: { readOnlyHint: true },
        _meta: cardToolMeta(tool.card),
      },
      () => tool.result(new Date()),
    );
  }

  server.registerTool(
    STATIC_MAP_TOOL,
    {
      title: 'Static map (preview stub)',
      description: 'Development preview. Returns a structured error, or a synthetic PNG when PREVIEW_STATIC_MAP=png.',
      inputSchema: z.object({ lat: z.number(), long: z.number(), width: z.number(), height: z.number() }),
      annotations: { readOnlyHint: true },
      _meta: cardOnlyToolMeta(),
    },
    (input) => staticMap(input, mapMode),
  );

  return server;
}

function corsHeaders(request: IncomingMessage): Record<string, string> {
  const origin = request.headers.origin;
  if (!origin || !validateOriginHeader(origin, localhostAllowedOrigins()).ok) return {};
  const requested = request.headers['access-control-request-headers'];
  return {
    'access-control-allow-origin': origin,
    vary: 'Origin',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers':
      typeof requested === 'string' && requested !== ''
        ? requested
        : 'content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id',
    'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version',
    'access-control-max-age': '600',
  };
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks);
}

async function toWebRequest(request: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = request.method ?? 'GET';
  const url = `http://${request.headers.host ?? 'localhost'}${request.url ?? '/'}`;
  if (method === 'GET' || method === 'HEAD') return new Request(url, { method, headers });
  return new Request(url, { method, headers, body: new Uint8Array(await readBody(request)) });
}

async function sendWebResponse(response: Response, target: ServerResponse, extraHeaders: Record<string, string>): Promise<void> {
  const headers: Record<string, string> = { ...extraHeaders };
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  target.writeHead(response.status, headers);
  if (!response.body) {
    target.end();
    return;
  }
  const reader = response.body.getReader();
  target.on('close', () => void reader.cancel().catch(() => undefined));
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    target.write(value);
  }
  target.end();
}

async function serve(handler: McpHttpHandler, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const cors = corsHeaders(request);
  const path = (request.url ?? '/').split('?')[0];

  if (request.method === 'OPTIONS') {
    response.writeHead(204, cors).end();
    return;
  }
  if (path === '/' || path === '/healthz') {
    const body = [
      'CityDesk card preview server (development only).',
      'MCP endpoint: /mcp',
      '',
      ...PREVIEW_TOOLS.map((tool) => `${tool.name}  ${tool.title}`),
      '',
    ].join('\n');
    response.writeHead(200, { ...cors, 'content-type': 'text/plain; charset=utf-8' }).end(body);
    return;
  }
  if (path !== '/mcp') {
    response.writeHead(404, { ...cors, 'content-type': 'text/plain; charset=utf-8' }).end('Not found. The MCP endpoint is /mcp.\n');
    return;
  }

  const webRequest = await toWebRequest(request);
  const rejected =
    hostHeaderValidationResponse(webRequest, localhostAllowedHostnames()) ??
    originValidationResponse(webRequest, localhostAllowedOrigins());
  await sendWebResponse(rejected ?? (await handler.fetch(webRequest)), response, cors);
}

/** The preview server as a node:http server (not yet listening). */
export function createPreviewHttpServer(mapMode?: string): HttpServer {
  // Stateless: createMcpHandler builds a fresh McpServer from the factory for every request.
  const handler = createMcpHandler(() => buildPreviewServer(mapMode), {
    onerror: (error) => console.error(`[card-preview] ${error.message}`),
  });
  const server = createServer((request, response) => {
    serve(handler, request, response).catch((error: unknown) => {
      console.error('[card-preview] request failed:', error);
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Internal error\n');
    });
  });
  server.on('close', () => void handler.close());
  return server;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const port = Number.parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT;
  const host = process.env.HOST ?? '127.0.0.1';
  createPreviewHttpServer().listen(port, host, () => {
    console.log(`CityDesk card preview (development only): http://localhost:${port}/mcp`);
    console.log(`static_map mode: ${process.env.PREVIEW_STATIC_MAP ?? 'error'}`);
    console.log(`${PREVIEW_TOOLS.length} preview tools; open http://localhost:${port}/ for the list.`);
  });
}
