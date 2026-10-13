import { describe, expect, it } from 'vitest';
import { DEVICE_HEADER, McpSession, UI_EXTENSION_ID, UI_RESOURCE_MIME_TYPE } from '../src/mcp/session.ts';
import { compact, TrafficLog } from '../src/mcp/traffic.ts';

const DEVICE = '0b9d4f6e-1c2a-4d3b-8e5f-6a7b8c9d0e1f';

interface Seen {
  httpMethod: string;
  rpcMethod: string | undefined;
  authorization: string | null;
  device: string | null;
  params: unknown;
}

/**
 * A stand-in MCP server at the HTTP level: the real v2 client and transport run against it, so
 * these tests cover the actual handshake and the headers that really leave the transport.
 */
function fakeServer(options: { failTool?: boolean } = {}) {
  const seen: Seen[] = [];
  const results: Record<string, unknown> = {
    initialize: {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'fake-citydesk', version: '9.9.9' },
    },
    'tools/list': {
      tools: [
        {
          name: 'report_issue',
          description: 'Report a city issue.',
          inputSchema: { type: 'object', properties: {} },
          _meta: { ui: { resourceUri: 'ui://citydesk/issue-card.html' } },
        },
        { name: 'static_map', inputSchema: { type: 'object', properties: {} }, _meta: { ui: { visibility: ['app'] } } },
      ],
    },
    'resources/list': {
      resources: [{ uri: 'ui://citydesk/issue-card.html', name: 'Issue card', mimeType: UI_RESOURCE_MIME_TYPE }],
    },
    'tools/call': options.failTool
      ? { isError: true, content: [{ type: 'text', text: 'not found' }] }
      : { content: [{ type: 'text', text: 'Filed.' }], structuredContent: { outcome: 'filed' } },
    'resources/read': {
      contents: [{ uri: 'ui://citydesk/issue-card.html', mimeType: UI_RESOURCE_MIME_TYPE, text: '<!doctype html><p>card</p>' }],
    },
  };

  const fetchFn = async (_url: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const httpMethod = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { id?: number; method?: string; params?: unknown }) : undefined;
    seen.push({
      httpMethod,
      rpcMethod: body?.method,
      authorization: headers.get('authorization'),
      device: headers.get(DEVICE_HEADER),
      params: body?.params,
    });
    // No standalone event stream and no session to delete: both are optional for a server.
    if (httpMethod !== 'POST') return new Response(null, { status: 405 });
    if (body?.id === undefined) return new Response(null, { status: 202 });
    const result = results[body.method ?? ''];
    const payload = result
      ? { jsonrpc: '2.0', id: body.id, result }
      : { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } };
    return Response.json(payload);
  };
  return { fetchFn, seen };
}

