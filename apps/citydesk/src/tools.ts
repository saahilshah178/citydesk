/**
 * The six CityDesk tools, one per thing a resident wants to do.
 *
 * Design rules, from Amazon's Alexa+ tool guidance:
 *   - each description says when to call the tool, why, and what it returns;
 *   - input schemas declare only parameters the tool honors;
 *   - every result carries stable IDs and ISO dates in structuredContent;
 *   - failures are structured errors with isError: true, never a bare success flag;
 *   - the text content is a spoken summary that stands on its own without a card.
 */
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { Open311Error, type ServiceAttribute, type ServiceDefinition, type ServiceRequest } from 'open311-mcp';
import { z } from 'zod';
import { AddressDirectoryError, parseDayCodes, TRASH_DATASET_NAME, TRASH_RESOURCE_ID, type AddressRecord } from './addresses.ts';
import {
  ISSUE_TYPES,
  type Clarification,
  type CollectionSchedule,
  type CollectionStream,
  type ErrorCode,
  type ErrorResult,
  type IssueOutcome,
  type IssueResult,
  type IssueType,
  type IssueView,
  type ResolvedLocation,
  type ScheduleResult,
  type Weekday,
} from './contract.ts';
import { findDuplicates } from './dedupe.ts';
import { joinOr } from './geocode/bostonAddresses.ts';
import type { Place } from './geocode/types.ts';
import { describeIssueTypes, ISSUE_TYPE_SPECS } from './issueTypes.ts';
import type { CityDeskRuntime, EndpointRuntime } from './runtime.ts';
import { issueResultSchema, scheduleResultSchema } from './schemas.ts';
import {
  addDays,
  joinAnd,
  plural,
  sayAddress,
  sayComingDay,
  sayDistance,
  sayPastDay,
  weekdayOf,
  zonedDate,
} from './speech.ts';
import type { TrackedRequest } from './store/types.ts';
import { makeRequestId, parseRequestId, toIssueView } from './views.ts';

export interface UserContext {
  /** Stable identifier for the resident (household or device). */
  userId: string;
}

/** Attached to tool definitions so hosts can render a card. Filled in by the cards module. */
export interface ToolUiMeta {
  issueCard?: Record<string, unknown>;
  scheduleCard?: Record<string, unknown>;
}

const MAX_TRACKED_SHOWN = 5;

// --- result builders -----------------------------------------------------------------------------

function nowIso(rt: CityDeskRuntime): string {
  return new Date(rt.now()).toISOString();
}

function issueResult(rt: CityDeskRuntime, result: Omit<IssueResult, 'as_of'>): CallToolResult {
  const structured: IssueResult = { ...result, as_of: nowIso(rt) };
  return { content: [{ type: 'text', text: structured.spoken_summary }], structuredContent: { ...structured } };
}

function scheduleResult(rt: CityDeskRuntime, result: Omit<ScheduleResult, 'as_of'>): CallToolResult {
  const structured: ScheduleResult = { ...result, as_of: nowIso(rt) };
  return { content: [{ type: 'text', text: structured.spoken_summary }], structuredContent: { ...structured } };
}

/** Which tool family failed: decides the shape the error must take to satisfy that tool's output schema. */
type ResultKind = 'issue' | 'schedule';

export function errorResult(
  rt: CityDeskRuntime,
  kind: ResultKind,
  code: ErrorCode,
  spoken: string,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>,
): CallToolResult {
  const base: ErrorResult = {
    outcome: 'error',
    spoken_summary: spoken,
    error: { code, message, retryable, ...(details ? { details } : {}) },
    as_of: nowIso(rt),
  };
  // Issue tools promise a `requests` array in their output schema, so a failure carries an empty one.
  const structured = kind === 'issue' ? { ...base, requests: [] } : { ...base };
  return { isError: true, content: [{ type: 'text', text: spoken }], structuredContent: structured };
}

const OPEN311_CODES: Record<string, ErrorCode> = {
  write_blocked: 'write_blocked',
  not_found: 'not_found',
  invalid_request: 'invalid_input',
  rate_limited: 'rate_limited',
  upstream_unavailable: 'upstream_unavailable',
  bad_response: 'upstream_unavailable',
  not_configured: 'not_configured',
};

