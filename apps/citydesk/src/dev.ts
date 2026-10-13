/**
 * Local CityDesk server: `pnpm dev:server`. Reads .env from the repo root.
 * Uses the in-memory store (persisted to .citydesk/store.json) unless CITYDESK_STORE=dynamodb.
 */
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { toNodeListener } from 'open311-mcp';
import { createApp } from './app.ts';
import { buildRuntime } from './bootstrap.ts';

const root = resolve(import.meta.dirname, '..', '..', '..');
const envFile = resolve(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const list = (value: string | undefined): string[] => (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const port = Number(process.env.PORT ?? 8787);
const tokens = list(process.env.MCP_BEARER_TOKENS);

const { runtime, hooks, summary } = await buildRuntime({
  env: process.env,
  memoryFile: resolve(root, '.citydesk', 'store.json'),
  addressIndexPaths: [resolve(root, '.citydesk', 'addresses.json.gz')],
  log: (event, data) => console.error(`[citydesk] ${event}${data ? ` ${JSON.stringify(data)}` : ''}`),
});

const app = createApp({
  runtime,
  hooks,
  bearerTokens: tokens,
  allowedOrigins: list(process.env.MCP_ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173'),
  sessions: process.env.MCP_SESSIONS === 'memory' ? 'memory' : 'none',
});

createServer(toNodeListener(app)).listen(port, () => {
  console.error(`[citydesk] MCP endpoint   http://localhost:${port}/mcp`);
  console.error(`[citydesk] sandbox API    http://localhost:${port}${runtime.sandbox.basePath}/requests.json`);
  for (const line of summary) console.error(`[citydesk] ${line}`);
  if (tokens.length === 0) console.error('[citydesk] MCP_BEARER_TOKENS is empty: authentication is OFF.');
});
