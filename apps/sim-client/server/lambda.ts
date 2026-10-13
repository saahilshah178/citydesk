/**
 * AWS Lambda adapter for a Function URL (payload format version 2.0).
 *
 * Deploy this file's `handler` export. Text responses are returned as strings; anything else
 * (the Polly audio) is returned base64-encoded with `isBase64Encoded: true`, which is how a
 * buffered Function URL response carries binary data.
 *
 * Client IP: `requestContext.http.sourceIp` is the caller of the Function URL. Behind CloudFront
 * that is an edge node, not the visitor, so the per-IP rate limit would group everyone arriving
 * through the same edge. To limit real visitors, forward CloudFront's `CloudFront-Viewer-Address`
 * header with an origin request policy and set `CLIENT_IP_HEADER=cloudfront-viewer-address`.
 */

import { CLIENT_IP_HEADER, createApiHandler, handleApi } from './app.ts';
import { SharedDayCounter, ssmConfigSource } from './aws.ts';
import { cachedConfig, envSource, layeredSource, loadConfig, sharedConfig, type AppConfig } from './config.ts';
import { createLimiter } from './limits.ts';

/** The fields of a Function URL event (payload format 2.0) that the adapter reads. */
export interface FunctionUrlEvent {
  version?: string;
  rawPath: string;
  rawQueryString?: string;
  cookies?: string[];
  headers?: Record<string, string | undefined>;
  requestContext: {
    domainName?: string;
    http: { method: string; path?: string; sourceIp?: string };
  };
  body?: string | null;
  isBase64Encoded?: boolean;
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
}

export interface LambdaAdapterOptions {
  /** Lowercase name of a trusted header carrying the visitor's address, e.g. `cloudfront-viewer-address`. */
  clientIpHeader?: string | undefined;
}

/** "203.0.113.7:46532" and "[2001:db8::1]:46532" (or "2001:db8::1:46532") without the port. */
function stripPort(address: string): string {
  const trimmed = address.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(trimmed);
  if (bracketed?.[1]) return bracketed[1];
  const ipv4 = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(trimmed);
  if (ipv4?.[1]) return ipv4[1];
  // CloudFront writes IPv6 as address:port without brackets.
  const lastColon = trimmed.lastIndexOf(':');
  return lastColon > 0 && trimmed.indexOf(':') !== lastColon ? trimmed.slice(0, lastColon) : trimmed;
}

function isText(contentType: string): boolean {
  return /^text\/|[/+]json\b|[/+]xml\b|^application\/javascript\b/i.test(contentType);
}

export function toRequest(event: FunctionUrlEvent, options: LambdaAdapterOptions = {}): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers.set(name, value);
  }
  if (event.cookies?.length) headers.set('cookie', event.cookies.join('; '));

  const trusted = options.clientIpHeader ? headers.get(options.clientIpHeader) : null;
  const ip = trusted ? stripPort(trusted) : (event.requestContext.http.sourceIp ?? 'unknown');
  headers.set(CLIENT_IP_HEADER, ip);

  const host = headers.get('host') ?? event.requestContext.domainName ?? 'lambda.invalid';
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const url = `https://${host}${event.rawPath}${query}`;

  const method = event.requestContext.http.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || event.body === undefined || event.body === null) {
    return new Request(url, { method, headers });
  }
  const body = event.isBase64Encoded ? new Uint8Array(Buffer.from(event.body, 'base64')) : event.body;
  return new Request(url, { method, headers, body });
}

export async function toResult(response: Response): Promise<FunctionUrlResult> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const contentType = response.headers.get('content-type') ?? '';
  if (isText(contentType)) {
    return { statusCode: response.status, headers, body: await response.text(), isBase64Encoded: false };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return { statusCode: response.status, headers, body: bytes.toString('base64'), isBase64Encoded: true };
}

export function createLambdaHandler(
  handle: (request: Request) => Promise<Response>,
  options: () => LambdaAdapterOptions | Promise<LambdaAdapterOptions> = () => ({}),
): (event: FunctionUrlEvent) => Promise<FunctionUrlResult> {
  return async (event) => toResult(await handle(toRequest(event, await options())));
}

/**
 * The deployed handler. In Lambda the MCP token comes from Parameter Store (CITYDESK_SSM_PREFIX) and
 * the daily cap is counted in DynamoDB (CITYDESK_TABLE); without those variables it behaves exactly
 * like the local server.
 */
function deployedApi(env: Record<string, string | undefined> = process.env): {
  handle: (request: Request) => Promise<Response>;
  config: () => Promise<AppConfig>;
} {
  if (!env['CITYDESK_SSM_PREFIX'] && !env['CITYDESK_TABLE']) return { handle: handleApi, config: sharedConfig };
  const source = env['CITYDESK_SSM_PREFIX']
    ? layeredSource(ssmConfigSource({ prefix: env['CITYDESK_SSM_PREFIX'] }), envSource(env))
    : envSource(env);
  const config = cachedConfig(() => loadConfig(source));
  const limiter = env['CITYDESK_TABLE'] ? createLimiter(new SharedDayCounter({ tableName: env['CITYDESK_TABLE'] })) : createLimiter();
  return { handle: createApiHandler({ config, limiter }), config };
}

const deployed = deployedApi();

export const handler = createLambdaHandler(deployed.handle, async () => ({
  clientIpHeader: (await deployed.config()).clientIpHeader,
}));