/** Maps anything a tool throws onto a structured error with a sentence the assistant can say. */
export function fromThrown(rt: CityDeskRuntime, kind: ResultKind, err: unknown): CallToolResult {
  if (err instanceof Open311Error) {
    const code = OPEN311_CODES[err.code] ?? 'internal';
    const spoken =
      code === 'rate_limited'
        ? `${rt.city.name}'s system is busy right now. Please try again in a minute.`
        : code === 'upstream_unavailable'
          ? `I could not reach ${rt.city.name}'s service request system just now. Please try again shortly.`
          : code === 'write_blocked'
            ? 'I can only file reports in a test system, and that is not available for this request.'
            : code === 'not_found'
              ? 'I could not find that request.'
              : 'I could not complete that request.';
    return errorResult(rt, kind, code, spoken, err.message, err.retryable, err.details);
  }
  if (err instanceof AddressDirectoryError) {
    return errorResult(
      rt,
      kind,
      'upstream_unavailable',
      'I could not reach the city address records just now. Please try again shortly.',
      err.message,
      err.retryable,
    );
  }
  const e = err instanceof Error ? err : new Error(String(err));
  rt.log('tool_failed', { error: e.message, name: e.name });
  const awsDenied = /credential|AccessDenied|not authorized|UnrecognizedClient|ExpiredToken/i.test(`${e.name} ${e.message}`);
  return errorResult(
    rt,
    kind,
    awsDenied ? 'not_configured' : 'internal',
    'Something went wrong on my side, so I could not finish that. Please try again.',
    e.message,
    !awsDenied,
  );
}

function clarify(rt: CityDeskRuntime, clarification: Clarification, extra: Partial<IssueResult> = {}): CallToolResult {
  return issueResult(rt, {
    outcome: 'needs_clarification',
    spoken_summary: clarification.question,
    requests: [],
    clarification: { ...clarification, options: clarification.options.slice(0, 5) },
    ...extra,
  });
}

// --- shared steps --------------------------------------------------------------------------------

type Located = { ok: true; place: Place; resolved: ResolvedLocation } | { ok: false; result: CallToolResult };

async function locate(rt: CityDeskRuntime, text: string): Promise<Located> {
  const geo = await rt.geocoder.geocode(text, rt.city);
  if (geo.status === 'ambiguous') {
    return { ok: false, result: clarify(rt, { question: geo.question, options: geo.options }) };
  }
  if (geo.status === 'not_found') {
    return {
      ok: false,
      result: clarify(rt, {
        question: `I could not find "${text}" in ${rt.city.name}. What is the street address, or the two nearest cross streets?`,
        options: [],
      }),
    };
  }
  const { place } = geo;
  return { ok: true, place, resolved: { label: place.label, lat: place.lat, long: place.long } };
}

interface NearbyHit {
  view: IssueView;
  distanceMeters: number;
}

/** Open requests of this type near a point, nearest first, across the live system and the sandboxes. */
async function findNearby(
  rt: CityDeskRuntime,
  user: UserContext,
  issueType: IssueType,
  at: { lat: number; long: number },
  radiusMeters: number,
  max: number,
): Promise<NearbyHit[]> {
  const open = await rt.openRequests(issueType);
  const byRequest = new Map(open.map((o) => [o.request, o.endpoint]));
  const matches = findDuplicates(
    open.map((o) => o.request),
    at,
    { radiusMeters, windowDays: rt.config.dedupeWindowDays, now: rt.now(), max },
  );
  const tracked = new Map((await rt.store.list(user.userId)).map((t) => [t.request_id, t]));
  return matches.map((m) => {
    const endpoint = byRequest.get(m.request)!;
    const mine = tracked.get(makeRequestId(endpoint.id, m.request.service_request_id));
    return { view: view(rt, endpoint, m.request, { distanceMeters: m.distanceMeters, tracked: mine }), distanceMeters: m.distanceMeters };
  });
}

function view(
  rt: CityDeskRuntime,
  endpoint: EndpointRuntime,
  request: ServiceRequest,
  extra: { distanceMeters?: number; tracked?: TrackedRequest } = {},
): IssueView {
  return toIssueView(request, {
    endpointId: endpoint.id,
    source: endpoint.source,
    city: rt.city.id,
    cityName: rt.city.name,
    distanceMeters: extra.distanceMeters,
    relation: extra.tracked?.relation,
    relationSince: extra.tracked?.since,
  });
}

