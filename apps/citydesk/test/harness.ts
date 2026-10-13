/**
 * Test harness: the real CityDesk app, driven by the official MCP client over its HTTP handler,
 * with every upstream (Boston Open311, the open-data portal) answered from recorded fixtures.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fakeFetch, fixtureJson, jsonResponse, type RecordedCall } from '../../../packages/open311-mcp/test/helpers.ts';
import { createApp, DEVICE_HEADER } from '../src/app.ts';
import type { CityDeskResult } from '../src/contract.ts';
import { CityDeskRuntime, type RuntimeOptions } from '../src/runtime.ts';
import type { CityDeskServerHooks } from '../src/server.ts';

export const POTHOLE_CODE = '9aaa7721-e212-4d16-a77e-d8f8d2f4ba28';
export const TOKEN = 'test-token';
export const NOW = Date.parse('2026-10-13T12:00:00Z');

type Row = { service_request_id: string; [k: string]: unknown };
const potholes = fixtureJson<Row[]>('boston/potholes_open.json');
const page1 = fixtureJson<Row[]>('boston/requests_page1.json');
const allRows = [...potholes, ...page1];

const ckan = (name: string): string => readFileSync(resolve(import.meta.dirname, 'fixtures/ckan', `${name}.json`), 'utf8');
const EXACT: Record<string, string> = {
  '700 Boylston St': 'exact_700_boylston',
  '10 Washington St': 'exact_10_washington',
  '1079 Commonwealth Ave': 'exact_1079_comm',
  '10 Adams St': 'exact_10_adams',
};

export interface Harness {
  runtime: CityDeskRuntime;
  calls: RecordedCall[];
  /** Moves the clock forward. */
  advance(ms: number): void;
  /** A connected MCP client for one household. */
  connect(device?: string): Promise<Client>;
  /** Calls a tool and returns its structured content, typed. */
  call<T extends CityDeskResult = CityDeskResult>(client: Client, name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; text: string; data: T }>;
  app: (request: Request) => Promise<Response>;
}

export function harness(
  overrides: Partial<RuntimeOptions> & { bostonDown?: boolean; portalDown?: boolean; hooks?: CityDeskServerHooks } = {},
): Harness {
  let t = NOW;
  const { bostonDown, portalDown, hooks, ...runtimeOverrides } = overrides;
  const net = fakeFetch((call) => {
    const { host, pathname, searchParams } = call.url;
    if (host === 'boston2-test.spotmobile.net') {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    }
    if (host === '311.boston.gov') {
      if (bostonDown) return jsonResponse('bad gateway', 503);
      if (pathname.endsWith('/services.json')) return jsonResponse(fixtureJson('boston/services.json'));
      if (pathname.endsWith('/requests.json')) {
        const ids = searchParams.get('service_request_id');
        if (ids) return jsonResponse(allRows.filter((r) => ids.split(',').includes(r.service_request_id)));
        if (searchParams.get('service_code') === POTHOLE_CODE) return jsonResponse(potholes);
        return jsonResponse([]);
      }
      const single = /\/requests\/(.+)\.json$/.exec(pathname);
      if (single) {
        const row = allRows.find((r) => r.service_request_id === decodeURIComponent(single[1]!));
        return row ? jsonResponse([row]) : jsonResponse([{ code: 404, description: 'Service request not found' }], 404);
      }
    }
    if (host === 'data.boston.gov') {
      if (portalDown) throw Object.assign(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      if (pathname.endsWith('/resource_show')) return jsonResponse(ckan('resource_show'));
      const filters = searchParams.get('filters');
      if (filters) {
        const address = (JSON.parse(filters) as { full_address: string }).full_address;
        return jsonResponse(ckan(EXACT[address] ?? 'exact_none'));
      }
      const q = searchParams.get('q');
      if (q) {
        const address = (JSON.parse(q) as { full_address: string }).full_address;
        return jsonResponse(ckan(address === '1 City Hall Plz' ? 'fts_1_city_hall' : 'exact_none'));
      }
    }
    return undefined;
  });

  const runtime = new CityDeskRuntime({
    env: {},
    fetch: net.fetch,
    now: () => t,
    // Fresh rate limiters per test, and sleeping moves the fake clock instead of waiting.
    limiters: new Map(),
    sleep: async (ms) => {
      t += ms;
    },
    ...runtimeOverrides,
  });
  const app = createApp({ runtime, bearerTokens: [TOKEN], allowedOrigins: ['http://localhost:5173'], hooks });

  return {
    runtime,
    calls: net.calls,
    app,
    advance: (ms) => {
      t += ms;
    },
    async connect(device = 'household-0001') {
      const client = new Client({ name: 'citydesk-tests', version: '0.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL('http://localhost:8787/mcp'), {
          fetch: (input, init) => app(new Request(input, init)),
          requestInit: { headers: { authorization: `Bearer ${TOKEN}`, [DEVICE_HEADER]: device } },
        }),
      );
      return client;
    },
    async call(client, name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as Array<{ type: string; text?: string }>;
      return {
        isError: result.isError === true,
        text: content.map((c) => c.text ?? '').join(''),
        data: result.structuredContent as never,
      };
    },
  };
}
