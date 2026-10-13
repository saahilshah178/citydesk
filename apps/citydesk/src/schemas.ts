/**
 * Output schemas for the tools, mirroring contract.ts. Declared on each tool so clients can rely on
 * the shape of structuredContent. `satisfies` keeps these in step with the TypeScript contract.
 */
import { z } from 'zod';
import type { IssueResult, ScheduleResult } from './contract.ts';

const isoDateTime = z.string().describe('ISO 8601 date-time');
const weekday = z.enum(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);

const clarification = z.object({
  question: z.string(),
  options: z.array(z.string()).max(5),
  field: z.string().optional(),
});

const timelineStep = z.object({
  label: z.string(),
  at: isoDateTime.optional(),
  state: z.enum(['done', 'current', 'pending']),
});

export const issueViewSchema = z.object({
  request_id: z.string().describe('Handle to pass to follow_request or request_status'),
  service_request_id: z.string().describe("The city's own ID for the request"),
  city: z.string(),
  city_name: z.string(),
  source: z.enum(['production', 'sandbox']),
  service_code: z.string().optional(),
  service_name: z.string(),
  status: z.enum(['open', 'closed']),
  status_notes: z.string().optional(),
  description: z.string().optional(),
  address: z.string().optional(),
  lat: z.number().optional(),
  long: z.number().optional(),
  requested_datetime: isoDateTime,
  updated_datetime: isoDateTime.optional(),
  expected_datetime: isoDateTime.optional(),
  media_url: z.string().optional(),
  distance_m: z.number().optional(),
  relation: z.enum(['filed', 'followed']).optional(),
  relation_since: isoDateTime.optional(),
  timeline: z.array(timelineStep),
});

const toolError = z
  .object({
    code: z.enum([
      'invalid_input',
      'not_found',
      'location_not_found',
      'outside_service_area',
      'service_not_available',
      'write_blocked',
      'rate_limited',
      'upstream_unavailable',
      'not_configured',
      'internal',
    ]),
    message: z.string(),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .describe('Present only when outcome is "error"');

export const issueResultSchema = z.object({
  outcome: z.enum(['filed', 'possible_duplicate', 'needs_clarification', 'followed', 'status', 'requests', 'nearby', 'error']),
  spoken_summary: z.string(),
  requests: z.array(issueViewSchema),
  clarification: clarification.optional(),
  resolved_location: z.object({ label: z.string(), lat: z.number(), long: z.number() }).optional(),
  search: z.object({ radius_m: z.number(), window_days: z.number(), service_name: z.string().optional() }).optional(),
  error: toolError.optional(),
  as_of: isoDateTime,
});

const stream = z.object({
  weekdays: z.array(weekday),
  next_date: z.string().optional().describe('YYYY-MM-DD'),
});

export const scheduleResultSchema = z.object({
  outcome: z.enum(['schedule', 'needs_clarification', 'error']),
  spoken_summary: z.string(),
  schedule: z
    .object({
      address: z.string(),
      neighborhood: z.string().optional(),
      zip_code: z.string().optional(),
      address_id: z.string(),
      trash: stream,
      recycling: stream,
      upcoming: z.array(z.object({ date: z.string(), weekday, trash: z.boolean(), recycling: z.boolean() })),
      time_zone: z.string(),
      dataset: z.object({ name: z.string(), resource_id: z.string(), last_modified: z.string().optional() }),
    })
    .optional(),
  clarification: clarification.optional(),
  error: toolError.optional(),
  as_of: isoDateTime,
});

// Compile-time checks that the schemas and the contract describe the same shapes.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const issueMatches: Same<z.infer<typeof issueResultSchema>, IssueResult> = true;
const scheduleMatches: Same<z.infer<typeof scheduleResultSchema>, ScheduleResult> = true;
void [issueMatches, scheduleMatches];
