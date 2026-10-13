/**
 * The CityDesk HTTP application as one web-standard handler:
 *
 *   /mcp                      the MCP endpoint (Streamable HTTP)
 *   /sandbox/open311/v2/...   the built-in Open311 sandbox, readable so anyone can inspect what was filed
 *   /healthz                  liveness
 */
import { createHash } from 'node:crypto';
import { createMcpHttpHandler, SOURCE_IP_HEADER, type FetchHandler } from 'open311-mcp';
import type { CityDeskRuntime } from './runtime.ts';
import { createCityDeskServer, type CityDeskServerHooks } from './server.ts';
import type { UserContext } from './tools.ts';

export const DEVICE_HEADER = 'x-citydesk-device';
/** Set by the CloudFront function in front of the deployed server to the visitor's address. */
export const VIEWER_IP_HEADER = 'x-viewer-ip';

type MaybeAsync<T> = T | (() => T | Promise<T>);

export interface AppOptions {
  runtime: CityDeskRuntime;
  bearerTokens: MaybeAsync<string[]>;
  allowedOrigins: MaybeAsync<string[]>;
  sessions?: 'none' | 'memory';
  hooks?: CityDeskServerHooks;
  /** Requests per minute allowed from one visitor. Default 60. */
  perVisitorPerMinute?: number;
  /** Requests per minute allowed from one connecting address (a CDN edge serves many visitors). Default 300. */
  perSourcePerMinute?: number;
}

const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32);

/** The address the connection came from, and the visitor behind it when a CDN says who that is. */
export function callerOf(request: Request): { source: string; visitor: string } {
  const source = request.headers.get(SOURCE_IP_HEADER) ?? 'unknown';
  const viewer = request.headers.get(VIEWER_IP_HEADER)?.trim();
  return { source, visitor: viewer && /^[0-9a-fA-F:.]{3,45}$/.test(viewer) ? viewer : source };
}

/**
 * Who is asking. Real Alexa+ account linking would supply an identity through OAuth; this build
 * derives one from the bearer token plus a device ID header, so each demo household keeps its own
 * memory. A client that sends no usable device ID gets a household tied to its network address
 * instead of sharing one with every other such client. Everything is hashed: raw tokens, device IDs
 * and addresses are never stored.
 */
export function resolveUser(token: string | undefined, deviceHeader: string | null, visitor: string): UserContext {
  const device = deviceHeader && /^[A-Za-z0-9_-]{8,64}$/.test(deviceHeader) ? `device:${deviceHeader}` : `address:${visitor}`;
  return { userId: `u_${digest(`${token ?? 'anonymous'}\n${device}`)}`, callerKey: digest(`caller\n${visitor}`).slice(0, 16) };
}

/** A fixed-window request counter per key, held in this process. */
class WindowCounter {
  private readonly counts = new Map<string, { window: number; n: number }>();
  constructor(
    private readonly limit: number,
    private readonly now: () => number,
  ) {}

  /** Counts one request. Returns the seconds to wait when the key is over its limit, else 0. */
  hit(key: string): number {
    const t = this.now();
    const window = Math.floor(t / 60_000);
    if (this.counts.size > 20_000) this.counts.clear();
    const entry = this.counts.get(key);
    if (!entry || entry.window !== window) {
      this.counts.set(key, { window, n: 1 });
      return 0;
    }
    entry.n++;
    return entry.n > this.limit ? Math.max(1, 60 - Math.floor((t % 60_000) / 1000)) : 0;
  }
}

function tooManyRequests(retryAfter: number): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: `Too many requests. Try again in ${retryAfter} seconds.` }, id: null }),
    { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(retryAfter) } },
  );
}

export function createApp(options: AppOptions): FetchHandler {
  const { runtime } = options;
  const perVisitor = new WindowCounter(options.perVisitorPerMinute ?? 60, runtime.now);
  const perSource = new WindowCounter(options.perSourcePerMinute ?? 300, runtime.now);

  const mcp = createMcpHttpHandler({
    factory: (ctx) => {
      const visitor = ctx.requestInfo ? callerOf(ctx.requestInfo).visitor : 'unknown';
      const user = resolveUser(ctx.authInfo?.token, ctx.requestInfo?.headers.get(DEVICE_HEADER) ?? null, visitor);
      return createCityDeskServer(runtime, user, options.hooks);
    },
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

    // Everything past this point costs something (a database read, an upstream call), so it is
    // rate limited per caller. Both limits apply: a visitor behind a CDN is limited individually,
    // and the address the connection came from is limited as a whole, which is what bounds a caller
    // who talks to the function directly and makes up visitor addresses.
    if (request.method !== 'OPTIONS') {
      const { source, visitor } = callerOf(request);
      const wait = Math.max(perSource.hit(`s:${source}`), visitor === source ? 0 : perVisitor.hit(`v:${visitor}`));
      if (wait > 0) return tooManyRequests(wait);
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
