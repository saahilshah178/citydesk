/**
 * Stage 0 smoke test: proves every external dependency is reachable before we build on it.
 *
 *   pnpm smoke
 *
 * Writes results/smoke.json. Exits 0 when every required check passes, 1 otherwise, and always
 * prints a list of what a human has to unblock.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { loadEnv, USER_AGENT } from './lib/env.ts';

loadEnv();

type Status = 'pass' | 'fail' | 'degraded';
interface CheckResult {
  name: string;
  status: Status;
  detail: string;
  ms: number;
  /** What a human must do. Present on every fail, and on degraded checks someone could fix. */
  unblock?: string;
  data?: Record<string, unknown>;
}

const BOSTON = 'https://311.boston.gov/open311/v2';
const BOSTON_DISCOVERY = 'https://311.boston.gov/open311/discovery.json';
const SEECLICKFIX_TEST = 'https://test.seeclickfix.com/open311/v2';
const CKAN = 'https://data.boston.gov/api/3/action';
const TRASH_RESOURCE = 'fee8ee07-b8b5-4ee5-b540-5162590ba5c1';

async function getJson(url: string): Promise<unknown> {
  const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: 'application/json' };
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

function withBostonKey(url: string): string {
  const key = process.env.BOSTON_OPEN311_API_KEY;
  return key ? `${url}${url.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(key)}` : url;
}

async function check(
  name: string,
  fn: () => Promise<Omit<CheckResult, 'name' | 'ms'>>,
): Promise<CheckResult> {
  const started = Date.now();
  try {
    return { name, ...(await fn()), ms: Date.now() - started };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    const code = e.cause?.code ? ` (${e.cause.code})` : '';
    return { name, status: 'fail', detail: `${e.name}: ${e.message}${code}`, ms: Date.now() - started };
  }
}