function whereOf(v: Pick<IssueView, 'address'>): string {
  const street = sayAddress(v.address);
  return street ? ` at ${street}` : '';
}

/** Sandbox references are short enough to say; production UUIDs are not, so they are never spoken. */
function spokenReference(v: IssueView): string {
  return v.source === 'sandbox' && v.service_request_id.length <= 12 ? `, reference ${v.service_request_id}` : '';
}

async function remember(rt: CityDeskRuntime, user: UserContext, v: IssueView, relation: 'filed' | 'followed'): Promise<TrackedRequest> {
  const at = nowIso(rt);
  const { endpointId } = parseRequestId(v.request_id)!;
  const tracked = await rt.store.track(user.userId, {
    request_id: v.request_id,
    endpoint_id: endpointId,
    service_request_id: v.service_request_id,
    relation,
    since: at,
    service_name: v.service_name,
    address: v.address,
  });
  await rt.store.snapshot(user.userId, v.request_id, { status: v.status, status_notes: v.status_notes, checked: at });
  return tracked;
}

/** Matches a spoken answer against the allowed values of a list attribute. */
function matchAttributeValue(attribute: ServiceAttribute, answer: string): string | undefined {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const a = norm(answer);
  if (!a) return undefined;
  const exact = attribute.values.find((v) => norm(v.key) === a || norm(v.name) === a);
  if (exact) return exact.key;
  const containing = attribute.values.filter((v) => a.includes(norm(v.name)) || norm(v.name).includes(a));
  if (containing.length === 1) return containing[0]!.key;
  // Last resort: the one value sharing the most words with the answer.
  const words = new Set(a.split(' ').filter((w) => w.length > 2));
  const scored = attribute.values
    .map((v) => ({ key: v.key, score: norm(v.name).split(' ').filter((w) => words.has(w)).length }))
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score);
  if (scored.length === 0 || (scored.length > 1 && scored[0]!.score === scored[1]!.score)) return undefined;
  return scored[0]!.key;
}

/** Fills in required service attributes from `details`, or reports the first one still missing. */
function resolveAttributes(
  definition: ServiceDefinition | undefined,
  details: Record<string, string>,
): { attributes: Record<string, string>; missing?: ServiceAttribute } {
  const attributes: Record<string, string> = {};
  for (const attribute of definition?.attributes ?? []) {
    if (!attribute.variable) continue;
    const answer = details[attribute.code];
    if (answer === undefined || answer.trim() === '') {
      if (attribute.required) return { attributes, missing: attribute };
      continue;
    }
    if (attribute.values.length === 0) {
      attributes[attribute.code] = answer.trim();
      continue;
    }
    const key = matchAttributeValue(attribute, answer);
    if (key !== undefined) attributes[attribute.code] = key;
    else if (attribute.required) return { attributes, missing: attribute };
  }
  return { attributes };
}

// --- schedule ------------------------------------------------------------------------------------

function buildSchedule(rt: CityDeskRuntime, record: AddressRecord, lastModified: string | undefined): CollectionSchedule {
  const timeZone = rt.city.timeZone;
  const today = zonedDate(rt.now(), timeZone).ymd;
  const trashDays = parseDayCodes(record.trashday);
  const recyclingDays = parseDayCodes(record.recollect);
  const upcoming: CollectionSchedule['upcoming'] = [];
  for (let i = 0; i < 14; i++) {
    const date = addDays(today, i);
    const weekday = weekdayOf(date);
    const trash = trashDays.includes(weekday);
    const recycling = recyclingDays.includes(weekday);
    if (trash || recycling) upcoming.push({ date, weekday, trash, recycling });
  }
  const stream = (weekdays: Weekday[], pick: (u: (typeof upcoming)[number]) => boolean): CollectionStream => ({
    weekdays,
    next_date: upcoming.find(pick)?.date,
  });
  return {
    address: record.full_address,
    neighborhood: record.neighborhood,
    zip_code: record.zip_code,
    address_id: record.address_id,
    trash: stream(trashDays, (u) => u.trash),
    recycling: stream(recyclingDays, (u) => u.recycling),
    upcoming,
    time_zone: timeZone,
    dataset: { name: TRASH_DATASET_NAME, resource_id: TRASH_RESOURCE_ID, last_modified: lastModified },
  };
}

function sayDays(days: Weekday[]): string {
  return joinAnd(days.map((d) => `${d}s`));
}

