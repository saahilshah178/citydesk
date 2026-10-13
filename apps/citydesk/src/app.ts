/**
 * The CityDesk HTTP application as one web-standard handler:
 *
 *   /mcp                      the MCP endpoint (Streamable HTTP)
 *   /sandbox/open311/v2/...   the built-in Open311 sandbox, readable so anyone can inspect what was filed
 *   /healthz                  liveness
 */
import { createHash } from 'node:crypto';
import { createMcpHttpHandler, type FetchHandler } from 'open311-mcp';
import type { CityDeskRuntime } from './runtime.ts';
import { createCityDeskServer, type CityDeskServerHooks } from './server.ts';

export const DEVICE_HEADER = 'x-citydesk-device';

type MaybeAsync<T> = T | (() => T | Promise<T>);

export interface AppOptions {
  runtime: CityDeskRuntime;
  bearerTokens: MaybeAsync<string[]>;
  allowedOrigins: MaybeAsync<string[]>;
  sessions?: 'none' | 'memory';
  hooks?: CityDeskServerHooks;
}

/**
 * Who is asking. Real Alexa+ account linking would supply an identity through OAuth; this build
 * derives one from the bearer token plus an optional device ID header, so each demo household keeps
 * its own memory. The value is hashed: raw tokens and device IDs are never stored.
 */
export function resolveUserId(token: string | undefined, deviceHeader: string | null): string {
  const device = deviceHeader && /^[A-Za-z0-9_-]{8,64}$/.test(deviceHeader) ? deviceHeader : 'shared';
  const digest = createHash('sha256').update(`${token ?? 'anonymous'}\n${device}`).digest('hex').slice(0, 32);
  return `u_${digest}`;
}

export function createApp(options: AppOptions): FetchHandler {
  const { runtime } = options;
  const mcp = createMcpHttpHandler({
    factory: (ctx) =>
      createCityDeskServer(
        runtime,
        { userId: resolveUserId(ctx.authInfo?.token, ctx.requestInfo?.headers.get(DEVICE_HEADER) ?? null) },
        options.hooks,
      ),
    bearerTokens: options.bearerTokens,
    allowedOrigins: options.allowedOrigins,
    sessions: options.sessions ?? 'none',
    extraAllowedHeaders: [DEVICE_HEADER],
    onerror: (error) => runtime.log('mcp_error', { error: error.message }),
  });

  return async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === '/healthz') {
      return Response.json({ ok: true, service: 'citydesk', city: runtime.city.id, time: new Date(runtime.now()).toISOString() });
    }
    if (pathname.startsWith(`${runtime.sandbox.basePath}/`)) {
      // Read-only from outside: requests are created through the report_issue tool, not by strangers.
      if (request.method !== 'GET') {
        return Response.json([{ code: 405, description: 'The sandbox is read-only over HTTP. File through the MCP tools.' }], { status: 405 });
      }
      return runtime.sandbox.fetch(request);
    }
    return mcp(request);
  };
}
