/**
 * Loads the two Lambda bundles that `make synth` (or `make deploy`) produced, exactly as Lambda would,
 * and sends them Function URL events. No AWS account is involved: the MCP function runs with the
 * in-memory store and the client API is only asked for its config.
 *
 *   BEDROCK_MODEL_ID=<any id> make synth && pnpm check:bundles
 *
 * It answers "will the thing we are about to upload start and serve MCP?" before a deploy.
 * Writes results/bundle_check.json.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'infra', 'cdk.out');
if (!existsSync(out)) {
  console.error('infra/cdk.out not found. Run `make synth` first (it needs BEDROCK_MODEL_ID but no credentials).');
  process.exit(2);
}

/** The asset directory whose bundled handler contains a marker string. */
function findBundle(marker) {
  for (const dir of readdirSync(out).filter((d) => d.startsWith('asset.'))) {
    const file = resolve(out, dir, 'index.mjs');
    if (existsSync(file) && readFileSync(file, 'utf8').includes(marker)) return { dir: resolve(out, dir), file };
  }
  throw new Error(`No bundle containing "${marker}" in infra/cdk.out`);
}
const mcpBundle = findBundle('citydesk-sandbox');
const apiBundle = findBundle('DEMO_DAILY_REQUEST_CAP');

// The settings the functions would have, minus anything that needs AWS.
Object.assign(process.env, {
  MCP_BEARER_TOKENS: 'bundle-check-token',
  CITYDESK_STORE: 'memory',
  LOCATION_PLACE_INDEX: '',
  CITYDESK_SSM_PREFIX: '',
  CITYDESK_TABLE: '',
  AWS_EC2_METADATA_DISABLED: 'true',
  BEDROCK_MODEL_ID: process.env.BEDROCK_MODEL_ID ?? 'example.test-model-v1:0',
  MCP_URL: '/mcp',
});

const host = 'bundle-check.lambda-url.us-east-1.on.aws';
const event = (method, path, body, headers = {}) => ({
  version: '2.0',
  rawPath: path,
  rawQueryString: '',
  headers: { host, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  requestContext: { domainName: host, http: { method, path, sourceIp: '203.0.113.9' } },
  body: body === undefined ? null : JSON.stringify(body),
  isBase64Encoded: false,
});
const auth = { authorization: 'Bearer bundle-check-token', 'x-citydesk-device': 'bundle-check-0001', 'mcp-protocol-version': '2025-11-25' };
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
};
const timed = async (fn) => {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - t0) };
};

const quiet = console.log;
console.log = (...args) => (typeof args[0] === 'string' && args[0].startsWith('{"event"') ? undefined : quiet(...args));

const mcpLoad = await timed(() => import(pathToFileURL(mcpBundle.file).href));
const mcp = mcpLoad.value;
check('MCP bundle loads', typeof mcp.handler === 'function', `${(statSync(mcpBundle.file).size / 1e6).toFixed(1)} MB, cold load ${mcpLoad.ms} ms`);
const indexFile = resolve(mcpBundle.dir, 'addresses.json.gz');
check('address index is packaged', existsSync(indexFile), existsSync(indexFile) ? `${(statSync(indexFile).size / 1e6).toFixed(1)} MB beside the handler` : 'missing: run `pnpm sync:addresses` before synth');

const init = await timed(() => mcp.handler(event('POST', '/mcp', rpc(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'bundle-check', version: '0' } }), auth)));
const initBody = JSON.parse(init.value.body);
check('initialize', init.value.statusCode === 200 && initBody.result?.protocolVersion === '2025-11-25', `HTTP ${init.value.statusCode}, protocol ${initBody.result?.protocolVersion}, ${initBody.result?.serverInfo?.name} ${initBody.result?.serverInfo?.version}, ${init.ms} ms`);

const list = await timed(() => mcp.handler(event('POST', '/mcp', rpc(2, 'tools/list'), auth)));
const tools = JSON.parse(list.value.body).result?.tools ?? [];
check('tools/list', tools.length === 7, `${tools.length} tools (${tools.map((t) => t.name).join(', ')}), ${list.ms} ms`);

const sched = await timed(() => mcp.handler(event('POST', '/mcp', rpc(3, 'tools/call', { name: 'collection_schedule', arguments: { address: '700 Boylston Street' } }), auth)));
const schedResult = JSON.parse(sched.value.body).result;
check('tools/call collection_schedule', schedResult?.structuredContent?.outcome === 'schedule', `"${schedResult?.content?.[0]?.text}" in ${sched.ms} ms`);

const card = await mcp.handler(event('POST', '/mcp', rpc(4, 'resources/read', { uri: 'ui://citydesk/issue-card.html' }), auth));
const cardContent = JSON.parse(card.body).result?.contents?.[0];
check('resources/read issue card', cardContent?.mimeType === 'text/html;profile=mcp-app', `${cardContent?.mimeType}, ${cardContent?.text?.length} characters`);

const get = await mcp.handler(event('GET', '/mcp', undefined, auth));
check('GET /mcp is 405', get.statusCode === 405, `HTTP ${get.statusCode}`);
const anonymous = await mcp.handler(event('POST', '/mcp', rpc(5, 'tools/list'), {}));
check('no token is 401', anonymous.statusCode === 401, `HTTP ${anonymous.statusCode}`);
const evil = await mcp.handler(event('POST', '/mcp', rpc(6, 'tools/list'), { ...auth, origin: 'https://evil.example' }));
check('foreign Origin is 403', evil.statusCode === 403, `HTTP ${evil.statusCode}`);

const apiLoad = await timed(() => import(pathToFileURL(apiBundle.file).href));
const api = apiLoad.value;
check('client API bundle loads', typeof api.handler === 'function', `${(statSync(apiBundle.file).size / 1e6).toFixed(1)} MB, cold load ${apiLoad.ms} ms`);
const config = await api.handler(event('GET', '/api/config'));
const configBody = JSON.parse(config.body);
check('GET /api/config', config.statusCode === 200 && configBody.mcpUrl === '/mcp', `HTTP ${config.statusCode}, mcpUrl ${configBody.mcpUrl}, model ${configBody.modelId}`);

console.log = quiet;
const pass = checks.every((c) => c.pass);
const record = {
  ranAt: new Date().toISOString(),
  node: process.version,
  what_this_is: 'The bundles from infra/cdk.out loaded locally and sent Function URL events. No AWS calls.',
  bundles: {
    mcp: { bytes: statSync(mcpBundle.file).size, cold_load_ms: mcpLoad.ms },
    client_api: { bytes: statSync(apiBundle.file).size, cold_load_ms: apiLoad.ms },
    address_index_bytes: existsSync(indexFile) ? statSync(indexFile).size : null,
  },
  checks,
  pass,
};
mkdirSync(resolve(root, 'results'), { recursive: true });
writeFileSync(resolve(root, 'results', 'bundle_check.json'), `${JSON.stringify(record, null, 2)}\n`);
console.log(`\n${pass ? 'PASS' : 'FAIL'}  ${checks.filter((c) => c.pass).length}/${checks.length} checks. Saved results/bundle_check.json`);
process.exit(pass ? 0 : 1);
