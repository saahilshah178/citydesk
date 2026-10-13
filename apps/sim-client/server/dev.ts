/**
 * Local backend: a Node http server around `handleApi`. Vite proxies `/api` here (see
 * `vite.config.ts`), so the browser talks to one origin exactly as it does behind CloudFront.
 *
 *   pnpm --filter @citydesk/sim-client dev:api
 */

import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { CLIENT_IP_HEADER, handleApi, MAX_CONVERSE_BODY_BYTES } from './app.ts';

// Real environment variables win over the repo-root .env, as in scripts/lib/env.ts.
const envFile = resolve(import.meta.dirname, '..', '..', '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const PORT = Number(process.env['API_PORT'] ?? 8788);
const HOST = process.env['API_HOST'] ?? '127.0.0.1';

/** Buffers the body, giving up once it is clearly past anything a route accepts. */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | 'too_large'> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.byteLength;
    if (total > maxBytes) return 'too_large';
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function toRequest(req: IncomingMessage): Promise<Request | 'too_large'> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  headers.set(CLIENT_IP_HEADER, req.socket.remoteAddress ?? 'unknown');

  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `localhost:${PORT}`}`);
  if (method === 'GET' || method === 'HEAD') return new Request(url, { method, headers });

  const body = await readBody(req, MAX_CONVERSE_BODY_BYTES + 1024);
  if (body === 'too_large') return 'too_large';
  return new Request(url, { method, headers, body: new Uint8Array(body) });
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const request = await toRequest(req);
      if (request === 'too_large') {
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', connection: 'close' });
        res.end(JSON.stringify({ error: { code: 'body_too_large', message: 'The request body is too large.' } }));
        return;
      }
      await writeResponse(res, await handleApi(request));
    } catch (error) {
      console.error('[sim-client api] request failed', error);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'internal', message: 'The server could not handle the request.' } }));
    }
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`sim-client API listening on http://${HOST}:${PORT}`);
  console.log(`  BEDROCK_MODEL_ID  ${process.env['BEDROCK_MODEL_ID'] ? 'set' : 'not set (POST /api/converse answers 503)'}`);
  console.log(`  AWS_REGION        ${process.env['AWS_REGION'] ?? 'us-east-1 (default)'}`);
});
