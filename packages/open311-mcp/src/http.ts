/**
 * Streamable HTTP for an MCP server, as one web-standard `(Request) => Promise<Response>` function.
 *
 * What it does, in order, for every request to the MCP path:
 *   1. CORS preflight for allowed browser origins.
 *   2. Origin validation: a request carrying an Origin that is not on the allowlist gets 403.
 *      Requests with no Origin header (non-browser MCP clients) pass.
 *   3. Bearer-token authentication, when tokens are configured: 401 with a WWW-Authenticate challenge.
 *   4. Routing by protocol era, using the SDK's own classifier:
 *        - 2025-era clients (spec 2025-11-25 and earlier) are served statelessly with plain JSON
 *          responses. GET and DELETE answer 405 because no SSE stream or session is offered.
 *        - 2026-07-28 clients are served by the SDK's per-request handler, also as JSON.
 *      The SDK transport validates the MCP-Protocol-Version header (400 when unsupported).
 *   5. Optional in-memory sessions for 2025-era clients (`sessions: 'memory'`): initialize returns an
 *      Mcp-Session-Id, GET opens the server-to-client stream, DELETE ends the session. Single
 *      process only, so leave it off on AWS Lambda.
 */
import {
  McpServer,
  OAuthError,
  OAuthErrorCode,
  Server,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
  requireBearerAuth,
  validateOriginHeader,
  type AuthInfo,
  type McpServerFactory,
} from '@modelcontextprotocol/server';
import { timingSafeEqual } from 'node:crypto';

type MaybeAsync<T> = T | (() => T | Promise<T>);

export interface McpHttpOptions {
  /** Builds a fresh server for one request (or one session). Receives the caller's auth info and request. */
  factory: McpServerFactory;
  /** URL path the endpoint lives at. Default "/mcp". */
  path?: string;
  /**
   * Browser origins allowed to call the endpoint, as origins ("https://app.example.com") or bare
   * hostnames ("app.example.com"). May be a function, for values loaded at runtime.
   */
  allowedOrigins?: MaybeAsync<string[]>;
  /**
   * Accepted bearer tokens. When the list is empty, authentication is off and every request is
   * anonymous: only do that on localhost.
   */
  bearerTokens?: MaybeAsync<string[]>;
  /** "none" (default) is stateless. "memory" gives 2025-era clients sessions held in this process. */
  sessions?: 'none' | 'memory';
  /** Extra request headers browsers may send (added to Access-Control-Allow-Headers). */
  extraAllowedHeaders?: string[];
  onerror?: (error: Error) => void;
}

export type McpHttpHandler = (request: Request) => Promise<Response>;

const BASE_ALLOWED_HEADERS = [
  'authorization',
  'content-type',
  'accept',
  'mcp-protocol-version',
  'mcp-session-id',
  'mcp-method',
  'mcp-name',
  'last-event-id',
];
const EXPOSED_HEADERS = 'mcp-session-id, mcp-protocol-version, www-authenticate';

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer | Server;
}

