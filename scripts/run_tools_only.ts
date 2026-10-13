/**
 * The demo conversation with the assistant taken out: this script makes the tool calls a correct
 * assistant would make, in order, against a running CityDesk server, and checks each outcome.
 *
 *   pnpm demo:tools
 *
 * It proves the server half of the conversation end to end (real MCP client, Streamable HTTP, live
 * Boston data, the sandbox, per-household memory across two sessions) and records how long each
 * tool call takes. It does NOT involve a model: which tool to call and with what arguments is
 * decided here, not by Bedrock. The full conversation is `pnpm demo:conversation`.
 *
 * Writes results/conversation.tools-only.json.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CityDeskResult, IssueResult, ScheduleResult } from '../apps/citydesk/src/contract.ts';
import { findDemoPlaces, serverFromEnv } from './find_demo_places.ts';

const { mcpUrl, token } = serverFromEnv();
const device = randomUUID();
const waitSeconds = Number(process.env.DEMO_WAIT_SECONDS ?? 130);

async function connect(): Promise<Client> {
  const client = new Client({ name: 'citydesk-tools-only', version: '0.1.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-citydesk-device': device } },
    }),
  );
  return client;
}

interface Step {
  step: string;
  session: number;
  tool: string;
  arguments: Record<string, unknown>;
  expected_outcome: string;
  outcome: string | null;
  is_error: boolean;
  spoken_summary: string;
  request_ids: string[];
  duration_ms: number;
  pass: boolean;
}
const steps: Step[] = [];

async function call<T extends CityDeskResult>(
  client: Client,
  session: number,
  step: string,
  tool: string,
  args: Record<string, unknown>,
  expected: string,
): Promise<T> {
  const t0 = performance.now();
  const result = await client.callTool({ name: tool, arguments: args });
  const duration = Math.round(performance.now() - t0);
  const data = result.structuredContent as unknown as T;
  const outcome = (data as { outcome?: string }).outcome ?? null;
  const entry: Step = {
    step,
    session,
    tool,
    arguments: args,
    expected_outcome: expected,
    outcome,
    is_error: result.isError === true,
    spoken_summary: (data as { spoken_summary?: string }).spoken_summary ?? '',
    request_ids: ((data as Partial<IssueResult>).requests ?? []).map((r) => r.request_id),
    duration_ms: duration,
    pass: outcome === expected,
  };
  steps.push(entry);
  console.log(`${entry.pass ? 'PASS' : 'FAIL'}  ${step}\n      ${tool} -> ${outcome} in ${duration} ms\n      "${entry.spoken_summary}"`);
  return data;
}

const places = await findDemoPlaces(mcpUrl, token);
if (!places.pothole || !places.streetlight) {
  console.error('Could not find suitable places today:', JSON.stringify(places, null, 2));
  process.exit(1);
}
const started = Date.now();
console.log(`Server ${mcpUrl}, device ${device}\n`);

// Session one.
let client = await connect();
const serverInfo = client.getServerVersion();
const protocol = client.getNegotiatedProtocolVersion();
const dupe = await call<IssueResult>(client, 1, 'Pothole report finds an existing report', 'report_issue', {
  issue_type: 'pothole',
  description: "There's a big pothole in front of the building.",
  location: places.pothole.location,
}, 'possible_duplicate');
const existing = dupe.requests?.[0]?.request_id ?? places.pothole.existing_request_id;
await call<IssueResult>(client, 1, 'Resident follows the existing report', 'follow_request', { request_id: existing }, 'followed');

const light = { issue_type: 'streetlight', description: 'There is a problem with the streetlight.', location: places.streetlight.location };
const question = await call<IssueResult>(client, 1, 'Streetlight report needs one answer first', 'report_issue', light, 'needs_clarification');
const field = question.clarification?.field ?? 'light_condition';
const filed = await call<IssueResult>(client, 1, 'With the answer, the report is filed in the sandbox', 'report_issue', {
  ...light,
  details: { [field]: "It's flickering" },
}, 'filed');
const filedId = filed.requests?.[0]?.request_id;
await client.close();

// "The next day": a new connection from the same device, after the sandbox has had time to act.
console.log(`\n      (waiting ${waitSeconds} s, then reconnecting as the same household)\n`);
await new Promise((r) => setTimeout(r, waitSeconds * 1000));
client = await connect();
const mine = await call<IssueResult>(client, 2, 'Status check in a new session', 'my_requests', {}, 'requests');
const remembered = new Set((mine.requests ?? []).map((r) => r.request_id));
const memoryHeld = remembered.has(existing) && filedId !== undefined && remembered.has(filedId);
const filedNow = (mine.requests ?? []).find((r) => r.request_id === filedId);
// By now the server's two-minute cache of Boston's open requests has expired, so this duplicate
// check pays for a fresh download: the slowest a tool call normally gets.
const coldLabel =
  waitSeconds > 120
    ? 'Duplicate check with a cold cache (fresh download from Boston)'
    : 'Duplicate check again (cache still warm: the wait was under two minutes)';
await call<IssueResult>(client, 2, coldLabel, 'find_nearby_reports', {
  issue_type: 'pothole',
  location: places.pothole.location,
}, 'nearby');
const sched = await call<ScheduleResult>(client, 2, 'Trash day for an address', 'collection_schedule', { address: places.trash.address }, 'schedule');
await client.close();

const durations = steps.map((s) => s.duration_ms).sort((a, b) => a - b);
const record = {
  ranAt: new Date().toISOString(),
  what_this_is:
    'The demo conversation at the tool level, with no model involved: the script chose each tool call. It shows the server half works end to end against live data.',
  server: { url: mcpUrl, info: serverInfo ?? null, protocol_version: protocol ?? null },
  device_id: device,
  places,
  wait_seconds_between_sessions: waitSeconds,
  steps,
  checks: {
    all_outcomes_as_expected: steps.every((s) => s.pass),
    both_requests_remembered_in_second_session: memoryHeld,
    filed_request_is_in_sandbox: filed.requests?.[0]?.source === 'sandbox',
    followed_request_is_production_data: dupe.requests?.[0]?.source === 'production',
    sandbox_note_after_wait: filedNow?.status_notes ?? null,
    trash_weekdays: sched.schedule?.trash.weekdays ?? [],
  },
  tool_latency_ms: {
    note: 'Calls that reach Boston take a few hundred milliseconds; a duplicate check right after the place finder ran reuses a cached list; the cold-cache step shows the uncached cost.',
    min: durations[0],
    median: durations[Math.floor(durations.length / 2)],
    max: durations.at(-1),
    by_step: Object.fromEntries(steps.map((s) => [`${s.session}:${s.tool}:${s.expected_outcome}`, s.duration_ms])),
  },
  total_seconds: Math.round((Date.now() - started) / 1000),
};
const ok = record.checks.all_outcomes_as_expected && memoryHeld && record.checks.filed_request_is_in_sandbox;
const out = resolve(import.meta.dirname, '..', 'results', 'conversation.tools-only.json');
mkdirSync(resolve(out, '..'), { recursive: true });
writeFileSync(out, `${JSON.stringify({ ...record, pass: ok }, null, 2)}\n`);
console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${steps.filter((s) => s.pass).length}/${steps.length} steps as expected; memory across sessions: ${memoryHeld}. Saved ${out}`);
process.exit(ok ? 0 : 1);
