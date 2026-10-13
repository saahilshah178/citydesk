/**
 * Checks that the numbers quoted in README.md and docs/submission.md are the numbers in results/.
 * Each claim is built from a results file and must appear in the documents that quote it.
 *
 *   pnpm check:claims        # exits 1 and lists what is out of date
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const json = <T>(file: string): T => JSON.parse(readFileSync(resolve(root, 'results', file), 'utf8')) as T;
const n = (value: number): string => value.toLocaleString('en-US');
const pct = (value: number): string => `${value.toFixed(1)}%`;

interface Group { label: string; replayed: number; matched: number; percent: number }
interface Service { service_name: string; replayed: number; matched: number; percent: number; still_open_today_percent: number }
const dupes = json<{
  replay_period: { from: string; to: string };
  requests: { replayed_with_coordinates_and_service: number };
  matched: { count: number; percent_of_replayed: number };
  groups: Group[];
  by_service: Service[];
  sensitivity: { by_radius_m: Array<{ radius_m: number; percent: number }> };
}>('dupes.json');
const tests = json<{ total: { tests: number; passed: number; files: number }; suites: Array<{ package: string; tests: number }> }>('tests.json');
const index = json<{ source_rows: number; buildings_indexed: number }>('address_index.json');
const bundles = json<{ checks: Array<{ pass: boolean }>; bundles: { mcp: { bytes: number; cold_load_ms: number } } }>('bundle_check.json');
const smoke = json<{ passed: number; degraded: number; failed: number }>('smoke.json');
const toolsOnly = json<{ pass: boolean; steps: Array<{ tool: string; expected_outcome: string; duration_ms: number; pass: boolean }> }>('conversation.tools-only.json');

const group = (prefix: string): Group => dupes.groups.find((g) => g.label.startsWith(prefix))!;
const service = (name: string): Service => dupes.by_service.find((s) => s.service_name === name)!;
const radius = (m: number): number => dupes.sensitivity.by_radius_m.find((r) => r.radius_m === m)!.percent;
const infra = group('Fixed infrastructure');
const noParking = group('Everything except');
const parking = service('Illegal Parking');
const pothole = service('Pothole');
const light = service('Street Light Outage');
const cold = toolsOnly.steps.find((s) => s.tool === 'find_nearby_reports')!;
const suite = (name: string): number => tests.suites.find((s) => s.package === name)!.tests;
const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

type Doc = 'README.md' | 'docs/submission.md';
const claims: Array<{ what: string; text: string; docs: Doc[] }> = [
  { what: 'requests replayed', text: n(dupes.requests.replayed_with_coordinates_and_service), docs: ['README.md', 'docs/submission.md'] },
  { what: 'replay start date', text: dupes.replay_period.from, docs: ['README.md', 'docs/submission.md'] },
  { what: 'replay end date', text: dupes.replay_period.to, docs: ['README.md', 'docs/submission.md'] },
  { what: 'overall matches', text: n(dupes.matched.count), docs: ['README.md'] },
  { what: 'overall share', text: pct(dupes.matched.percent_of_replayed), docs: ['README.md'] },
  { what: 'infrastructure replayed', text: n(infra.replayed), docs: ['README.md'] },
  { what: 'infrastructure matches', text: n(infra.matched), docs: ['README.md'] },
  { what: 'infrastructure share', text: pct(infra.percent), docs: ['README.md', 'docs/submission.md'] },
  { what: 'pothole counts', text: `| ${n(pothole.replayed)} | ${n(pothole.matched)} | ${pct(pothole.percent)} |`, docs: ['README.md'] },
  { what: 'pothole share', text: pct(pothole.percent), docs: ['docs/submission.md'] },
  { what: 'streetlight counts', text: `| ${n(light.replayed)} | ${n(light.matched)} | ${pct(light.percent)} |`, docs: ['README.md'] },
  { what: 'excluding illegal parking', text: `| ${n(noParking.replayed)} | ${n(noParking.matched)} | ${pct(noParking.percent)} |`, docs: ['README.md'] },
  { what: 'illegal parking share', text: pct(parking.percent), docs: ['README.md'] },
  { what: 'illegal parking still open', text: `${Math.round(parking.still_open_today_percent)}%`, docs: ['README.md'] },
  { what: 'share at 25 m', text: `${pct(radius(25))} at 25 m`, docs: ['README.md'] },
  { what: 'share at 100 m', text: `${pct(radius(100))} at 100 m`, docs: ['README.md'] },
  { what: 'tests passing', text: `${tests.total.passed} of ${tests.total.tests} pass in ${tests.total.files} files`, docs: ['README.md'] },
  { what: 'test total in the status table', text: `${tests.total.tests} automated tests`, docs: ['README.md'] },
  { what: 'open311-mcp test count', text: `${suite('open311-mcp')} tests`, docs: ['docs/submission.md'] },
  { what: 'infra test count', text: `${suite('@citydesk/infra')} template tests`, docs: ['docs/submission.md'] },
  { what: 'buildings indexed', text: n(index.buildings_indexed), docs: ['README.md'] },
  { what: 'address rows', text: n(index.source_rows), docs: ['README.md'] },
  { what: 'bundle checks', text: `${bundles.checks.filter((c) => c.pass).length} of ${bundles.checks.length} checks`, docs: ['README.md'] },
  { what: 'MCP bundle size', text: `${(bundles.bundles.mcp.bytes / 1e6).toFixed(1)} MB`, docs: ['README.md'] },
  { what: 'MCP bundle cold load', text: `cold load ${bundles.bundles.mcp.cold_load_ms} ms`, docs: ['README.md'] },
  { what: 'smoke summary', text: `${smoke.passed} pass, ${smoke.degraded} degraded`, docs: ['README.md'] },
  { what: 'tool calls in the tools-only run', text: `${words[toolsOnly.steps.length]![0]!.toUpperCase()}${words[toolsOnly.steps.length]!.slice(1)} tool calls`, docs: ['README.md'] },
  { what: 'cold duplicate check', text: `${n(cold.duration_ms)} ms`, docs: ['README.md'] },
  {
    what: 'latency of the calls that reach Boston',
    text: `${toolsOnly.steps.find((s) => s.tool === 'follow_request')!.duration_ms} and ${toolsOnly.steps.find((s) => s.tool === 'my_requests')!.duration_ms} ms`,
    docs: ['README.md'],
  },
];

const failures: string[] = [];
if (tests.total.passed !== tests.total.tests) failures.push('results/tests.json records failing tests.');
if (!toolsOnly.pass) failures.push('results/conversation.tools-only.json records a failed run.');
const docs = new Map<Doc, string>();
for (const claim of claims) {
  for (const doc of claim.docs) {
    if (!docs.has(doc)) docs.set(doc, readFileSync(resolve(root, doc), 'utf8'));
    if (!docs.get(doc)!.includes(claim.text)) failures.push(`${doc}: ${claim.what} should read "${claim.text}" (from results/).`);
  }
}
// Placeholders that must not survive into a commit.
for (const [doc, text] of docs) {
  for (const marker of ['COLD_MS', 'TODO(app)']) if (text.includes(marker)) failures.push(`${doc}: still contains the placeholder ${marker}.`);
}

if (failures.length > 0) {
  console.error(`${failures.length} claim(s) out of date:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(`All ${claims.length} quoted numbers in README.md and docs/submission.md match results/.`);
