/**
 * The CityDesk tool contract: names, card URIs, and the exact shape of every tool result.
 *
 * This file is types and constants only (no runtime dependencies) so the server, the cards, and the
 * web client can all import it. A tool result is always a normal MCP CallToolResult:
 *
 *   content:           [{ type: 'text', text: spoken_summary }]   what the assistant reads
 *   structuredContent: one of the *Result types below             what cards and code read
 *   isError:           true only together with an ErrorResult
 */

export const TOOL_NAMES = [
  'report_issue',
  'find_nearby_reports',
  'follow_request',
  'my_requests',
  'request_status',
  'collection_schedule',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** MCP Apps resources. Tools point at these with `_meta.ui.resourceUri`. */
export const ISSUE_CARD_URI = 'ui://citydesk/issue-card.html';
export const SCHEDULE_CARD_URI = 'ui://citydesk/schedule-card.html';
export const CARD_MIME_TYPE = 'text/html;profile=mcp-app';

/** Tool only the cards call (hidden from the assistant): returns a PNG map as an image content block. */
export const STATIC_MAP_TOOL = 'static_map';
export interface StaticMapInput {
  lat: number;
  long: number;
  /** Pixel size of the image. The server clamps both to 64..1024. */
  width: number;
  height: number;
}

/** Issue types the assistant can choose from. The server maps them onto each city's service codes. */
export const ISSUE_TYPES = [
  'pothole',
  'streetlight',
  'traffic_signal',
  'sidewalk',
  'graffiti',
  'illegal_dumping',
  'missed_trash',
  'litter',
  'tree',
  'abandoned_vehicle',
  'illegal_parking',
  'rodent',
  'other',
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

/** Where a request lives. Sandbox requests were filed by CityDesk; production ones are read-only. */
export type RequestSource = 'production' | 'sandbox';

export interface TimelineStep {
  /** Short label, e.g. "Reported", "In progress", "Closed". */
  label: string;
  /** ISO 8601 timestamp, when known. */
  at?: string;
  state: 'done' | 'current' | 'pending';
}

/** One service request, as every issue tool returns it. */
export interface IssueView {
  /** Handle to pass back to follow_request / request_status: "<endpoint id>/<service_request_id>". */
  request_id: string;
  /** The city's own identifier for the request. */
  service_request_id: string;
  /** City key, e.g. "boston". */
  city: string;
  /** Display name, e.g. "Boston". */
  city_name: string;
  source: RequestSource;
  service_code?: string;
  /** e.g. "Pothole", "Street Light Outage". */
  service_name: string;
  status: 'open' | 'closed';
  /** The city's latest note on the request, if any. */
  status_notes?: string;
  description?: string;
  address?: string;
  lat?: number;
  long?: number;
  /** ISO 8601. When the request was filed. */
  requested_datetime: string;
  /** ISO 8601. Last change on the city's side. */
  updated_datetime?: string;
  /** ISO 8601. When the city expects to resolve it, if it says. */
  expected_datetime?: string;
  /** Photo attached to the request, if any (https URL). */
  media_url?: string;
  /** Distance from the location the resident named, in meters. Set on nearby/duplicate results. */
  distance_m?: number;
  /** How the current user relates to this request, if at all. */
  relation?: 'filed' | 'followed';
  /** ISO 8601. When the user filed or started following it. */
  relation_since?: string;
  timeline: TimelineStep[];
}

export interface Clarification {
  /** One question the assistant should ask, in plain spoken English. */
  question: string;
  /** Up to 5 short choices the resident can pick from. May be empty for an open question. */
  options: string[];
  /**
   * Set when the question fills in a detail of the report rather than its location: call
   * report_issue again with the same arguments plus `details: { [field]: <the answer> }`.
   */
  field?: string;
}

export interface ResolvedLocation {
  /** Normalized address or place label. */
  label: string;
  lat: number;
  long: number;
}

export type IssueOutcome =
  /** A new request was created (in a sandbox). requests[0] is it. */
  | 'filed'
  /** Nothing was filed: open requests of the same type exist nearby. requests lists them, nearest first. */
  | 'possible_duplicate'
  /** Nothing was filed or searched: ask `clarification.question` first. */
  | 'needs_clarification'
  /** The user now follows requests[0]. */
  | 'followed'
  /** Current state of requests[0]. */
  | 'status'
  /** The user's filed and followed requests, newest first. */
  | 'requests'
  /** Open requests near a location, nearest first. Empty list means none were found. */
  | 'nearby';

/** The error carried by any failed tool call. */
export interface ToolError {
  code: ErrorCode;
  message: string;
  /** True when the same call may succeed if retried later. */
  retryable: boolean;
  details?: Record<string, unknown>;
}

/**
 * structuredContent of report_issue, find_nearby_reports, follow_request, my_requests, request_status.
 * A failed call has outcome "error", an empty `requests` list and `error` set (see ErrorResult), so
 * every result, success or failure, conforms to the tool's declared output schema.
 */
export interface IssueResult {
  outcome: IssueOutcome | 'error';
  /** One or two sentences that stand on their own when spoken, with no card on screen. */
  spoken_summary: string;
  requests: IssueView[];
  clarification?: Clarification;
  resolved_location?: ResolvedLocation;
  /** The duplicate search that ran, when one did. */
  search?: { radius_m: number; window_days: number; service_name?: string };
  /** Set only when outcome is "error". */
  error?: ToolError;
  /** ISO 8601. When this result was computed. */
  as_of: string;
}

export type Weekday = 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday' | 'Sunday';

export interface CollectionStream {
  /** Pickup weekdays, e.g. ["Monday", "Thursday"]. Empty when the city lists none for this address. */
  weekdays: Weekday[];
  /** YYYY-MM-DD of the next pickup in the city's time zone, when weekdays is not empty. */
  next_date?: string;
}

export interface CollectionSchedule {
  /** The matched address, as the city writes it. */
  address: string;
  neighborhood?: string;
  zip_code?: string;
  /** The city's address identifier (Boston SAM address ID). */
  address_id: string;
  trash: CollectionStream;
  recycling: CollectionStream;
  /** Every pickup day in the next 14 days, soonest first. */
  upcoming: Array<{ date: string; weekday: Weekday; trash: boolean; recycling: boolean }>;
  /** IANA time zone the dates are in, e.g. "America/New_York". */
  time_zone: string;
  dataset: { name: string; resource_id: string; last_modified?: string };
}

/** structuredContent of collection_schedule. */
export interface ScheduleResult {
  outcome: 'schedule' | 'needs_clarification' | 'error';
  spoken_summary: string;
  schedule?: CollectionSchedule;
  clarification?: Clarification;
  /** Set only when outcome is "error". */
  error?: ToolError;
  /** ISO 8601. */
  as_of: string;
}

export type ErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'location_not_found'
  | 'outside_service_area'
  | 'service_not_available'
  | 'write_blocked'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'not_configured'
  | 'internal';

/**
 * What every failed tool call has in common. It is always returned with `isError: true`. Issue tools
 * also include `requests: []`, so the same object is a valid IssueResult.
 */
export interface ErrorResult {
  outcome: 'error';
  spoken_summary: string;
  error: ToolError;
  as_of: string;
}

export type CityDeskResult = IssueResult | ScheduleResult | ErrorResult;
