/**
 * Runs every package's test suite and saves the counts, so the numbers quoted in the README come
 * from a recorded run.
 *
 *   pnpm test:record        # writes results/tests.json; exits 1 if anything failed
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packages = [
  { name: 'open311-mcp', dir: 'packages/open311-mcp', what: 'Open311 client, write guard, sandbox, Streamable HTTP conformance' },
  { name: '@citydesk/server', dir: 'apps/citydesk', what: 'the six tools, duplicate detection, geocoding, stores, cards' },
  { name: '@citydesk/sim-client', dir: 'apps/sim-client', what: 'assistant loop, MCP Apps host, backend limits, scenario runner' },
  { name: '@citydesk/infra', dir: 'infra', what: 'CDK template assertions and IAM scope' },
];

const tmp = mkdtempSync(join(tmpdir(), 'citydesk-tests-'));
const started = Date.now();
const suites = packages.map((pkg) => {
  const outFile = join(tmp, `${pkg.name.replace(/[^a-z0-9]/gi, '_')}.json`);
  const t0 = Date.now();
  const run = spawnSync('pnpm', ['exec', 'vitest', 'run', '--reporter=json', `--outputFile=${outFile}`], {
    cwd: resolve(root, pkg.dir),
    encoding: 'utf8',
  });
  let report: { numTotalTests?: number; numPassedTests?: number; numFailedTests?: number; testResults?: unknown[] } = {};
  try {
    report = JSON.parse(readFileSync(outFile, 'utf8'));
  } catch {
    // No report means the run itself broke; the counts below stay at zero and the exit code says so.
  }
  const result = {
    package: pkg.name,
    covers: pkg.what,
    files: report.testResults?.length ?? 0,
    tests: report.numTotalTests ?? 0,
    passed: report.numPassedTests ?? 0,
    failed: report.numFailedTests ?? 0,
    exit_code: run.status,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
  };
  console.log(`${result.failed === 0 && run.status === 0 ? 'PASS' : 'FAIL'}  ${pkg.name.padEnd(22)} ${result.passed}/${result.tests} tests in ${result.files} files (${result.seconds}s)`);
  return result;
});

const total = {
  tests: suites.reduce((a, s) => a + s.tests, 0),
  passed: suites.reduce((a, s) => a + s.passed, 0),
  failed: suites.reduce((a, s) => a + s.failed, 0),
  files: suites.reduce((a, s) => a + s.files, 0),
};
const pass = suites.every((s) => s.exit_code === 0 && s.failed === 0 && s.tests > 0);
mkdirSync(resolve(root, 'results'), { recursive: true });
writeFileSync(
  resolve(root, 'results', 'tests.json'),
  `${JSON.stringify({ ranAt: new Date().toISOString(), node: process.version, network_calls: 'none: every upstream is a recorded fixture or a fake', suites, total, pass, seconds: Math.round((Date.now() - started) / 1000) }, null, 2)}\n`,
);
console.log(`\n${pass ? 'PASS' : 'FAIL'}  ${total.passed}/${total.tests} tests in ${total.files} files. Saved results/tests.json`);
process.exit(pass ? 0 : 1);
