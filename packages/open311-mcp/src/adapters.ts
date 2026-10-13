/**
 * Adapters that put a web-standard `(Request) => Promise<Response>` handler behind node:http and
 * behind an AWS Lambda Function URL. Neither adds behaviour; they only translate.
 */
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

export type FetchHandler = (request: Request) => Promise<Response>;

/** Wraps a fetch-style handler as a node:http request listener. Response bodies are streamed. */
export function toNodeListener(handler: FetchHandler): RequestListener {
  return (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const response = await handler(toWebRequest(req));
        const headers: Record<string, string | string[]> = {};
        response.headers.forEach((value, key) => {
          if (key === 'set-cookie') return;
          headers[key] = value;
        });
        const cookies = response.headers.getSetCookie();
        if (cookies.length > 0) headers['set-cookie'] = cookies;
        res.writeHead(response.status, headers);
        if (!response.body) {
          res.end();
          return;
        }
        const reader = response.body.getReader();
        res.on('close', () => void reader.cancel().catch(() => undefined));
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      } catch (err) {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error.' }, id: null }));
        console.error('[open311-mcp] unhandled error in HTTP handler:', err);
      }
    })();
  };
}

function toWebRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? 'localhost';
  const url = new URL(req.url ?? '/', `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  const method = (req.method ?? 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(url, {
    method,
    headers,
    body: hasBody ? (req as unknown as ReadableStream<Uint8Array>) : undefined,
    // Required by Node when the body is a stream.
    ...(hasBody ? { duplex: 'half' } : {}),
  } as RequestInit);
}

/** The parts of a Lambda Function URL (payload format 2.0) event this adapter reads. */
export interface FunctionUrlEvent {
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: { domainName?: string; http?: { method?: string; sourceIp?: string } };
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: string[];
  body: string;
  isBase64Encoded: boolean;
}

const TEXT_TYPES = /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded)|[^;]+\+json)/i;

/**
 * Wraps a fetch-style handler as an AWS Lambda Function URL handler. Responses are buffered (Function
 * URLs in the default invoke mode cannot stream), which is why the MCP endpoint answers in JSON.
 */
export function toFunctionUrlHandler(handler: FetchHandler): (event: FunctionUrlEvent) => Promise<FunctionUrlResult> {
  return async (event) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(event.headers ?? {})) {
      if (value !== undefined) headers.set(key, value);
    }
    if (event.cookies?.length) headers.set('cookie', event.cookies.join('; '));
    const sourceIp = event.requestContext?.http?.sourceIp;
    if (sourceIp && !headers.has('x-forwarded-for')) headers.set('x-forwarded-for', sourceIp);

    const host = headers.get('host') ?? event.requestContext?.domainName ?? 'lambda.internal';
    const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
    const url = `https://${host}${event.rawPath ?? '/'}${query}`;
    const method = (event.requestContext?.http?.method ?? 'GET').toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD' && event.body != null;
    const body = hasBody ? Buffer.from(event.body!, event.isBase64Encoded ? 'base64' : 'utf8') : undefined;

    const response = await handler(new Request(url, { method, headers, body }));

    const outHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (key !== 'set-cookie') outHeaders[key] = value;
    });
    const cookies = response.headers.getSetCookie();
    const bytes = Buffer.from(await response.arrayBuffer());
    const isText = TEXT_TYPES.test(response.headers.get('content-type') ?? 'application/json');
    return {
      statusCode: response.status,
      headers: outHeaders,
      ...(cookies.length > 0 ? { cookies } : {}),
      body: isText ? bytes.toString('utf8') : bytes.toString('base64'),
      isBase64Encoded: !isText,
    };
  };
}
