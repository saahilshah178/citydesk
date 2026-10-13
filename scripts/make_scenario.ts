/**
 * Writes the demo conversation as a scenario file, using places that are true today.
 *
 *   pnpm demo:scenario            # writes results/conversation.scenario.json
 *   pnpm demo:conversation        # writes it, then runs it through Bedrock and the MCP server
 *
 * The conversation is the one in the project brief: a pothole report that finds an existing report
 * and follows it; a streetlight report that takes one follow-up question and is filed in the
 * sandbox; a status check in a new session; and trash day for an address. The pothole address is
 * picked from Boston's open requests at the moment the script runs (see find_demo_places.ts).
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ScheduleResult } from '../apps/citydesk/src/contract.ts';
import { findDemoPlaces, serverFromEnv } from './find_demo_places.ts';

const WORDS: Record<string, string> = {
  St: 'Street', Ave: 'Avenue', Rd: 'Road', Blvd: 'Boulevard', Dr: 'Drive', Pl: 'Place', Plz: 'Plaza', Sq: 'Square',
  Ct: 'Court', Ter: 'Terrace', Ln: 'Lane', Pkwy: 'Parkway', Hwy: 'Highway', Cir: 'Circle',
};
const DIRECTIONS: Record<string, string> = { E: 'East', W: 'West', N: 'North', S: 'South' };

/** "617 E Third St" as a person would say it: "617 East Third Street". */
function speakable(address: string): string {
  return address
    .split(' ')
    .map((word, i) => (i === 1 && DIRECTIONS[word] ? DIRECTIONS[word] : (WORDS[word] ?? word)))
    .join(' ');
}

const { mcpUrl, token } = serverFromEnv();
const places = await findDemoPlaces(mcpUrl, token);
if (!places.pothole || !places.streetlight) {
  console.error('Could not find suitable places today:', JSON.stringify(places, null, 2));
  process.exit(1);
}

// Ask the server for the real collection days, so the scenario can check the reply against them.
const probe = new Client({ name: 'citydesk-scenario', version: '0.1.0' });
await probe.connect(
  new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-citydesk-device': 'demo-places-probe' } },
  }),
);
const schedule = (await probe.callTool({ name: 'collection_schedule', arguments: { address: places.trash.address } }))
  .structuredContent as unknown as ScheduleResult;
await probe.close();
const trashDay = schedule.schedule?.trash.weekdays[0];
if (!trashDay) {
  console.error(`No collection day found for ${places.trash.address}.`);
  process.exit(1);
}

const pothole = speakable(places.pothole.location);
const streetlight = speakable(places.streetlight.location);
const existingId = places.pothole.existing_request_id.split('/')[1] ?? '';

const scenario = {
  name: 'CityDesk demo conversation',
  description:
    `Generated ${places.checkedAt} against ${places.server}. The pothole turn uses ${places.pothole.location}, where Boston ` +
    `listed an open pothole request (${places.pothole.existing_request_id}, reported ${places.pothole.reported}) when this file was written.`,
  turns: [
    {
      user: `There's a big pothole in front of ${pothole}.`,
      note: 'A real open pothole report exists here, so nothing should be filed.',
      expect: { tool: 'report_issue', outcome: 'possible_duplicate', reply_excludes: [existingId.slice(0, 13)] },
    },
    {
      user: 'Yes, follow that one instead.',
      expect: { tool: 'follow_request', outcome: 'followed' },
    },
    {
      user: `There's also a problem with the streetlight outside ${streetlight}.`,
      note: 'The sandbox service definition has one required question, so the assistant must ask it.',
      expect: { tool: 'report_issue', outcome: 'needs_clarification' },
    },
    {
      user: "It's flickering.",
      note: 'With the answer, the report is filed in the sandbox.',
      expect: { tool: 'report_issue', outcome: 'filed' },
    },
    {
      user: "What's happening with my requests?",
      note: '"The next day": a new session from the same device. The wait lets the sandbox request move to "assigned".',
      new_session: true,
      wait_seconds: 130,
      expect: { tool: 'my_requests', outcome: 'requests' },
    },
    {
      user: `When does the trash go out at ${speakable(places.trash.address)}?`,
      expect: { tool: 'collection_schedule', outcome: 'schedule', reply_includes: [trashDay] },
    },
  ],
};

const out = resolve(import.meta.dirname, '..', 'results', 'conversation.scenario.json');
mkdirSync(resolve(out, '..'), { recursive: true });
writeFileSync(out, `${JSON.stringify(scenario, null, 2)}\n`);
console.log(`Wrote ${out}`);
for (const turn of scenario.turns) console.log(`  ${'new_session' in turn ? '(new session) ' : ''}${turn.user}`);
