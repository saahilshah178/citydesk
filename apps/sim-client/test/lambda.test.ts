import { describe, expect, it } from 'vitest';
import { CLIENT_IP_HEADER } from '../server/app.ts';
import { createLambdaHandler, toRequest, toResult, type FunctionUrlEvent } from '../server/lambda.ts';

function event(overrides: Partial<FunctionUrlEvent> = {}): FunctionUrlEvent {
  return {
    version: '2.0',
    rawPath: '/api/config',
    rawQueryString: '',
    headers: { host: 'abc123.lambda-url.us-east-1.on.aws', 'x-forwarded-for': '198.51.100.20' },
    requestContext: { domainName: 'abc123.lambda-url.us-east-1.on.aws', http: { method: 'GET', path: '/api/config', sourceIp: '198.51.100.20' } },
    isBase64Encoded: false,
    ...overrides,
  };
}

describe('Function URL event to Request', () => {
  it('builds the URL from host, path and query string', () => {
    const request = toRequest(event({ rawPath: '/api/config', rawQueryString: 'a=1&b=two' }));
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://abc123.lambda-url.us-east-1.on.aws/api/config?a=1&b=two');
  });

  it('decodes a base64 body and keeps a plain one', async () => {
    const json = '{"text":"Hello."}';
    const base64 = toRequest(
      event({
        rawPath: '/api/speak',
        headers: { host: 'h.example', 'content-type': 'application/json' },
        requestContext: { http: { method: 'POST', sourceIp: '198.51.100.20' } },
        body: Buffer.from(json).toString('base64'),
        isBase64Encoded: true,
      }),
    );
    expect(base64.method).toBe('POST');
    expect(await base64.text()).toBe(json);

    const plain = toRequest(
      event({ requestContext: { http: { method: 'POST', sourceIp: '198.51.100.20' } }, body: json, isBase64Encoded: false }),
    );
    expect(await plain.text()).toBe(json);
  });

  it('takes the client address from the connection and ignores a client-supplied value', () => {
    const request = toRequest(event({ headers: { host: 'h.example', [CLIENT_IP_HEADER]: '1.2.3.4' } }));
    expect(request.headers.get(CLIENT_IP_HEADER)).toBe('198.51.100.20');
  });

  it('prefers a configured trusted header and strips the port', () => {
    const viewer = (address: string): string | null =>
      toRequest(event({ headers: { host: 'h.example', 'cloudfront-viewer-address': address } }), {
        clientIpHeader: 'cloudfront-viewer-address',
      }).headers.get(CLIENT_IP_HEADER);

    expect(viewer('203.0.113.7:46532')).toBe('203.0.113.7');
    expect(viewer('2001:db8::1:46532')).toBe('2001:db8::1');
    expect(viewer('[2001:db8::1]:46532')).toBe('2001:db8::1');
    // Header configured but absent on this request: fall back to the connection.
    expect(toRequest(event(), { clientIpHeader: 'cloudfront-viewer-address' }).headers.get(CLIENT_IP_HEADER)).toBe('198.51.100.20');
  });

  it('joins cookies the way payload format 2.0 delivers them', () => {
    expect(toRequest(event({ cookies: ['a=1', 'b=2'] })).headers.get('cookie')).toBe('a=1; b=2');
  });
});

describe('Response to Function URL result', () => {
  it('returns JSON as text', async () => {
    const result = await toResult(
      new Response('{"ok":true}', { status: 201, headers: { 'content-type': 'application/json; charset=utf-8' } }),
    );
    expect(result).toEqual({
      statusCode: 201,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: '{"ok":true}',
      isBase64Encoded: false,
    });
  });

  it('returns audio base64-encoded', async () => {
    const bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x01]);
    const result = await toResult(new Response(bytes, { headers: { 'content-type': 'audio/mpeg' } }));
    expect(result.isBase64Encoded).toBe(true);
    expect(result.headers['content-type']).toBe('audio/mpeg');
    expect(new Uint8Array(Buffer.from(result.body, 'base64'))).toEqual(bytes);
  });
});

describe('createLambdaHandler', () => {
  it('runs the web handler end to end', async () => {
    const handler = createLambdaHandler(
      async (request) =>
        Response.json({ path: new URL(request.url).pathname, ip: request.headers.get(CLIENT_IP_HEADER), body: await request.text() }),
      () => ({ clientIpHeader: 'cloudfront-viewer-address' }),
    );

    const result = await handler(
      event({
        rawPath: '/api/converse',
        headers: { host: 'h.example', 'content-type': 'application/json', 'cloudfront-viewer-address': '203.0.113.7:1234' },
        requestContext: { http: { method: 'POST', sourceIp: '130.176.0.1' } },
        body: '{"messages":[]}',
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ path: '/api/converse', ip: '203.0.113.7', body: '{"messages":[]}' });
  });
});
