/**
 * registerCards and cardToolMeta, checked through a real MCP client connected to a real McpServer
 * over the SDK's in-memory transport.
 */
import { RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY, getToolUiResourceUri } from '@modelcontextprotocol/ext-apps/app-bridge';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { CARD_MIME_TYPE, ISSUE_CARD_URI, SCHEDULE_CARD_URI, STATIC_MAP_TOOL } from '../src/contract.ts';
import {
  BOSTON_PHOTO_ORIGIN,
  ISSUE_CARD_HTML,
  SCHEDULE_CARD_HTML,
  cardOnlyToolMeta,
  cardToolMeta,
  registerCards,
  type RegisterCardsOptions,
} from '../src/cards/index.ts';

const open: Array<() => Promise<void>> = [];

async function connect(configure: (server: McpServer) => void): Promise<Client> {
  const server = new McpServer({ name: 'citydesk-test', version: '0.0.0' });
  configure(server);
  const client = new Client({ name: 'citydesk-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

function withCards(options?: RegisterCardsOptions): Promise<Client> {
  return connect((server) => registerCards(server, options));
}

afterEach(async () => {
  while (open.length > 0) await open.pop()!();
});

describe('registerCards', () => {
  it('uses the MCP Apps MIME type from the contract', () => {
    expect(CARD_MIME_TYPE).toBe('text/html;profile=mcp-app');
    expect(RESOURCE_MIME_TYPE).toBe(CARD_MIME_TYPE);
  });

  it('lists both cards with the MCP Apps MIME type', async () => {
    const client = await withCards();
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri).sort()).toEqual([ISSUE_CARD_URI, SCHEDULE_CARD_URI].sort());
    for (const resource of resources) {
      expect(resource.mimeType).toBe(CARD_MIME_TYPE);
      expect(resource.name).toMatch(/^citydesk-(issue|schedule)-card$/);
      expect(resource.description).toBeTruthy();
    }
  });

  it('reads each card back with its URI, MIME type and HTML', async () => {
    const client = await withCards();
    for (const [uri, html] of [
      [ISSUE_CARD_URI, ISSUE_CARD_HTML],
      [SCHEDULE_CARD_URI, SCHEDULE_CARD_HTML],
    ] as const) {
      const { contents } = await client.readResource({ uri });
      expect(contents).toHaveLength(1);
      const [content] = contents;
      expect(content?.uri).toBe(uri);
      expect(content?.mimeType).toBe(CARD_MIME_TYPE);
      expect(content && 'text' in content ? content.text : undefined).toBe(html);
    }
  });

  it('declares the photo origin for the issue card, on the listing and on the content item', async () => {
    const client = await withCards();
    const { resources } = await client.listResources();
    const listed = resources.find((resource) => resource.uri === ISSUE_CARD_URI);
    const expected = { ui: { csp: { resourceDomains: [BOSTON_PHOTO_ORIGIN] }, prefersBorder: true } };
    expect(BOSTON_PHOTO_ORIGIN).toBe('https://spot-boston-res.cloudinary.com');
    expect(listed?._meta).toEqual(expected);
    const { contents } = await client.readResource({ uri: ISSUE_CARD_URI });
    expect(contents[0]?._meta).toEqual(expected);
  });

  it('asks for no outside origin for the schedule card', async () => {
    const client = await withCards();
    const { resources } = await client.listResources();
    const expected = { ui: { prefersBorder: true } };
    expect(resources.find((resource) => resource.uri === SCHEDULE_CARD_URI)?._meta).toEqual(expected);
    const { contents } = await client.readResource({ uri: SCHEDULE_CARD_URI });
    expect(contents[0]?._meta).toEqual(expected);
  });

  it('accepts other photo origins', async () => {
    const client = await withCards({ photoOrigins: ['https://photos.example.gov', BOSTON_PHOTO_ORIGIN] });
    const { contents } = await client.readResource({ uri: ISSUE_CARD_URI });
    expect(contents[0]?._meta).toEqual({
      ui: { csp: { resourceDomains: ['https://photos.example.gov', BOSTON_PHOTO_ORIGIN] }, prefersBorder: true },
    });
  });

  it('refuses to register the cards twice on one server', () => {
    const server = new McpServer({ name: 'citydesk-test', version: '0.0.0' });
    registerCards(server);
    expect(() => registerCards(server)).toThrow();
  });
});

describe('cardToolMeta', () => {
  it('links a tool to a card with the nested key and the legacy flat key', () => {
    expect(cardToolMeta(ISSUE_CARD_URI)).toEqual({
      ui: { resourceUri: ISSUE_CARD_URI },
      [RESOURCE_URI_META_KEY]: ISSUE_CARD_URI,
    });
    expect(RESOURCE_URI_META_KEY).toBe('ui/resourceUri');
  });

  it('survives tools/list and is what an ext-apps host resolves the card from', async () => {
    const client = await connect((server) => {
      registerCards(server);
      server.registerTool(
        'collection_schedule',
        { description: 'test tool', _meta: cardToolMeta(SCHEDULE_CARD_URI) },
        () => ({ content: [{ type: 'text', text: 'ok' }] }),
      );
      server.registerTool(
        STATIC_MAP_TOOL,
        { description: 'test tool', _meta: cardOnlyToolMeta() },
        () => ({ content: [{ type: 'text', text: 'ok' }] }),
      );
    });
    const { tools } = await client.listTools();
    const schedule = tools.find((tool) => tool.name === 'collection_schedule');
    expect(schedule?._meta).toEqual(cardToolMeta(SCHEDULE_CARD_URI));
    expect(getToolUiResourceUri(schedule!)).toBe(SCHEDULE_CARD_URI);

    const map = tools.find((tool) => tool.name === STATIC_MAP_TOOL);
    expect(map?._meta).toEqual({ ui: { visibility: ['app'] } });
    expect(getToolUiResourceUri(map!)).toBeUndefined();

    // The card a tool links to is one the same server can serve.
    const { contents } = await client.readResource({ uri: getToolUiResourceUri(schedule!)! });
    expect(contents[0]?.mimeType).toBe(CARD_MIME_TYPE);
  });
});
