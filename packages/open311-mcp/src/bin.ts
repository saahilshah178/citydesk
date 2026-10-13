#!/usr/bin/env node
/**
 * open311-mcp command line entry.
 *
 *   open311-mcp                       stdio transport (for desktop MCP clients)
 *   open311-mcp --http [--port 8080]  Streamable HTTP at /mcp
 *   open311-mcp --cities cities.json  serve your own city list instead of the built-in ones
 *   open311-mcp --sandbox             add "sandbox-city", backed by the in-process Open311 sandbox
 *
 * Environment: MCP_BEARER_TOKENS, MCP_ALLOWED_ORIGINS (comma-separated), PORT, OPEN311_CITIES_FILE,
 * ALLOW_PRODUCTION_WRITES, plus any API key variables your city configs name.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { toNodeListener } from './adapters.ts';
import { BUILT_IN_CITIES, parseCities, type CityConfig } from './cities.ts';
import { createMcpHttpHandler } from './http.ts';
import { createSandbox, sandboxEndpoint } from './sandbox.ts';
import { createOpen311Server } from './server.ts';

const { values } = parseArgs({
  options: {
    http: { type: 'boolean', default: false },
    port: { type: 'string' },
    cities: { type: 'string' },
    sandbox: { type: 'boolean', default: false },
    sessions: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(
    [
      'Usage: open311-mcp [--http] [--port <n>] [--cities <file.json>] [--sandbox] [--sessions]',
      '',
      '  (default)   serve over stdio',
      '  --http      serve Streamable HTTP at /mcp (port from --port or PORT, default 8080)',
      '  --cities    JSON file with your city configs (also OPEN311_CITIES_FILE)',
      '  --sandbox   add a "sandbox-city" whose test endpoint is the built-in Open311 sandbox',
      '  --sessions  with --http: give 2025-era clients in-memory sessions (single process only)',
    ].join('\n'),
  );
  process.exit(0);
}

const list = (value: string | undefined): string[] =>
  (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const citiesFile = values.cities ?? process.env.OPEN311_CITIES_FILE;
const cities: Record<string, CityConfig> = citiesFile
  ? parseCities(JSON.parse(readFileSync(citiesFile, 'utf8')))
  : { ...BUILT_IN_CITIES };

const sandbox = values.sandbox ? createSandbox() : undefined;
if (sandbox) {
  cities['sandbox-city'] = {
    id: 'sandbox-city',
    name: 'Sandbox City',
    timeZone: 'UTC',
    bbox: [-180, -90, 180, 90],
    test: sandboxEndpoint(sandbox),
  };
}

const factory = () => createOpen311Server({ cities });

if (!values.http) {
  serveStdio(factory);
  console.error(`[open311-mcp] serving ${Object.keys(cities).join(', ')} over stdio`);
} else {
  const port = Number(values.port ?? process.env.PORT ?? 8080);
  const tokens = list(process.env.MCP_BEARER_TOKENS);
  const mcp = createMcpHttpHandler({
    factory,
    bearerTokens: tokens,
    allowedOrigins: list(process.env.MCP_ALLOWED_ORIGINS ?? 'localhost,127.0.0.1'),
    sessions: values.sessions ? 'memory' : 'none',
    onerror: (e) => console.error(`[open311-mcp] ${e.message}`),
  });
  const handler = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (sandbox && pathname.startsWith(`${sandbox.basePath}/`)) return sandbox.fetch(request);
    return mcp(request);
  };
  createServer(toNodeListener(handler)).listen(port, () => {
    console.error(`[open311-mcp] serving ${Object.keys(cities).join(', ')} at http://localhost:${port}/mcp`);
    if (tokens.length === 0) console.error('[open311-mcp] MCP_BEARER_TOKENS is empty: authentication is OFF.');
    if (sandbox) console.error(`[open311-mcp] sandbox Open311 API at http://localhost:${port}${sandbox.basePath}`);
  });
}
