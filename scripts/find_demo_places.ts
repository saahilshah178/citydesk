/**
 * Finds real places for the demo conversation, from today's live data.
 *
 *   pnpm demo:places                 # against the local server
 *   MCP_URL=https://.../mcp MCP_TOKEN=... pnpm demo:places
 *
 * The duplicate-and-follow scene needs a spot where a pothole is open right now, and the filing scene
 * needs a spot with no open streetlight report. This script asks Boston for open potholes, then asks
 * the CityDesk server itself (find_nearby_reports, which changes nothing) how it sees each candidate
 * address, so what it prints is what the assistant will get.
 *
 * Prints JSON to stdout: { pothole: {...}, streetlight: {...}, trash: {...} }.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { BOSTON, Open311Client } from 'open311-mcp';
import type { IssueResult } from '../apps/citydesk/src/contract.ts';
import { loadEnv, USER_AGENT } from './lib/env.ts';

loadEnv();

const mcpUrl = process.env.MCP_URL ?? `http://localhost:${process.env.PORT ?? 8787}/mcp`;
const token = process.env.MCP_TOKEN ?? (process.env.MCP_BEARER_TOKENS ?? '').split(',')[0]?.trim() ?? '';
const POTHOLE_CODE = '9aaa7721-e212-4d16-a77e-d8f8d2f4ba28';

const client = new Client({ name: 'citydesk-demo-places', version: '0.1.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-citydesk-device': 'demo-places-probe' } },
  }),
);

async function nearby(issueType: string, location: string): Promise<IssueResult> {
  const result = await client.callTool({ name: 'find_nearby_reports', arguments: { issue_type: issueType, location } });
  return result.structuredContent as unknown as IssueResult;
}

/** "617 E Third St, Boston, MA 02127" becomes "617 E Third St". Ranges and intersections are skipped. */
function streetAddress(address: string | undefined): string | undefined {
  const head = address?.split(',')[0]?.trim();
  return head && /^\d+[A-Za-z]? \S+/.test(head) && !head.includes('&') ? head : undefined;
}

const boston = new Open311Client(BOSTON, { userAgent: USER_AGENT });
const open = await boston.searchRequests({
  serviceCode: POTHOLE_CODE,
  status: 'open',
  startDate: new Date(Date.now() - 14 * 86_400_000),
  limit: 300,
});

let pothole: Record<string, unknown> | undefined;
let checked = 0;
for (const request of open) {
  const address = streetAddress(request.address);
  if (!address || checked >= 12) continue;
  checked++;
  const seen = await nearby('pothole', address);
  const hit = seen.outcome === 'nearby' ? seen.requests.find((r) => r.service_request_id === request.service_request_id) : undefined;
  if (hit) {
    pothole = {
      say: `There's a big pothole in front of ${address}.`,
      location: address,
      existing_request_id: hit.request_id,
      distance_m: hit.distance_m,
      reported: hit.requested_datetime,
      has_photo: hit.media_url !== undefined,
    };
    break;
  }
}

// A well-known address for the filing scene, checked to have no open streetlight report nearby.
let streetlight: Record<string, unknown> | undefined;
for (const address of ['700 Boylston Street', '1 City Hall Plaza', '4 Jersey Street', '100 Huntington Avenue']) {
  const seen = await nearby('streetlight', address);
  if (seen.outcome === 'nearby' && seen.requests.length === 0) {
    streetlight = { say: `The streetlight outside ${address} is out.`, location: address, resolved: seen.resolved_location?.label };
    break;
  }
}

await client.close();
console.log(
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      server: mcpUrl,
      open_potholes_last_14_days: open.length,
      pothole: pothole ?? null,
      streetlight: streetlight ?? null,
      trash: { say: 'When does trash go out at 700 Boylston Street?', address: '700 Boylston Street' },
    },
    null,
    2,
  ),
);
if (!pothole || !streetlight) process.exitCode = 1;
