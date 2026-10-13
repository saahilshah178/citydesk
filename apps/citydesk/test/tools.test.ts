import { describe, expect, it } from 'vitest';
import type { ErrorResult, IssueResult, ScheduleResult } from '../src/contract.ts';
import { TOOL_NAMES } from '../src/contract.ts';
import { issueResultSchema, scheduleResultSchema } from '../src/schemas.ts';
import { harness, TOKEN } from './harness.ts';

const DAY = 86_400_000;

describe('tool catalog', () => {
  it('exposes exactly the six resident-facing tools, each saying when to call it and what it returns', async () => {
    const h = harness();
    const client = await h.connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.description).toMatch(/^Call this when/);
      expect(tool.description).toMatch(/Returns/);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.outputSchema?.type).toBe('object');
    }
    const report = tools.find((t) => t.name === 'report_issue')!;
    expect(Object.keys(report.inputSchema.properties!).sort()).toEqual(
      ['description', 'details', 'file_even_if_duplicate', 'issue_type', 'location'].sort(),
    );
    expect(report.inputSchema.required).toEqual(expect.arrayContaining(['issue_type', 'description', 'location']));
    expect(client.getInstructions()).toMatch(/one or two sentences/);
  });
});

describe('report_issue', () => {
  it('finds an existing open report nearby and files nothing', async () => {
    const h = harness();
    const client = await h.connect();
    const r = await h.call<IssueResult>(client, 'report_issue', {
      issue_type: 'pothole',
      description: "There's a huge pothole in front of the building",
      location: '1079 Commonwealth Avenue',
    });
    expect(r.isError).toBe(false);
    expect(r.data.outcome).toBe('possible_duplicate');
    const existing = r.data.requests[0]!;
    expect(existing).toMatchObject({ source: 'production', service_name: 'Pothole', status: 'open', city: 'boston' });
    expect(existing.request_id).toBe(`boston/${existing.service_request_id}`);
    expect(existing.distance_m).toBeLessThanOrEqual(50);
    expect(existing.requested_datetime).toMatch(/^2026-10-13T/);
    expect(r.data.search).toEqual({ radius_m: 50, window_days: 30, service_name: 'pothole' });
    expect(r.data.resolved_location?.label).toContain('1079 Commonwealth Ave');
    // The spoken summary stands alone: what, where, when, and the offer.
    // Filed 2026-10-13T03:25Z, which is late on October 12th in Boston: "yesterday" at 8 a.m. on the 13th.
    expect(r.text).toMatch(/already reported a pothole at 1079-1089 Commonwealth Ave yesterday, about 100 feet away/);
    expect(r.text).toMatch(/follow that report instead/);
    expect(r.text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(await h.runtime.sandbox.store.list()).toHaveLength(0);
  });

  it('asks one follow-up question for a required detail, then files in the sandbox', async () => {
    const h = harness();
    const client = await h.connect();
    const args = { issue_type: 'streetlight', description: 'The streetlight outside is out', location: '700 Boylston Street' };

    const first = await h.call<IssueResult>(client, 'report_issue', args);
    expect(first.data.outcome).toBe('needs_clarification');
    expect(first.data.clarification).toEqual({
      question: 'Is the light completely out, flickering, or on during the day?',
      options: ['Completely out', 'Flickering', 'On during the day'],
      field: 'light_condition',
    });
    expect(first.text).toBe(first.data.clarification!.question);
    expect(await h.runtime.sandbox.store.list()).toHaveLength(0);

    const second = await h.call<IssueResult>(client, 'report_issue', { ...args, details: { light_condition: "it's completely out" } });
    expect(second.data.outcome).toBe('filed');
    const filed = second.data.requests[0]!;
    expect(filed).toMatchObject({ source: 'sandbox', status: 'open', service_name: 'Street Light Outage', relation: 'filed' });
    expect(filed.request_id).toMatch(/^citydesk-sandbox\/SB-\d{5}$/);
    expect(filed.address).toContain('700 Boylston St');
    expect(filed.lat).toBeCloseTo(42.3492, 3);
    expect(second.text).toMatch(/filed your streetlight outage report for 700 Boylston St in the CityDesk sandbox, reference SB-\d{5}/);
    expect(second.text).toMatch(/nothing was sent to the city/);

    const stored = await h.runtime.sandbox.store.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.attributes).toEqual({ light_condition: 'out' });
    expect(stored[0]!.description).toBe('The streetlight outside is out');
  });

  it('never sends a write to the city: every upstream call in a filing flow is a GET', async () => {
    const h = harness();
    const client = await h.connect();
    await h.call(client, 'report_issue', {
      issue_type: 'graffiti',
      description: 'Graffiti on the wall',
      location: '700 Boylston Street',
    });
    expect((await h.runtime.sandbox.store.list()).length).toBe(1);
    expect(h.calls.length).toBeGreaterThan(0);
    expect(h.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    // Boston's own test endpoint was tried first and found unreachable, as it is in real life.
    expect(h.calls.some((c) => c.url.host === 'boston2-test.spotmobile.net')).toBe(true);
  });

  it('treats a report filed a moment ago as a duplicate, and files again only when told to', async () => {
    const h = harness();
    const client = await h.connect();
    const args = { issue_type: 'graffiti', description: 'Graffiti on the wall', location: '700 Boylston Street' };
    const first = await h.call<IssueResult>(client, 'report_issue', args);
    expect(first.data.outcome).toBe('filed');

    const again = await h.call<IssueResult>(client, 'report_issue', args);
    expect(again.data.outcome).toBe('possible_duplicate');
    expect(again.data.requests[0]!.request_id).toBe(first.data.requests[0]!.request_id);
    expect(again.text).toMatch(/You are already tracking it/);

    const forced = await h.call<IssueResult>(client, 'report_issue', { ...args, file_even_if_duplicate: true });
    expect(forced.data.outcome).toBe('filed');
    expect(await h.runtime.sandbox.store.list()).toHaveLength(2);
  });

  it('caps how many reports one household can file in an hour, and resets the next hour', async () => {
    const h = harness({ config: { maxFilingsPerUserPerHour: 2 } });
    const client = await h.connect('household-0001');
    const args = { issue_type: 'graffiti', description: 'Graffiti', location: '700 Boylston Street', file_even_if_duplicate: true };
    expect((await h.call<IssueResult>(client, 'report_issue', args)).data.outcome).toBe('filed');
    expect((await h.call<IssueResult>(client, 'report_issue', args)).data.outcome).toBe('filed');
    const third = await h.call<ErrorResult>(client, 'report_issue', args);
    expect(third.isError).toBe(true);
    expect(third.data.error).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(third.data.error.details).toHaveProperty('retry_after_seconds');
    expect(await h.runtime.sandbox.store.list()).toHaveLength(2);

    // Another household is not affected, and the first one can file again in the next hour.
    const neighbor = await h.connect('household-0002');
    expect((await h.call<IssueResult>(neighbor, 'report_issue', args)).data.outcome).toBe('filed');
    h.advance(3_600_000);
    expect((await h.call<IssueResult>(client, 'report_issue', args)).data.outcome).toBe('filed');
  });

  it('asks which neighborhood when the address exists in several', async () => {
    const h = harness();
    const client = await h.connect();
    const r = await h.call<IssueResult>(client, 'report_issue', {
      issue_type: 'pothole',
      description: 'Pothole',
      location: '10 Washington Street',
    });
    expect(r.data.outcome).toBe('needs_clarification');
    expect(r.data.clarification?.options).toEqual(['Charlestown', 'Dorchester', 'Hyde Park']);
    expect(r.data.clarification?.field).toBeUndefined();
    expect(r.text).toMatch(/Charlestown, Dorchester or Hyde Park\?/);
  });

  it('asks for a better location when the place cannot be found', async () => {
    const h = harness();
    const client = await h.connect();
    const r = await h.call<IssueResult>(client, 'report_issue', { issue_type: 'pothole', description: 'Pothole', location: 'by the big tree' });
    expect(r.data.outcome).toBe('needs_clarification');
    expect(r.text).toMatch(/could not find "by the big tree" in Boston/);
  });

  it('returns a structured, retryable error and files nothing when the city cannot be reached', async () => {
    const h = harness({ bostonDown: true });
    const client = await h.connect();
    const r = await h.call<ErrorResult>(client, 'report_issue', {
      issue_type: 'pothole',
      description: 'Pothole',
      location: '700 Boylston Street',
    });
    expect(r.isError).toBe(true);
    expect(r.data.outcome).toBe('error');
    expect(r.data.error).toMatchObject({ code: 'upstream_unavailable', retryable: true });
    expect(r.data.as_of).toMatch(/^2026-10-13T12:00:00/);
    expect(r.text).toMatch(/could not reach Boston's service request system/);
    expect(await h.runtime.sandbox.store.list()).toHaveLength(0);
  });

  it('rejects arguments outside the declared schema', async () => {
    const h = harness();
    const client = await h.connect();
    const outcome = await client
      .callTool({ name: 'report_issue', arguments: { issue_type: 'ufo', description: 'x', location: 'y' } })
      .then((r) => (r.isError ? 'rejected' : 'accepted'))
      .catch(() => 'rejected');
    expect(outcome).toBe('rejected');
  });
});

describe('find_nearby_reports', () => {
  it('lists open reports around a place, nearest first, and reports an empty area plainly', async () => {
    const h = harness();
    const client = await h.connect();
    const near = await h.call<IssueResult>(client, 'find_nearby_reports', { issue_type: 'pothole', location: '1079 Commonwealth Avenue', radius_meters: 200 });
    expect(near.data.outcome).toBe('nearby');
    expect(near.data.requests.length).toBeGreaterThanOrEqual(1);
    const distances = near.data.requests.map((r) => r.distance_m!);
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
    expect(near.data.search?.radius_m).toBe(200);

    const none = await h.call<IssueResult>(client, 'find_nearby_reports', { issue_type: 'pothole', location: '700 Boylston Street', radius_meters: 10 });
    expect(none.data.requests).toEqual([]);
    expect(none.text).toMatch(/no open pothole reports within 33 feet of 700 Boylston St/);
  });
});

describe('follow_request, my_requests and request_status across sessions', () => {
  it('remembers a followed report and a filed report, and calls out what changed the next day', async () => {
    const h = harness({ config: { sandboxLifecycle: { assignAfterMs: 120_000, closeAfterMs: 20 * 3_600_000 } } });

    // Day one, first conversation.
    const day1 = await h.connect('household-0001');
    const dupe = await h.call<IssueResult>(day1, 'report_issue', { issue_type: 'pothole', description: 'Pothole', location: '1079 Commonwealth Avenue' });
    const pothole = dupe.data.requests[0]!;
    const followed = await h.call<IssueResult>(day1, 'follow_request', { request_id: pothole.request_id });
    expect(followed.data.outcome).toBe('followed');
    expect(followed.data.requests[0]).toMatchObject({ relation: 'followed', request_id: pothole.request_id });
    expect(followed.data.requests[0]!.relation_since).toMatch(/^2026-10-13T12:00:00/);
    expect(followed.text).toMatch(/now following the pothole report at 1079-1089 Commonwealth Ave, which is open/);

    const light = await h.call<IssueResult>(day1, 'report_issue', {
      issue_type: 'streetlight',
      description: 'Streetlight out',
      location: '700 Boylston Street',
      details: { light_condition: 'Flickering' },
    });
    const lightId = light.data.requests[0]!.request_id;
    await day1.close();

    // The next day, a brand new connection from the same household.
    h.advance(DAY);
    const day2 = await h.connect('household-0001');
    const mine = await h.call<IssueResult>(day2, 'my_requests');
    expect(mine.data.outcome).toBe('requests');
    expect(mine.data.requests.map((r) => r.request_id).sort()).toEqual([pothole.request_id, lightId].sort());
    const byId = new Map(mine.data.requests.map((r) => [r.request_id, r]));
    expect(byId.get(pothole.request_id)).toMatchObject({ relation: 'followed', status: 'open', source: 'production' });
    expect(byId.get(lightId)).toMatchObject({ relation: 'filed', status: 'closed', source: 'sandbox' });
    expect(byId.get(lightId)!.status_notes).toMatch(/Simulated/);
    expect(mine.text).toMatch(/You have 2 requests, and one has changed since you last checked/);
    expect(mine.text).toMatch(/Your street light outage report at 700 Boylston St has been closed/);

    // Asking again reports no further change.
    const again = await h.call<IssueResult>(day2, 'my_requests');
    expect(again.text).toMatch(/^You have 2 requests\. /);
    expect(again.text).toMatch(/is closed/);

    const status = await h.call<IssueResult>(day2, 'request_status', { request_id: lightId });
    expect(status.data.outcome).toBe('status');
    expect(status.data.requests[0]!.timeline.map((s) => [s.label, s.state])).toEqual([
      ['Reported', 'done'],
      ['In progress', 'done'],
      ['Closed', 'current'],
    ]);
    expect(status.text).toMatch(/It was filed yesterday/);

    // A different household sees none of it.
    const neighbor = await h.connect('household-0002');
    const theirs = await h.call<IssueResult>(neighbor, 'my_requests');
    expect(theirs.data.requests).toEqual([]);
    expect(theirs.text).toMatch(/have not filed or followed any requests yet/);
  });

  it('returns structured errors for unknown and malformed request IDs', async () => {
    const h = harness();
    const client = await h.connect();
    const unknown = await h.call<ErrorResult>(client, 'request_status', { request_id: 'boston/00000000-0000-0000-0000-000000000000' });
    expect(unknown.isError).toBe(true);
    expect(unknown.data.error).toMatchObject({ code: 'not_found', retryable: false });

    const malformed = await h.call<ErrorResult>(client, 'follow_request', { request_id: 'nonsense' });
    expect(malformed.isError).toBe(true);
    expect(malformed.data.error.code).toBe('invalid_input');

    const elsewhere = await h.call<ErrorResult>(client, 'follow_request', { request_id: 'gotham/123' });
    expect(elsewhere.data.error.code).toBe('invalid_input');
  });
});

describe('collection_schedule', () => {
  it('answers with weekdays, the next pickup date, and the next two weeks', async () => {
    const h = harness();
    const client = await h.connect();
    const r = await h.call<ScheduleResult>(client, 'collection_schedule', { address: '700 Boylston Street, Boston MA 02116' });
    expect(r.data.outcome).toBe('schedule');
    const s = r.data.schedule!;
    expect(s).toMatchObject({ address: '700 Boylston St', zip_code: '02116', address_id: '156199', time_zone: 'America/New_York' });
    expect(s.trash).toEqual({ weekdays: ['Monday', 'Thursday'], next_date: '2026-10-15' });
    expect(s.recycling).toEqual({ weekdays: ['Monday', 'Thursday'], next_date: '2026-10-15' });
    expect(s.upcoming.map((u) => u.date)).toEqual(['2026-10-15', '2026-10-19', '2026-10-22', '2026-10-26']);
    expect(s.dataset.last_modified).toMatch(/^2026-10-11T/);
    // 2026-10-13 is a Tuesday.
    expect(r.text).toBe(
      'At 700 Boylston St, trash and recycling are both picked up on Mondays and Thursdays. The next pickup is this Thursday, October 15th.',
    );
  });

  it('remembers the address for next time, per household', async () => {
    const h = harness();
    const home = await h.connect('household-0001');
    await h.call(home, 'collection_schedule', { address: '700 Boylston Street' });
    const later = await h.call<ScheduleResult>(await h.connect('household-0001'), 'collection_schedule');
    expect(later.data.schedule?.address).toBe('700 Boylston St');

    const stranger = await h.call<ScheduleResult>(await h.connect('household-0002'), 'collection_schedule');
    expect(stranger.data.outcome).toBe('needs_clarification');
    expect(stranger.text).toBe('What is your street address?');
  });

  it('asks which neighborhood for an address that exists in three, and accepts the answer', async () => {
    const h = harness();
    const client = await h.connect();
    const ask = await h.call<ScheduleResult>(client, 'collection_schedule', { address: '10 Washington Street' });
    expect(ask.data.outcome).toBe('needs_clarification');
    expect(ask.data.clarification?.options).toEqual(['Charlestown', 'Dorchester', 'Hyde Park']);

    const answer = await h.call<ScheduleResult>(client, 'collection_schedule', { address: '10 Washington Street in Charlestown' });
    expect(answer.data.schedule).toMatchObject({ neighborhood: 'Charlestown' });
    // Recycling code "W1A" means Wednesday with a route suffix.
    expect(answer.data.schedule!.trash.weekdays).toEqual(['Wednesday']);
    expect(answer.data.schedule!.recycling.weekdays).toEqual(['Wednesday']);
    expect(answer.text).toMatch(/tomorrow, October 14th/);
  });

  it('collapses unit numbers to the building', async () => {
    const h = harness();
    const client = await h.connect();
    const r = await h.call<ScheduleResult>(client, 'collection_schedule', { address: '1 city hall plaza' });
    expect(r.data.schedule).toMatchObject({ address: '1 City Hall Plz' });
    expect(r.data.schedule!.trash.weekdays).toEqual(['Monday', 'Friday']);
  });

  it('asks again when the address is not in the city records', async () => {
    const h = harness();
    const client = await h.connect();
    const r = await h.call<ScheduleResult>(client, 'collection_schedule', { address: '999999 Nowhere Street' });
    expect(r.data.outcome).toBe('needs_clarification');
    expect(r.isError).toBe(false);
  });
});

describe('errors conform to the declared output schema', () => {
  // Some clients (the MCP Inspector) validate structuredContent against outputSchema even when
  // isError is true, so failures must be valid instances of the same schema as successes.
  it('issue tools: upstream failure, unknown ID and malformed ID all validate strictly', async () => {
    const down = harness({ bostonDown: true });
    const a = await down.call<ErrorResult>(await down.connect(), 'report_issue', { issue_type: 'pothole', description: 'Pothole', location: '700 Boylston Street' });
    const h = harness();
    const client = await h.connect();
    const b = await h.call<ErrorResult>(client, 'request_status', { request_id: 'boston/00000000-0000-0000-0000-000000000000' });
    const c = await h.call<ErrorResult>(client, 'follow_request', { request_id: 'nonsense' });
    for (const r of [a, b, c]) {
      expect(r.isError).toBe(true);
      expect(issueResultSchema.strict().safeParse(r.data).error?.issues ?? []).toEqual([]);
      expect(r.data).toMatchObject({ outcome: 'error', requests: [] });
    }
  });

  it('collection_schedule: an address-records outage is a retryable structured error', async () => {
    const h = harness({ portalDown: true });
    const r = await h.call<ErrorResult>(await h.connect(), 'collection_schedule', { address: '700 Boylston Street' });
    expect(r.isError).toBe(true);
    expect(scheduleResultSchema.strict().safeParse(r.data).error?.issues ?? []).toEqual([]);
    expect(r.data.error).toMatchObject({ code: 'upstream_unavailable', retryable: true });
    expect(r.text).toMatch(/could not reach the city address records/);
  });

  it('every successful result validates strictly too', async () => {
    const h = harness();
    const client = await h.connect();
    const ok = await h.call<IssueResult>(client, 'report_issue', { issue_type: 'pothole', description: 'Pothole', location: '1079 Commonwealth Avenue' });
    expect(issueResultSchema.strict().safeParse(ok.data).error?.issues ?? []).toEqual([]);
    const sched = await h.call<ScheduleResult>(client, 'collection_schedule', { address: '700 Boylston Street' });
    expect(scheduleResultSchema.strict().safeParse(sched.data).error?.issues ?? []).toEqual([]);
  });
});

describe('HTTP surface', () => {
  it('serves health, exposes the sandbox read-only, and protects /mcp', async () => {
    const h = harness();
    const health = await h.app(new Request('http://localhost:8787/healthz'));
    expect(await health.json()).toMatchObject({ ok: true, city: 'boston' });

    const client = await h.connect();
    await h.call(client, 'report_issue', { issue_type: 'graffiti', description: 'Graffiti', location: '700 Boylston Street' });
    const list = await h.app(new Request('http://localhost:8787/sandbox/open311/v2/requests.json'));
    expect(((await list.json()) as unknown[]).length).toBe(1);
    const write = await h.app(
      new Request('http://localhost:8787/sandbox/open311/v2/requests.json', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'service_code=sandbox-pothole&lat=1&long=1',
      }),
    );
    expect(write.status).toBe(405);

    const noToken = await h.app(new Request('http://localhost:8787/mcp', { method: 'POST', body: '{}' }));
    expect(noToken.status).toBe(401);
    const get = await h.app(new Request('http://localhost:8787/mcp', { headers: { authorization: `Bearer ${TOKEN}` } }));
    expect(get.status).toBe(405);
  });
});