const checks: Array<() => Promise<CheckResult>> = [
  () =>
    check('boston.services', async () => {
      const services = (await getJson(withBostonKey(`${BOSTON}/services.json`))) as Array<{
        service_name: string;
      }>;
      if (!Array.isArray(services) || services.length === 0) throw new Error('empty service list');
      return {
        status: 'pass',
        detail: `${services.length} fileable services: ${services.map((s) => s.service_name).join(', ')}`,
        data: { count: services.length },
      };
    }),
  () =>
    check('boston.recent_requests', async () => {
      const reqs = (await getJson(withBostonKey(`${BOSTON}/requests.json?per_page=50`))) as Array<{
        requested_datetime: string;
        service_name: string;
      }>;
      if (!Array.isArray(reqs) || reqs.length === 0) throw new Error('no requests returned');
      const newest = reqs.map((r) => r.requested_datetime).sort().at(-1);
      return {
        status: 'pass',
        detail: `${reqs.length} requests, newest ${newest}`,
        data: { count: reqs.length, newest },
      };
    }),
  () =>
    check('boston.test_endpoint', async () => {
      const discovery = (await getJson(BOSTON_DISCOVERY)) as {
        endpoints: Array<{ type: string; url: string }>;
      };
      const test = discovery.endpoints.find((e) => e.type === 'test');
      if (!test) throw new Error('discovery file lists no test endpoint');
      try {
        const services = (await getJson(`${test.url}/services.json`)) as unknown[];
        return {
          status: 'pass',
          detail: `${test.url} answered with ${services.length} services`,
          data: { url: test.url },
        };
      } catch (err) {
        const e = err as Error & { cause?: { code?: string } };
        return {
          status: 'degraded',
          detail: `discovery lists ${test.url} but it is unreachable: ${e.message}${e.cause?.code ? ` (${e.cause.code})` : ''}. Writes use the SeeClickFix sandbox instead.`,
          unblock:
            'Nothing you can fix locally. Boston (or its vendor) would have to restore the test host named in its discovery file.',
          data: { url: test.url },
        };
      }
    }),
  () =>
    check('seeclickfix.sandbox_read', async () => {
      // New Haven, CT: the area where the SeeClickFix test server has request types configured.
      const q = 'lat=41.3083&long=-72.9279';
      const services = (await getJson(`${SEECLICKFIX_TEST}/services.json?${q}`)) as unknown[];
      const reqs = (await getJson(`${SEECLICKFIX_TEST}/requests.json?${q}`)) as unknown[];
      if (!Array.isArray(services) || services.length === 0) throw new Error('sandbox returned no services');
      return {
        status: 'pass',
        detail: `${services.length} sandbox services, ${reqs.length} recent sandbox requests near New Haven`,
        data: { services: services.length, requests: reqs.length },
      };
    }),
  () =>
    check('boston.trash_schedule', async () => {
      const filters = encodeURIComponent(JSON.stringify({ full_address: '1 City Hall Plz' }));
      const body = (await getJson(
        `${CKAN}/datastore_search?resource_id=${TRASH_RESOURCE}&filters=${filters}&limit=1`,
      )) as { success: boolean; result: { records: Array<Record<string, string>> } };
      const rec = body.result?.records?.[0];
      if (!body.success || !rec) throw new Error('no schedule record for 1 City Hall Plz');
      return {
        status: 'pass',
        detail: `${rec.full_address}, ${rec.zip_code}: trash ${rec.trashday}, recycling ${rec.recollect}`,
        data: { trashday: rec.trashday, recollect: rec.recollect },
      };
    }),
  () =>
    check('aws.bedrock_converse', async () => {
      const modelId = process.env.BEDROCK_MODEL_ID;
      if (!modelId) {
        return {
          status: 'fail',
          detail: 'BEDROCK_MODEL_ID is not set',
          unblock: 'Set BEDROCK_MODEL_ID in .env to a Bedrock model or inference profile ID your account can invoke.',
        };
      }
      const region = process.env.AWS_REGION ?? 'us-east-1';
      const client = new BedrockRuntimeClient({ region });
      try {
        const out = await client.send(
          new ConverseCommand({
            modelId,
            messages: [{ role: 'user', content: [{ text: 'Reply with the single word: ready' }] }],
            inferenceConfig: { maxTokens: 20, temperature: 0 },
          }),
        );
        const text = out.output?.message?.content?.map((c) => c.text ?? '').join('') ?? '';
        return {
          status: 'pass',
          detail: `${modelId} in ${region} replied "${text.trim()}"`,
          data: { modelId, region, usage: out.usage, latencyMs: out.metrics?.latencyMs },
        };
      } catch (err) {
        const e = err as Error;
        const noCreds = /credential|Could not load|token/i.test(`${e.name} ${e.message}`);
        return {
          status: 'fail',
          detail: `${e.name}: ${e.message}`,
          unblock: noCreds
            ? 'No AWS credentials found. Install the AWS CLI and run `aws configure` (or `aws sso login`), region us-east-1.'
            : `Check that ${modelId} is enabled for your account in ${region} (Bedrock console, Model access) and that your IAM identity allows bedrock:InvokeModel.`,
        };
      }
    }),
];

const results: CheckResult[] = [];
for (const run of checks) {
  const r = await run();
  results.push(r);
  const mark = r.status === 'pass' ? 'PASS' : r.status === 'degraded' ? 'WARN' : 'FAIL';
  console.log(`${mark}  ${r.name.padEnd(26)} ${String(r.ms).padStart(5)}ms  ${r.detail}`);
}

const failed = results.filter((r) => r.status === 'fail');
const toUnblock = results.filter((r) => r.unblock);
const summary = {
  ranAt: new Date().toISOString(),
  node: process.version,
  passed: results.filter((r) => r.status === 'pass').length,
  degraded: results.filter((r) => r.status === 'degraded').length,
  failed: failed.length,
  results,
};
const outDir = resolve(import.meta.dirname, '..', 'results');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'smoke.json'), `${JSON.stringify(summary, null, 2)}\n`);

console.log(`\n${summary.passed} passed, ${summary.degraded} degraded, ${summary.failed} failed. Saved results/smoke.json`);
if (toUnblock.length > 0) {
  console.log('\nTo unblock:');
  for (const r of toUnblock) console.log(`  - [${r.name}] ${r.unblock}`);
}
process.exit(failed.length > 0 ? 1 : 0);