function scheduleSummary(rt: CityDeskRuntime, s: CollectionSchedule): string {
  const today = zonedDate(rt.now(), s.time_zone).ymd;
  const where = `At ${s.address}`;
  const { trash, recycling } = s;
  if (trash.weekdays.length === 0 && recycling.weekdays.length === 0) {
    return `${rt.city.name} lists no curbside pickup day for ${s.address}. Larger buildings often use a private hauler.`;
  }
  const same = trash.weekdays.join() === recycling.weekdays.join();
  if (same && trash.next_date) {
    return `${where}, trash and recycling are both picked up on ${sayDays(trash.weekdays)}. The next pickup is ${sayComingDay(trash.next_date, today)}.`;
  }
  const parts: string[] = [];
  if (trash.weekdays.length > 0) parts.push(`trash is picked up on ${sayDays(trash.weekdays)}`);
  if (recycling.weekdays.length > 0) parts.push(`recycling on ${sayDays(recycling.weekdays)}`);
  const next: string[] = [];
  if (trash.next_date) next.push(`trash ${sayComingDay(trash.next_date, today)}`);
  if (recycling.next_date) next.push(`recycling ${sayComingDay(recycling.next_date, today)}`);
  return `${where}, ${joinAnd(parts)}. Next up: ${joinAnd(next)}.`;
}

// --- status --------------------------------------------------------------------------------------

/** Fetches the current state of tracked requests, one upstream call per endpoint. */
async function refresh(
  rt: CityDeskRuntime,
  tracked: TrackedRequest[],
): Promise<Map<string, { endpoint: EndpointRuntime; request: ServiceRequest }>> {
  const byEndpoint = new Map<string, TrackedRequest[]>();
  for (const t of tracked) byEndpoint.set(t.endpoint_id, [...(byEndpoint.get(t.endpoint_id) ?? []), t]);
  const out = new Map<string, { endpoint: EndpointRuntime; request: ServiceRequest }>();
  let failure: unknown;
  for (const [endpointId, items] of byEndpoint) {
    const endpoint = rt.endpoint(endpointId);
    if (!endpoint) continue;
    try {
      const rows = await endpoint.client.getRequests(items.map((i) => i.service_request_id), endpoint.kind);
      for (const request of rows) out.set(makeRequestId(endpointId, request.service_request_id), { endpoint, request });
    } catch (err) {
      failure = err;
      rt.log('refresh_failed', { endpoint: endpointId, error: String(err) });
    }
  }
  // If nothing at all could be refreshed, the caller should hear the error rather than stale data.
  if (out.size === 0 && failure !== undefined) throw failure;
  return out;
}

function changeSince(tracked: TrackedRequest | undefined, v: IssueView): 'closed' | 'reopened' | 'note' | undefined {
  if (!tracked?.last_status) return undefined;
  if (tracked.last_status !== v.status) return v.status === 'closed' ? 'closed' : 'reopened';
  if ((tracked.last_status_notes ?? '') !== (v.status_notes ?? '') && v.status_notes) return 'note';
  return undefined;
}

function statusSentence(v: IssueView, change: ReturnType<typeof changeSince>, own: boolean): string {
  const subject = `${own ? 'Your' : 'The'} ${v.service_name.toLowerCase()} report${whereOf(v)}`;
  const note = v.status_notes ? ` The latest note says: ${v.status_notes.replace(/\s+/g, ' ').trim()}` : '';
  if (change === 'closed') return `${subject} has been closed.${note}`;
  if (change === 'reopened') return `${subject} was reopened.${note}`;
  if (change === 'note') return `${subject} has an update.${note}`;
  return `${subject} is ${v.status === 'closed' ? 'closed' : 'still open'}.${note}`;
}

// --- registration --------------------------------------------------------------------------------