describe('McpSession over Streamable HTTP', () => {
  it('performs initialize, tools/list and tools/call with the token and device on every request', async () => {
    const { fetchFn, seen } = fakeServer();
    const session = await McpSession.connect({
      url: 'http://mcp.test/mcp',
      token: 'secret-token',
      deviceId: DEVICE,
      fetch: fetchFn,
    });

    expect(session.serverInfo).toEqual({ name: 'fake-citydesk', version: '9.9.9' });
    expect(session.protocolVersion).toBe('2025-11-25');
    expect(session.tools.map((tool) => tool.name)).toEqual(['report_issue', 'static_map']);
    expect([...session.resources.keys()]).toEqual(['ui://citydesk/issue-card.html']);

    const result = await session.callTool('report_issue', { issue_type: 'pothole' }, { origin: 'assistant' });
    expect(result.structuredContent).toEqual({ outcome: 'filed' });
    await session.readResource('ui://citydesk/issue-card.html', { origin: 'app' });
    await session.close();

    const rpc = seen.map((request) => request.rpcMethod).filter(Boolean);
    expect(rpc).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'resources/list', 'tools/call', 'resources/read']);
    expect(seen.length).toBeGreaterThanOrEqual(6);
    for (const request of seen) {
      expect(request.authorization).toBe('Bearer secret-token');
      expect(request.device).toBe(DEVICE);
    }

    // The handshake announces MCP Apps support, and tools/call carries the arguments unchanged.
    const initialize = seen.find((request) => request.rpcMethod === 'initialize')?.params as {
      capabilities: { extensions?: Record<string, unknown> };
      clientInfo: { name: string };
    };
    expect(initialize.capabilities.extensions?.[UI_EXTENSION_ID]).toEqual({ mimeTypes: [UI_RESOURCE_MIME_TYPE] });
    expect(initialize.clientInfo.name).toBe('citydesk-sim-client');
    expect(seen.find((request) => request.rpcMethod === 'tools/call')?.params).toMatchObject({
      name: 'report_issue',
      arguments: { issue_type: 'pothole' },
    });
  });

  it('sends no Authorization header when there is no token', async () => {
    const { fetchFn, seen } = fakeServer();
    const session = await McpSession.connect({ url: 'http://mcp.test/mcp', deviceId: DEVICE, fetch: fetchFn });
    await session.close();
    expect(seen.every((request) => request.authorization === null)).toBe(true);
    expect(seen.every((request) => request.device === DEVICE)).toBe(true);
  });

  it('records the real traffic with arguments, results, origins and timing', async () => {
    const { fetchFn } = fakeServer();
    let clock = 1_000;
    const log = new TrafficLog(() => (clock += 7));
    const session = await McpSession.connect({ url: 'http://mcp.test/mcp', deviceId: DEVICE, fetch: fetchFn, log });
    await session.callTool('report_issue', { issue_type: 'pothole' }, { origin: 'manual' });
    await session.close();

    const entries = log.getSnapshot();
    expect(entries.map((entry) => `${entry.direction} ${entry.method} ${entry.status}`)).toEqual([
      'out initialize ok',
      'out notifications/initialized sent',
      'out tools/list ok',
      'out resources/list ok',
      'out tools/call ok',
    ]);
    const call = entries.at(-1);
    expect(call).toMatchObject({
      kind: 'request',
      target: 'report_issue',
      origin: 'manual',
      params: { name: 'report_issue', arguments: { issue_type: 'pothole' } },
      result: { structuredContent: { outcome: 'filed' } },
    });
    expect(call?.durationMs).toBeGreaterThan(0);
    expect(entries[0]?.origin).toBe('host');
  });

  it('marks tool errors and failed requests in the log', async () => {
    const { fetchFn } = fakeServer({ failTool: true });
    const log = new TrafficLog();
    const session = await McpSession.connect({ url: 'http://mcp.test/mcp', deviceId: DEVICE, fetch: fetchFn, log });

    const result = await session.callTool('report_issue', {});
    expect(result.isError).toBe(true);
    expect(log.getSnapshot().at(-1)?.status).toBe('tool_error');
    await session.close();
  });

  it('rejects when the server cannot be reached', async () => {
    const log = new TrafficLog();
    const unreachable = async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    };
    await expect(
      McpSession.connect({ url: 'http://mcp.test/mcp', deviceId: DEVICE, fetch: unreachable, log }),
    ).rejects.toThrow();
    expect(log.getSnapshot()[0]).toMatchObject({ method: 'initialize', status: 'error' });
  });
});

describe('TrafficLog', () => {
  it('notifies subscribers and returns a new snapshot only when something changed', () => {
    const log = new TrafficLog();
    let notified = 0;
    const unsubscribe = log.subscribe(() => (notified += 1));
    const before = log.getSnapshot();
    expect(log.getSnapshot()).toBe(before);

    log.outgoing({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(notified).toBe(1);
    expect(log.getSnapshot()).not.toBe(before);

    unsubscribe();
    log.clear();
    expect(notified).toBe(1);
    expect(log.getSnapshot()).toEqual([]);
  });

  it('shortens oversized payloads for display', () => {
    const shortened = compact({ html: 'x'.repeat(5_000), list: Array.from({ length: 45 }, (_, i) => i), ok: 'short' }) as {
      html: string;
      list: unknown[];
      ok: string;
    };
    expect(shortened.html).toContain('[5000 characters]');
    expect(shortened.html.length).toBeLessThan(200);
    expect(shortened.list).toHaveLength(41);
    expect(shortened.list.at(-1)).toBe('[5 more items]');
    expect(shortened.ok).toBe('short');
  });
});
