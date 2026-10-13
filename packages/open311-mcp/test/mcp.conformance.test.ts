/**
 * Conformance tests for the Streamable HTTP endpoint against MCP spec 2025-11-25, plus interop with
 * the official client SDK in both protocol eras. Everything runs in-process: the handler is called
 * directly with Request objects, and upstream Open311 calls are answered from fixtures.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import {
  BOSTON,
  createMcpHttpHandler,
  createOpen311Server,
  createSandbox,
  sandboxEndpoint,
  toFunctionUrlHandler,
  type CityConfig,
  type McpHttpOptions,
} from '../src/index.ts';
import { fakeFetch, fixture, jsonResponse } from './helpers.ts';

const URL_ = 'http://localhost:8080/mcp';
const TOKEN = 'test-token';
const SPEC = '2025-11-25';

function setup(overrides: Partial<McpHttpOptions> = {}) {
  const upstream = fakeFetch((call) => {
    if (call.url.pathname.endsWith('/services.json')) return jsonResponse(fixture('boston/services.json'));
    if (call.url.pathname.endsWith('/requests.json')) return jsonResponse(fixture('boston/potholes_open.json'));
    return jsonResponse([{ code: 404, description: 'not found' }], 404);
  });
  const sandbox = createSandbox({ generateId: () => 'SB-10001' });
  const cities: Record<string, CityConfig> = {
    boston: { ...BOSTON, test: sandboxEndpoint(sandbox, 'boston-sandbox') },
  };
  const handler = createMcpHttpHandler({
    factory: () => createOpen311Server({ cities, env: {}, clientOptions: { fetch: upstream.fetch, limiters: new Map() } }),
    bearerTokens: [TOKEN],
    allowedOrigins: ['http://localhost:5173', 'app.example.com'],
    ...overrides,
  });
  return { handler, upstream };
}

function post(body: unknown, headers: Record<string, string> = {}, url = URL_): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: SPEC, capabilities: {}, clientInfo: { name: 'conformance', version: '0.0.0' } },
};

type Rpc = { jsonrpc: string; id: number; result?: any; error?: { code: number; message: string } };

describe('Streamable HTTP, spec 2025-11-25 (stateless)', () => {
  it('initialize: negotiates 2025-11-25 and answers in JSON with no session ID', async () => {
    const { handler } = setup();
    const res = await handler(post(initialize));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const body = (await res.json()) as Rpc;
    expect(body).toMatchObject({ jsonrpc: '2.0', id: 1 });
    expect(body.result.protocolVersion).toBe(SPEC);
    expect(body.result.serverInfo).toMatchObject({ name: 'open311-mcp' });
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it('initialize: answers an unknown future version with a version the server supports', async () => {
    const { handler } = setup();
    const res = await handler(post({ ...initialize, params: { ...initialize.params, protocolVersion: '2099-01-01' } }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Rpc).result.protocolVersion).toBe(SPEC);
  });

  it('notifications/initialized: 202 Accepted with no body', async () => {
    const { handler } = setup();
    const res = await handler(post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-protocol-version': SPEC }));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('tools/list: six tools, each with a description and an object input schema', async () => {
    const { handler } = setup();
    const res = await handler(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-protocol-version': SPEC }));
    expect(res.status).toBe(200);
    const tools = ((await res.json()) as Rpc).result.tools as Array<{ name: string; description: string; inputSchema: any }>;
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['create_request', 'get_request', 'get_service_definition', 'list_cities', 'list_services', 'search_requests'].sort(),
    );
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(80);
      expect(tool.description).toMatch(/Returns/);
      expect(tool.inputSchema.type).toBe('object');
    }
    const search = tools.find((t) => t.name === 'search_requests')!;
    expect(search.inputSchema.properties.city.enum).toEqual(['boston']);
    expect(search.inputSchema.required).toContain('city');
  });

  it('tools/call: returns text for the model and structured content with IDs and dates', async () => {
    const { handler, upstream } = setup();
    const res = await handler(
      post(
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'search_requests',
            arguments: { city: 'boston', status: 'open', near: { lat: 42.3525, long: -71.125, radius_meters: 50 } },
          },
        },
        { 'mcp-protocol-version': SPEC },
      ),
    );
    expect(res.status).toBe(200);
    const result = ((await res.json()) as Rpc).result;
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(result.structuredContent.count).toBeGreaterThanOrEqual(1);
    const first = result.structuredContent.requests[0];
    expect(first.service_request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.requested_datetime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(first.distance_m).toBeLessThanOrEqual(50);
    expect(result.structuredContent.as_of).toMatch(/^\d{4}-/);
    expect(upstream.calls[0]!.url.searchParams.get('status')).toBe('open');
  });

  it('tools/call: a failure is a structured error with isError, never a bare flag', async () => {
    const { handler } = setup();
    const call = (args: unknown) =>
      handler(post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_request', arguments: args } }, { 'mcp-protocol-version': SPEC }));
    const missing = ((await (await call({ city: 'boston', service_request_id: 'nope' })).json()) as Rpc).result;
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent.error).toMatchObject({ code: 'not_found', retryable: false });
    expect(missing.content[0].text).toMatch(/not_found/);

    // Arguments that break the declared schema are rejected, not silently accepted.
    const invalid = (await (await call({ city: 'atlantis', service_request_id: 'x' })).json()) as Rpc;
    const rejected = invalid.error !== undefined || invalid.result?.isError === true;
    expect(rejected).toBe(true);
  });

  it('tools/call create_request: files in the sandbox and never calls the city', async () => {
    const { handler, upstream } = setup();
    const res = await handler(
      post(
        {
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: {
            name: 'create_request',
            arguments: { city: 'boston', service_code: 'sandbox-pothole', description: 'Pothole', lat: 42.35, long: -71.07 },
          },
        },
        { 'mcp-protocol-version': SPEC },
      ),
    );
    const result = ((await res.json()) as Rpc).result;
    expect(result.structuredContent).toMatchObject({ service_request_id: 'SB-10001', sandbox: true, endpoint: 'test' });
    expect(result.structuredContent.created_at).toMatch(/^\d{4}-/);
    expect(upstream.calls).toHaveLength(0);
  });

  it('GET and DELETE: 405 with an Allow header, because no SSE stream or session is offered', async () => {
    const { handler } = setup();
    for (const method of ['GET', 'DELETE']) {
      const res = await handler(
        new Request(URL_, { method, headers: { accept: 'text/event-stream', authorization: `Bearer ${TOKEN}` } }),
      );
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toMatch(/POST/);
    }
  });

  it('MCP-Protocol-Version: an unsupported value is a 400', async () => {
    const { handler } = setup();
    const res = await handler(post({ jsonrpc: '2.0', id: 6, method: 'tools/list' }, { 'mcp-protocol-version': '1999-01-01' }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/protocol version/i);
  });

  it('MCP-Protocol-Version: every older supported version is still accepted', async () => {
    const { handler } = setup();
    for (const version of ['2025-06-18', '2025-03-26']) {
      const res = await handler(post({ jsonrpc: '2.0', id: 7, method: 'tools/list' }, { 'mcp-protocol-version': version }));
      expect(res.status).toBe(200);
    }
  });

  it('Accept and Content-Type are enforced', async () => {
    const { handler } = setup();
    const noSse = await handler(post({ jsonrpc: '2.0', id: 8, method: 'tools/list' }, { accept: 'text/html' }));
    expect(noSse.status).toBe(406);
    const notJson = await handler(post({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, { 'content-type': 'text/plain' }));
    expect(notJson.status).toBe(415);
    const garbage = await handler(
      new Request(URL_, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` },
        body: '{not json',
      }),
    );
    expect(garbage.status).toBe(400);
  });

  it('Origin: a disallowed origin is 403, an allowed one gets CORS headers, and no Origin passes', async () => {
    const { handler } = setup();
    const evil = await handler(post(initialize, { origin: 'https://evil.example' }));
    expect(evil.status).toBe(403);
    const opaque = await handler(post(initialize, { origin: 'null' }));
    expect(opaque.status).toBe(403);

    const allowed = await handler(post(initialize, { origin: 'http://localhost:5173' }));
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(allowed.headers.get('access-control-expose-headers')).toMatch(/mcp-session-id/);
    expect(allowed.headers.get('vary')).toMatch(/Origin/);

    const byHostname = await handler(post(initialize, { origin: 'https://app.example.com' }));
    expect(byHostname.status).toBe(200);

    const none = await handler(post(initialize));
    expect(none.status).toBe(200);
    expect(none.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('CORS preflight: answered for allowed origins without a token, refused for others', async () => {
    const { handler } = setup({ extraAllowedHeaders: ['X-CityDesk-Device'] });
    const preflight = (origin: string) =>
      handler(
        new Request(URL_, {
          method: 'OPTIONS',
          headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,mcp-protocol-version' },
        }),
      );
    const ok = await preflight('http://localhost:5173');
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-headers')).toMatch(/authorization/);
    expect(ok.headers.get('access-control-allow-headers')).toMatch(/mcp-protocol-version/);
    expect(ok.headers.get('access-control-allow-headers')).toMatch(/x-citydesk-device/);
    expect((await preflight('https://evil.example')).status).toBe(403);
  });

  it('Bearer auth: missing or wrong tokens are 401 with a WWW-Authenticate challenge', async () => {
    const { handler } = setup();
    const none = await handler(post(initialize, { authorization: '' }));
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toMatch(/^Bearer/);
    const wrong = await handler(post(initialize, { authorization: 'Bearer nope' }));
    expect(wrong.status).toBe(401);
    const basic = await handler(post(initialize, { authorization: 'Basic dGVzdDp0ZXN0' }));
    expect(basic.status).toBe(401);
  });

  it('Bearer auth is skipped only when no tokens are configured', async () => {
    const { handler } = setup({ bearerTokens: [] });
    expect((await handler(post(initialize, { authorization: '' }))).status).toBe(200);
  });

  it('other paths are 404', async () => {
    const { handler } = setup();
    expect((await handler(post(initialize, {}, 'http://localhost:8080/elsewhere'))).status).toBe(404);
  });
});

describe('optional sessions (2025-era clients)', () => {
  it('issues an Mcp-Session-Id, requires it afterwards, and ends the session on DELETE', async () => {
    const { handler } = setup({ sessions: 'memory' });
    const init = await handler(post(initialize));
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const withSession = { 'mcp-session-id': sessionId!, 'mcp-protocol-version': SPEC };

    await handler(post({ jsonrpc: '2.0', method: 'notifications/initialized' }, withSession));
    const list = await handler(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, withSession));
    expect(list.status).toBe(200);
    expect(((await list.json()) as Rpc).result.tools).toHaveLength(6);

    const without = await handler(post({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { 'mcp-protocol-version': SPEC }));
    expect(without.status).toBe(400);
    const unknown = await handler(post({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, { ...withSession, 'mcp-session-id': 'nope' }));
    expect(unknown.status).toBe(404);

    const del = await handler(
      new Request(URL_, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}`, ...withSession } }),
    );
    expect(del.status).toBe(200);
    const after = await handler(post({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, withSession));
    expect(after.status).toBe(404);
  });
});

describe('official client SDK interop', () => {
  async function connect(versionNegotiation?: { mode: 'auto' | { pin: string } }) {
    const { handler } = setup();
    const client = new Client({ name: 'interop', version: '0.0.0' }, versionNegotiation ? { versionNegotiation } : {});
    const transport = new StreamableHTTPClientTransport(new URL(URL_), {
      fetch: (input, init) => handler(new Request(input, init)),
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport);
    return client;
  }

  it('a default (2025 handshake) client initializes at 2025-11-25, lists tools, and calls one', async () => {
    const client = await connect();
    expect(client.getNegotiatedProtocolVersion()).toBe(SPEC);
    expect(client.getServerVersion()?.name).toBe('open311-mcp');
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(6);
    const result = await client.callTool({ name: 'list_cities', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { cities: Array<{ city: string }> }).cities[0]!.city).toBe('boston');
    await client.close();
  });

  it('a client that opts into the 2026-07-28 revision is served by the same endpoint', async () => {
    const client = await connect({ mode: 'auto' });
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(6);
    const result = await client.callTool({ name: 'list_services', arguments: { city: 'boston' } });
    expect((result.structuredContent as { count: number }).count).toBe(6);
    await client.close();
  });
});

describe('AWS Lambda Function URL adapter', () => {
  it('serves initialize from a payload-format-2.0 event', async () => {
    const { handler } = setup();
    const lambda = toFunctionUrlHandler(handler);
    const out = await lambda({
      rawPath: '/mcp',
      rawQueryString: '',
      headers: {
        host: 'abc123.lambda-url.us-east-1.on.aws',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${TOKEN}`,
      },
      body: Buffer.from(JSON.stringify(initialize)).toString('base64'),
      isBase64Encoded: true,
      requestContext: { domainName: 'abc123.lambda-url.us-east-1.on.aws', http: { method: 'POST', sourceIp: '203.0.113.9' } },
    });
    expect(out.statusCode).toBe(200);
    expect(out.isBase64Encoded).toBe(false);
    expect(out.headers['content-type']).toMatch(/application\/json/);
    expect((JSON.parse(out.body) as Rpc).result.protocolVersion).toBe(SPEC);

    const get = await lambda({ rawPath: '/mcp', headers: { authorization: `Bearer ${TOKEN}` }, requestContext: { http: { method: 'GET' } } });
    expect(get.statusCode).toBe(405);
  });
});