export function registerCityDeskTools(server: McpServer, rt: CityDeskRuntime, user: UserContext, ui: ToolUiMeta = {}): void {
  const city = rt.city.name;
  const issueMeta = ui.issueCard ? { _meta: ui.issueCard } : {};
  const scheduleMeta = ui.scheduleCard ? { _meta: ui.scheduleCard } : {};
  const issueType = z.enum(ISSUE_TYPES).describe(`The kind of problem. Pick the closest: ${describeIssueTypes()}.`);
  const location = z
    .string()
    .min(3)
    .max(200)
    .describe(`Where it is, as the resident said it: a street address, an intersection, or a landmark in ${city}.`);
  const requestId = z
    .string()
    .min(3)
    .max(200)
    .describe('The request_id of a request, exactly as an earlier tool result returned it.');
  const guard =
    <A>(kind: ResultKind, run: (args: A) => Promise<CallToolResult>) =>
    async (args: A): Promise<CallToolResult> => {
      try {
        return await run(args);
      } catch (err) {
        return fromThrown(rt, kind, err);
      }
    };

  server.registerTool(
    'report_issue',
    {
      title: 'Report a problem to the city',
      description:
        `Call this when the resident wants to report a non-emergency problem in ${city}, such as a pothole or a broken streetlight. ` +
        'It finds the place, checks whether the same problem is already reported nearby, and only then files a new request, ' +
        'so call it directly rather than calling find_nearby_reports first. ' +
        'Returns one of three outcomes: "possible_duplicate" with the existing open reports (offer follow_request instead of filing again), ' +
        '"needs_clarification" with one question to ask the resident before calling again, or "filed" with the new request, its request_id and filing time. ' +
        'New requests go to a test system, never to the live city system.',
      inputSchema: z.object({
        issue_type: issueType,
        description: z.string().min(3).max(1000).describe('What is wrong, in the resident\'s own words.'),
        location,
        details: z
          .record(z.string(), z.string())
          .optional()
          .describe('Answers to earlier needs_clarification questions that named a "field": { <field>: <the resident\'s answer> }.'),
        file_even_if_duplicate: z
          .boolean()
          .default(false)
          .describe('Set true only after the resident heard about an existing report and still wants a new one filed.'),
      }),
      outputSchema: issueResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      ...issueMeta,
    },
    guard('issue', async (args) => {
      const spec = ISSUE_TYPE_SPECS[args.issue_type];
      const located = await locate(rt, args.location);
      if (!located.ok) return located.result;
      const { place, resolved } = located;
      const search = { radius_m: rt.config.dedupeRadiusMeters, window_days: rt.config.dedupeWindowDays, service_name: spec.label };

      if (!args.file_even_if_duplicate) {
        const nearby = await findNearby(rt, user, args.issue_type, place, rt.config.dedupeRadiusMeters, 3);
        const first = nearby[0];
        if (first) {
          const when = sayPastDay(first.view.requested_datetime, rt.city.timeZone, rt.now());
          const mine = first.view.relation ? ' You are already tracking it.' : ' Do you want to follow that report instead of filing a new one?';
          const lead =
            nearby.length === 1
              ? `Someone already reported a ${spec.label}${whereOf(first.view)} ${when}, ${sayDistance(first.distanceMeters)}, and it is still open.`
              : `There are already ${nearby.length} open ${spec.label} reports there. The nearest${whereOf(first.view)} was reported ${when}, ${sayDistance(first.distanceMeters)}.`;
          return issueResult(rt, {
            outcome: 'possible_duplicate',
            spoken_summary: `${lead}${mine}`,
            requests: nearby.map((n) => n.view),
            resolved_location: resolved,
            search,
          });
        }
      }

      const target = await rt.pickWriteTarget(args.issue_type);
      const definition = target.service.metadata
        ? await target.endpoint.client.getServiceDefinition(target.service.service_code, 'test')
        : undefined;
      const { attributes, missing } = resolveAttributes(definition, args.details ?? {});
      if (missing) {
        const options = missing.values.map((v) => v.name);
        return clarify(
          rt,
          {
            question: options.length > 0 && !/\?\s*$/.test(missing.description) ? `${missing.description}: ${joinOr(options)}?` : missing.description,
            options,
            field: missing.code,
          },
          { resolved_location: resolved, search },
        );
      }

      // A public demo needs a ceiling: cap filings per household and overall, per clock hour.
      const hour = Math.floor(rt.now() / 3_600_000);
      const mine = await rt.store.increment(`filings#${user.userId}#${hour}`, 7200);
      const everyone = await rt.store.increment(`filings#all#${hour}`, 7200);
      if (mine > rt.config.maxFilingsPerUserPerHour || everyone > rt.config.maxFilingsPerHour) {
        return errorResult(
          rt,
          'issue',
          'rate_limited',
          'I have filed as many reports as I can for this hour. Please try again a little later.',
          mine > rt.config.maxFilingsPerUserPerHour
            ? `This household reached the limit of ${rt.config.maxFilingsPerUserPerHour} reports per hour.`
            : `The server reached its limit of ${rt.config.maxFilingsPerHour} reports per hour.`,
          true,
          { retry_after_seconds: 3600 - Math.floor((rt.now() / 1000) % 3600) },
        );
      }

      const created = await target.endpoint.client.createRequest(
        {
          serviceCode: target.service.service_code,
          description: args.description,
          lat: place.lat,
          long: place.long,
          addressString: place.label,
          attributes,
          deviceId: `citydesk:${user.userId.slice(0, 40)}`,
        },
        'test',
      );
      const id =
        created.service_request_id ??
        (created.token ? await target.endpoint.client.getRequestIdFromToken(created.token, 'test') : undefined);
      if (!id) {
        return errorResult(
          rt,
          'issue',
          'upstream_unavailable',
          'The report was accepted, but the test system has not given it a reference yet. Ask me for your requests in a minute.',
          'The sandbox returned a token but no service_request_id yet.',
          true,
          { endpoint: target.endpoint.id, token: created.token },
        );
      }
      const stored =
        (await target.endpoint.client.getRequest(id, 'test')) ??
        ({
          service_request_id: id,
          status: 'open',
          service_name: target.service.service_name,
          service_code: target.service.service_code,
          description: args.description,
          address: place.label,
          lat: place.lat,
          long: place.long,
          requested_datetime: nowIso(rt),
        } satisfies ServiceRequest);
      const filed = view(rt, target.endpoint, stored);
      const tracked = await remember(rt, user, filed, 'filed');
      const result: IssueView = { ...filed, relation: tracked.relation, relation_since: tracked.since };
      rt.log('report_filed', { endpoint: target.endpoint.id, issue_type: args.issue_type, request_id: result.request_id });
      return issueResult(rt, {
        outcome: 'filed',
        spoken_summary:
          `Done. I filed your ${spec.label} report for ${sayAddress(place.label) ?? place.label} in the ${target.endpoint.label}${spokenReference(result)}. ` +
          'It is a test system, so nothing was sent to the city, and I will remember it when you ask about your requests.',
        requests: [result],
        resolved_location: resolved,
        search,
      });
    }),
  );

  server.registerTool(
    'find_nearby_reports',
    {
      title: 'Check for existing reports near a place',
      description:
        `Call this when the resident asks whether a problem has already been reported, or what is reported near a place in ${city}, without asking to file anything. ` +
        'It searches open requests of one type around the location. ' +
        'Returns the matching open requests, nearest first, each with its request_id, address, distance in meters, status and filing date. ' +
        'An empty list means nothing of that type is open nearby.',
      inputSchema: z.object({
        issue_type: issueType,
        location,
        radius_meters: z
          .number()
          .int()
          .min(10)
          .max(500)
          .optional()
          .describe(`How far around the place to look. Defaults to ${rt.config.dedupeRadiusMeters} meters.`),
      }),
      outputSchema: issueResultSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
      ...issueMeta,
    },
    guard('issue', async (args) => {
      const spec = ISSUE_TYPE_SPECS[args.issue_type];
      const located = await locate(rt, args.location);
      if (!located.ok) return located.result;
      const radius = args.radius_meters ?? rt.config.dedupeRadiusMeters;
      const nearby = await findNearby(rt, user, args.issue_type, located.place, radius, MAX_TRACKED_SHOWN);
      const place = sayAddress(located.place.label) ?? located.place.label;
      const first = nearby[0];
      const spoken = first
        ? `There ${nearby.length === 1 ? 'is' : 'are'} ${plural(nearby.length, `open ${spec.label} report`)} near ${place}. ` +
          `The nearest${whereOf(first.view)} was reported ${sayPastDay(first.view.requested_datetime, rt.city.timeZone, rt.now())}, ${sayDistance(first.distanceMeters)}.`
        : `I found no open ${spec.label} reports within ${Math.round(radius * 3.28084)} feet of ${place} from the last ${rt.config.dedupeWindowDays} days.`;
      return issueResult(rt, {
        outcome: 'nearby',
        spoken_summary: spoken,
        requests: nearby.map((n) => n.view),
        resolved_location: located.resolved,
        search: { radius_m: radius, window_days: rt.config.dedupeWindowDays, service_name: spec.label },
      });
    }),
  );

  server.registerTool(
    'follow_request',
    {
      title: 'Follow an existing request',
      description:
        'Call this when the resident wants to follow or track a request that already exists, typically one that report_issue or find_nearby_reports just returned. ' +
        'It saves the request to the resident\'s list so my_requests and request_status can report on it later, even in a new conversation. ' +
        'Returns the request with its current status, the time the resident started following it, and its request_id.',
      inputSchema: z.object({ request_id: requestId }),
      outputSchema: issueResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      ...issueMeta,
    },
    guard('issue', async ({ request_id }) => {
      const found = await lookup(rt, request_id);
      if (!found.ok) return found.result;
      const base = view(rt, found.endpoint, found.request);
      const tracked = await remember(rt, user, base, 'followed');
      const v: IssueView = { ...base, relation: tracked.relation, relation_since: tracked.since };
      const already = tracked.relation === 'filed' ? 'You filed this one, so it is already on your list. ' : '';
      return issueResult(rt, {
        outcome: 'followed',
        spoken_summary:
          `${already}You are now following the ${v.service_name.toLowerCase()} report${whereOf(v)}, which is ${v.status}. ` +
          'Ask me about your requests any time to hear what has changed.',
        requests: [v],
      });
    }),
  );

  server.registerTool(
    'my_requests',
    {
      title: 'List my requests',
      description:
        'Call this when the resident asks about their requests in general, such as "what\'s happening with my reports" or "any updates". ' +
        'It loads every request they filed or follow and checks each one\'s current status with the city. ' +
        'Returns the requests newest first, each with its request_id, status, latest city note, and the dates it was filed and last updated. ' +
        'Use request_status instead when they ask about one specific request.',
      inputSchema: z.object({}),
      outputSchema: issueResultSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
      ...issueMeta,
    },
    guard('issue', async () => {
      const all = await rt.store.list(user.userId);
      if (all.length === 0) {
        return issueResult(rt, {
          outcome: 'requests',
          spoken_summary: 'You have not filed or followed any requests yet. Tell me about a problem and I can report it or find an existing report.',
          requests: [],
        });
      }
      const shown = all.slice(0, MAX_TRACKED_SHOWN);
      const fresh = await refresh(rt, shown);
      const at = nowIso(rt);
      const views: IssueView[] = [];
      const sentences: string[] = [];
      let changed = 0;
      for (const tracked of shown) {
        const current = fresh.get(tracked.request_id);
        if (!current) continue;
        const v = view(rt, current.endpoint, current.request, { tracked });
        const change = changeSince(tracked, v);
        if (change) changed++;
        views.push(v);
        sentences.push(statusSentence({ ...v, status_notes: change ? v.status_notes : undefined }, change, tracked.relation === 'filed'));
        await rt.store.snapshot(user.userId, tracked.request_id, { status: v.status, status_notes: v.status_notes, checked: at });
      }
      if (views.length === 0) {
        return errorResult(
          rt,
          'issue',
          'not_found',
          'I have your requests on file, but the city is not returning them right now. Please try again later.',
          'None of the tracked requests were returned by their endpoints.',
          true,
          { tracked: shown.map((t) => t.request_id) },
        );
      }
      const lead = `You have ${plural(all.length, 'request')}${changed > 0 ? `, and ${changed === 1 ? 'one has' : `${changed} have`} changed since you last checked` : ''}.`;
      const more = views.length > 2 ? ` The other ${views.length - 2 === 1 ? 'one is' : `${views.length - 2} are`} on screen.` : '';
      return issueResult(rt, {
        outcome: 'requests',
        spoken_summary: `${lead} ${sentences.slice(0, 2).join(' ')}${more}`,
        requests: views,
      });
    }),
  );

  server.registerTool(
    'request_status',
    {
      title: 'Get the status of one request',
      description:
        'Call this when the resident asks about one specific request and you have its request_id from an earlier result (call my_requests first if you do not). ' +
        'It asks the city for the current state of that request. ' +
        'Returns the request with its status, the city\'s latest note, a timeline, and the dates it was filed, last updated and expected to be resolved.',
      inputSchema: z.object({ request_id: requestId }),
      outputSchema: issueResultSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
      ...issueMeta,
    },
    guard('issue', async ({ request_id }) => {
      const found = await lookup(rt, request_id);
      if (!found.ok) return found.result;
      const tracked = await rt.store.get(user.userId, request_id);
      const v = view(rt, found.endpoint, found.request, { tracked });
      const change = changeSince(tracked, v);
      if (tracked) {
        await rt.store.snapshot(user.userId, request_id, { status: v.status, status_notes: v.status_notes, checked: nowIso(rt) });
      }
      const filed = `It was filed ${sayPastDay(v.requested_datetime, rt.city.timeZone, rt.now())}.`;
      return issueResult(rt, {
        outcome: 'status',
        spoken_summary: `${statusSentence(v, change, tracked?.relation === 'filed')} ${filed}`,
        requests: [v],
      });
    }),
  );

  server.registerTool(
    'collection_schedule',
    {
      title: 'Trash and recycling days',
      description:
        `Call this when the resident asks when trash or recycling is collected, or which day to put bins out, at an address in ${city}. ` +
        'It looks the address up in the city\'s published schedule and remembers it as the resident\'s home address. ' +
        'Returns the matched address, the weekly trash and recycling days, the date of the next pickup of each, and every pickup in the next 14 days. ' +
        'Omit the address to reuse the one saved from an earlier call.',
      inputSchema: z.object({
        address: z
          .string()
          .min(3)
          .max(200)
          .optional()
          .describe('Street number and street name, e.g. "700 Boylston Street". Add the neighborhood if the resident said it. Omit to use the saved home address.'),
      }),
      outputSchema: scheduleResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      ...scheduleMeta,
    },
    guard('schedule', async ({ address }) => {
      let text = address;
      if (!text) {
        const home = await rt.store.getHomeAddress(user.userId);
        if (!home) {
          return scheduleResult(rt, {
            outcome: 'needs_clarification',
            spoken_summary: 'What is your street address?',
            clarification: { question: 'What is your street address?', options: [] },
          });
        }
        text = [home.address, home.neighborhood].filter(Boolean).join(' ');
      }
      const { parsed, matches } = await rt.directory.search(text);
      if (matches.length === 0) {
        const question = `I could not find "${text}" in ${city}'s address records. What is the street number and street name?`;
        return scheduleResult(rt, { outcome: 'needs_clarification', spoken_summary: question, clarification: { question, options: [] } });
      }
      if (matches.length > 1) {
        const options = matches.slice(0, 5).map((m) => m.neighborhood ?? m.zip_code ?? m.full_address);
        const question = `There is a ${parsed.core} in more than one neighborhood. Which one: ${joinOr(options)}?`;
        return scheduleResult(rt, { outcome: 'needs_clarification', spoken_summary: question, clarification: { question, options } });
      }
      const record = matches[0]!;
      const schedule = buildSchedule(rt, record, await rt.directory.datasetLastModified());
      await rt.store.setHomeAddress(user.userId, {
        address_id: record.address_id,
        address: record.full_address,
        neighborhood: record.neighborhood,
        zip_code: record.zip_code,
        saved_at: nowIso(rt),
      });
      return scheduleResult(rt, { outcome: 'schedule', spoken_summary: scheduleSummary(rt, schedule), schedule });
    }),
  );
}

