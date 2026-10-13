/**
 * The development preview server, exercised over real Streamable HTTP with the SDK client, the way
 * an MCP Apps host (ext-apps basic-host) reaches it.
 */
import type { AddressInfo } from 'node:net';
import { getToolUiResourceUri } from '@modelcontextprotocol/ext-apps/app-bridge';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CARD_MIME_TYPE, ISSUE_CARD_URI, SCHEDULE_CARD_URI, STATIC_MAP_TOOL } from '../src/contract.ts';
import { PREVIEW_TOOLS, createPreviewHttpServer } from '../src/cards/preview-server.ts';

function listen(mapMode: string): Promise<{ url: URL; close: () => Promise<void> }> {
  const server = createPreviewHttpServer(mapMode);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: new URL(`http://127.0.0.1:${port}/mcp`),
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

async function connect(url: URL): Promise<Client> {
  const client = new Client({ name: 'citydesk-preview-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

describe('card preview server', () => {
  let server: Awaited<ReturnType<typeof listen>>;
  let client: Client;

  beforeAll(async () => {
    server = await listen('error');
    client = await connect(server.url);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it('lists a preview tool per card state, each linked to its card', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(PREVIEW_TOOLS.length).toBeGreaterThanOrEqual(13);
    for (const preview of PREVIEW_TOOLS) {
      const tool = byName.get(preview.name);
      expect(tool, preview.name).toBeDefined();
      // getToolUiResourceUri is what ext-apps hosts use to find a tool's card.
      expect(getToolUiResourceUri(tool!)).toBe(preview.card);
    }
    expect(new Set(PREVIEW_TOOLS.map((tool) => tool.card))).toEqual(new Set([ISSUE_CARD_URI, SCHEDULE_CARD_URI]));
  });

  it('marks static_map as callable by cards only', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === STATIC_MAP_TOOL);
    expect(tool?._meta).toMatchObject({ ui: { visibility: ['app'] } });
    expect(getToolUiResourceUri(tool!)).toBeUndefined();
  });

  it('serves both cards over HTTP', async () => {
    for (const uri of [ISSUE_CARD_URI, SCHEDULE_CARD_URI]) {
      const { contents } = await client.readResource({ uri });
      expect(contents).toHaveLength(1);
      expect(contents[0]).toMatchObject({ uri, mimeType: CARD_MIME_TYPE });
    }
  });

  it('returns contract-shaped results: spoken text plus structuredContent', async () => {
    const filed = await client.callTool({ name: 'preview_issue_filed', arguments: {} });
    expect(filed.isError).toBeFalsy();
    expect(filed.structuredContent).toMatchObject({
      outcome: 'filed',
      requests: [{ service_name: 'Pothole', source: 'sandbox', address: '1079-1089 Commonwealth Ave, Boston, MA 02215' }],
    });
    expect(filed.content).toEqual([{ type: 'text', text: (filed.structuredContent as { spoken_summary: string }).spoken_summary }]);

    const schedule = await client.callTool({ name: 'preview_schedule', arguments: {} });
    expect(schedule.structuredContent).toMatchObject({
      outcome: 'schedule',
      schedule: {
        address: '700 Boylston St',
        trash: { weekdays: ['Monday', 'Thursday'] },
        recycling: { weekdays: ['Monday', 'Thursday'] },
        time_zone: 'America/New_York',
      },
    });
    // Monday and Thursday pickups: exactly four fall in any 14 consecutive days.
    expect((schedule.structuredContent as { schedule: { upcoming: unknown[] } }).schedule.upcoming).toHaveLength(4);
  });

  it('returns an ErrorResult with isError for the error states', async () => {
    const result = await client.callTool({ name: 'preview_issue_error', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ outcome: 'error', error: { code: 'upstream_unavailable', retryable: true } });
  });

  it('static_map fails with a structured error by default, so cards show their placeholder', async () => {
    const result = await client.callTool({
      name: STATIC_MAP_TOOL,
      arguments: { lat: 42.352443, long: -71.124948, width: 480, height: 320 },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ outcome: 'error', error: { code: 'not_configured' } });
  });
});

describe('card preview server with PREVIEW_STATIC_MAP=png', () => {
  it('static_map returns a PNG image block of the requested size', async () => {
    const server = await listen('png');
    const client = await connect(server.url);
    try {
      const result = await client.callTool({
        name: STATIC_MAP_TOOL,
        arguments: { lat: 42.352443, long: -71.124948, width: 320, height: 208 },
      });
      expect(result.isError).toBeFalsy();
      const [block] = result.content as Array<{ type: string; mimeType?: string; data?: string }>;
      expect(block).toMatchObject({ type: 'image', mimeType: 'image/png' });
      const png = Buffer.from(block!.data!, 'base64');
      expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect(png.readUInt32BE(16)).toBe(320);
      expect(png.readUInt32BE(20)).toBe(208);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