export function createMcpHttpHandler(options: McpHttpOptions): McpHttpHandler {
  const path = options.path ?? '/mcp';
  const sessionsEnabled = options.sessions === 'memory';
  const onerror = options.onerror ?? (() => undefined);
  const allowedHeaders = [...BASE_ALLOWED_HEADERS, ...(options.extraAllowedHeaders ?? []).map((h) => h.toLowerCase())];
  const sessions = new Map<string, Session>();

  const modern = createMcpHandler(options.factory, { legacy: 'reject', responseMode: 'json', onerror });

  async function serveLegacyStateless(request: Request, authInfo: AuthInfo | undefined): Promise<Response> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = await options.factory({ era: 'legacy', authInfo, requestInfo: request });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request, { authInfo });
      // Materialize the body before the per-request server is torn down.
      const body = response.body ? await response.arrayBuffer() : null;
      return new Response(body, { status: response.status, headers: response.headers });
    } finally {
      await server.close().catch((e: unknown) => onerror(e instanceof Error ? e : new Error(String(e))));
    }
  }

  async function serveLegacySession(request: Request, authInfo: AuthInfo | undefined): Promise<Response> {
    const sessionId = request.headers.get('mcp-session-id');
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return jsonRpcError(404, -32001, 'Session not found. Send a new initialize request.');
      return session.transport.handleRequest(request, { authInfo });
    }
    if (request.method !== 'POST') {
      return jsonRpcError(400, -32000, 'Mcp-Session-Id header is required for this request.');
    }
    // No session yet: this must be initialize. The transport rejects anything else itself.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    const server = await options.factory({ era: 'legacy', authInfo, requestInfo: request });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    return transport.handleRequest(request, { authInfo });
  }

  async function route(request: Request, authInfo: AuthInfo | undefined): Promise<Response> {
    const method = request.method.toUpperCase();
    if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') {
      return jsonRpcError(405, -32000, 'Method not allowed.', { allow: 'POST, GET, DELETE, OPTIONS' });
    }
    if (!(await isLegacyRequest(request))) return modern.fetch(request, { authInfo });
    if (sessionsEnabled) return serveLegacySession(request, authInfo);
    if (method !== 'POST') {
      // Stateless: there is no SSE stream to open and no session to delete.
      return jsonRpcError(405, -32000, 'Method not allowed. This endpoint is stateless: use POST.', {
        allow: 'POST, OPTIONS',
      });
    }
    return serveLegacyStateless(request, authInfo);
  }

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.replace(/\/+$/, '') !== path) {
      return jsonRpcError(404, -32000, `Not found. The MCP endpoint is ${path}.`);
    }

    // 1 and 2: Origin.
    const origin = request.headers.get('origin');
    const allowedOrigins = hostnames(await resolve(options.allowedOrigins ?? []));
    const originCheck = validateOriginHeader(origin, allowedOrigins);
    if (!originCheck.ok) {
      onerror(new Error(`Rejected Origin "${origin}": ${originCheck.message}`));
      return jsonRpcError(403, -32000, `Forbidden: origin ${origin} is not allowed.`);
    }
    const cors = (response: Response): Response => (origin ? withCors(response, origin, allowedHeaders) : response);

    if (request.method.toUpperCase() === 'OPTIONS') {
      return cors(new Response(null, { status: 204, headers: { 'access-control-max-age': '600' } }));
    }

    // 3: bearer token.
    let authInfo: AuthInfo | undefined;
    const tokens = await resolve(options.bearerTokens ?? []);
    if (tokens.length > 0) {
      const gate = requireBearerAuth({ verifier: staticTokenVerifier(tokens) });
      const result = await gate(request);
      if (result instanceof Response) return cors(result);
      authInfo = result;
    }

    // 4 and 5.
    try {
      return cors(await route(request, authInfo));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      onerror(error);
      return cors(jsonRpcError(500, -32603, 'Internal server error.'));
    }
  };
}

/** A verifier for fixed tokens. Comparison is constant-time. */
export function staticTokenVerifier(tokens: string[]): { verifyAccessToken(token: string): Promise<AuthInfo> } {
  const known = tokens.map((t) => Buffer.from(t));
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const given = Buffer.from(token);
      let match = false;
      for (const candidate of known) {
        if (candidate.length === given.length && timingSafeEqual(candidate, given)) match = true;
      }
      if (!match) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid access token.');
      // The SDK refuses tokens without an expiry; static tokens are treated as valid for the next hour.
      return { token, clientId: 'static-token', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    },
  };
}

async function resolve<T>(value: MaybeAsync<T>): Promise<T> {
  return typeof value === 'function' ? await (value as () => T | Promise<T>)() : value;
}

/** Accepts "https://host:port" or "host" and returns bare hostnames, as the SDK validator expects. */
function hostnames(origins: string[]): string[] {
  const out: string[] = [];
  for (const entry of origins) {
    const value = entry.trim();
    if (!value) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      try {
        out.push(new URL(value).hostname);
      } catch {
        // An unparseable entry allows nothing.
      }
    } else {
      out.push(value);
    }
  }
  return out;
}

function withCors(response: Response, origin: string, allowedHeaders: string[]): Response {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  headers.append('vary', 'Origin');
  headers.set('access-control-allow-methods', 'POST, GET, DELETE, OPTIONS');
  headers.set('access-control-allow-headers', allowedHeaders.join(', '));
  headers.set('access-control-expose-headers', EXPOSED_HEADERS);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function jsonRpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