type Lookup =
  | { ok: true; endpoint: EndpointRuntime; request: ServiceRequest }
  | { ok: false; result: CallToolResult };

/** Resolves a request_id handle to its endpoint and current state. */
async function lookup(rt: CityDeskRuntime, requestId: string): Promise<Lookup> {
  const parsed = parseRequestId(requestId);
  const endpoint = parsed ? rt.endpoint(parsed.endpointId) : undefined;
  if (!parsed || !endpoint) {
    return {
      ok: false,
      result: errorResult(
        rt,
        'issue',
        'invalid_input',
        'I do not recognize that request. Ask me for your requests and I can look it up.',
        `"${requestId}" is not a request_id returned by this server. Expected "<endpoint>/<id>".`,
        false,
        { request_id: requestId },
      ),
    };
  }
  const request = await endpoint.client.getRequest(parsed.serviceRequestId, endpoint.kind);
  if (!request) {
    return {
      ok: false,
      result: errorResult(
        rt,
        'issue',
        'not_found',
        'I could not find that request. It may have been removed.',
        `${endpoint.label} has no request with ID ${parsed.serviceRequestId}.`,
        false,
        { request_id: requestId },
      ),
    };
  }
  rt.learn(endpoint, [request]);
  return { ok: true, endpoint, request };
}

export type { IssueOutcome };
