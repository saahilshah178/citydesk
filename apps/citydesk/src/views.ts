import type { ServiceRequest } from 'open311-mcp';
import type { IssueView, RequestSource, TimelineStep } from './contract.ts';

export interface ViewContext {
  endpointId: string;
  source: RequestSource;
  city: string;
  cityName: string;
  distanceMeters?: number;
  relation?: 'filed' | 'followed';
  relationSince?: string;
}

export function makeRequestId(endpointId: string, serviceRequestId: string): string {
  return `${endpointId}/${serviceRequestId}`;
}

/** Splits "<endpoint id>/<service_request_id>". Undefined when the handle is malformed. */
export function parseRequestId(requestId: string): { endpointId: string; serviceRequestId: string } | undefined {
  const at = requestId.indexOf('/');
  if (at <= 0 || at === requestId.length - 1) return undefined;
  return { endpointId: requestId.slice(0, at), serviceRequestId: requestId.slice(at + 1) };
}

function timeline(r: ServiceRequest): TimelineStep[] {
  const hasUpdate =
    r.updated_datetime !== undefined &&
    Date.parse(r.updated_datetime) - Date.parse(r.requested_datetime) > 60_000;
  if (r.status === 'closed') {
    return [
      { label: 'Reported', at: r.requested_datetime, state: 'done' },
      { label: 'In progress', state: 'done' },
      { label: 'Closed', at: r.updated_datetime, state: 'current' },
    ];
  }
  const acknowledged = hasUpdate || r.status_notes !== undefined;
  return [
    { label: 'Reported', at: r.requested_datetime, state: acknowledged ? 'done' : 'current' },
    { label: 'In progress', at: acknowledged ? r.updated_datetime : undefined, state: acknowledged ? 'current' : 'pending' },
    { label: 'Closed', at: r.expected_datetime, state: 'pending' },
  ];
}

export function toIssueView(r: ServiceRequest, ctx: ViewContext): IssueView {
  return {
    request_id: makeRequestId(ctx.endpointId, r.service_request_id),
    service_request_id: r.service_request_id,
    city: ctx.city,
    city_name: ctx.cityName,
    source: ctx.source,
    service_code: r.service_code,
    service_name: r.service_name ?? 'Service request',
    status: r.status,
    status_notes: r.status_notes,
    description: r.description,
    address: r.address,
    lat: r.lat,
    long: r.long,
    requested_datetime: r.requested_datetime,
    updated_datetime: r.updated_datetime,
    expected_datetime: r.expected_datetime,
    media_url: r.media_url?.startsWith('https://') ? r.media_url : undefined,
    distance_m: ctx.distanceMeters === undefined ? undefined : Math.round(ctx.distanceMeters),
    relation: ctx.relation,
    relation_since: ctx.relationSince,
    timeline: timeline(r),
  };
}
