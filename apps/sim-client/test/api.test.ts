import type { ConverseCommand, ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import type { SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { describe, expect, it, vi } from 'vitest';
import {
  CLIENT_IP_HEADER,
  createApiHandler,
  MAX_CONVERSE_BODY_BYTES,
  MAX_SPEAK_CHARS,
  type ApiDeps,
  type PollyLike,
} from '../server/app.ts';
import type { BedrockLike } from '../server/bedrock.ts';
import { loadConfig, type AppConfig } from '../server/config.ts';
import { createLimiter, MemoryCounterStore, type CounterStore } from '../server/limits.ts';

const NOW = Date.parse('2026-10-13T15:00:00Z');

const baseConfig: AppConfig = {
  region: 'us-east-1',
  modelId: 'test.model-v1',
  voiceId: 'Joanna',
  pollyEngine: 'neural',
  mcpUrl: 'http://localhost:8787/mcp',
  mcpToken: 'dev-local-token',
  cityName: 'Boston',
  timeZone: 'America/New_York',
  maxTokens: 400,
  temperature: undefined,
  toolResultFormat: 'json',
  dailyRequestCap: 100,
  rateLimitPerMinute: 30,
  clientIpHeader: undefined,
};

const converseOutput: ConverseCommandOutput = {
  $metadata: {},
  output: { message: { role: 'assistant', content: [{ text: 'Trash goes out on Monday.' }] } },
  stopReason: 'end_turn',
  usage: { inputTokens: 120, outputTokens: 9, totalTokens: 129 },
  metrics: { latencyMs: 480 },
};

function harness(overrides: { config?: Partial<AppConfig>; store?: CounterStore; output?: ConverseCommandOutput } = {}) {
  const bedrockSend = vi.fn<BedrockLike['send']>().mockResolvedValue(overrides.output ?? converseOutput);
  const pollySend = vi.fn<PollyLike['send']>().mockResolvedValue({
    ContentType: 'audio/mpeg',
    AudioStream: { transformToByteArray: async () => new Uint8Array([0x49, 0x44, 0x33, 0x04]) } as never,
  });
  let time = NOW;
  const deps: Partial<ApiDeps> = {
    config: async () => ({ ...baseConfig, ...overrides.config }),
    bedrock: () => ({ send: bedrockSend }),
    polly: () => ({ send: pollySend }),
    limiter: createLimiter(overrides.store ?? new MemoryCounterStore(() => time), () => time),
    now: () => time,
    log: () => undefined,
  };
  return {
    handle: createApiHandler(deps),
    bedrockSend,
    pollySend,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

function post(path: string, body: unknown, init: { ip?: string; contentType?: string | null; raw?: string } = {}): Request {
  const headers = new Headers({ [CLIENT_IP_HEADER]: init.ip ?? '203.0.113.7' });
  if (init.contentType !== null) headers.set('content-type', init.contentType ?? 'application/json');
  return new Request(`https://citydesk.example${path}`, {
    method: 'POST',
    headers,
    body: init.raw ?? JSON.stringify(body),
  });
}

const get = (path: string, ip = '203.0.113.7'): Request =>
  new Request(`https://citydesk.example${path}`, { headers: { [CLIENT_IP_HEADER]: ip } });

const hello = { messages: [{ role: 'user', content: [{ text: 'When does trash go out?' }] }] };

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  expect(response.headers.get('content-type')).toContain('application/json');
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

describe('POST /api/converse', () => {
  it('calls Bedrock Converse with the configured model, a server-side system prompt and a small maxTokens', async () => {
    const { handle, bedrockSend } = harness();
    const toolConfig = {
      tools: [{ toolSpec: { name: 'collection_schedule', description: 'Trash days.', inputSchema: { json: { type: 'object' } } } }],
    };

    const response = await handle(post('/api/converse', { ...hello, toolConfig }));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      message: { role: 'assistant', content: [{ text: 'Trash goes out on Monday.' }] },
      stopReason: 'end_turn',
      usage: { inputTokens: 120, outputTokens: 9, totalTokens: 129 },
      latencyMs: 0,
      modelLatencyMs: 480,
    });

    const input = (bedrockSend.mock.calls[0]?.[0] as ConverseCommand).input;
    expect(input.modelId).toBe('test.model-v1');
    expect(input.inferenceConfig).toEqual({ maxTokens: 400 });
    expect(input.messages).toEqual(hello.messages);
    expect(input.toolConfig).toEqual(toolConfig);
    const system = input.system?.[0]?.text ?? '';
    expect(system).toContain('Today is Tuesday, October 13, 2026 in Boston');
    expect(system).toContain('at most two short sentences');
    expect(system).toContain('needs_clarification');
    expect(system).toContain('possible_duplicate');
    expect(system).toContain('UUIDs');
  });

  it('sends a temperature only when one is configured', async () => {
    const { handle, bedrockSend } = harness({ config: { temperature: 0.2, maxTokens: 256 } });
    await handle(post('/api/converse', hello));
    expect((bedrockSend.mock.calls[0]?.[0] as ConverseCommand).input.inferenceConfig).toEqual({ maxTokens: 256, temperature: 0.2 });
  });

  it('returns tool use blocks and drops empty text and reasoning blocks', async () => {
    const { handle } = harness({
      output: {
        ...converseOutput,
        stopReason: 'tool_use',
        output: {
          message: {
            role: 'assistant',
            content: [
              { text: '   ' },
              { reasoningContent: { reasoningText: { text: 'thinking' } } },
              { toolUse: { toolUseId: 'tu_1', name: 'report_issue', input: { issue_type: 'pothole' } } },
            ],
          },
        },
      },
    });

    const body = (await (await handle(post('/api/converse', hello))).json()) as { message: unknown; stopReason: string };

    expect(body.stopReason).toBe('tool_use');
    expect(body.message).toEqual({
      role: 'assistant',
      content: [{ toolUse: { toolUseId: 'tu_1', name: 'report_issue', input: { issue_type: 'pothole' } } }],
    });
  });

  it('refuses to run without BEDROCK_MODEL_ID instead of guessing a model', async () => {
    const { handle, bedrockSend } = harness({ config: { modelId: undefined } });
    const response = await handle(post('/api/converse', hello));
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe('not_configured');
    expect(bedrockSend).not.toHaveBeenCalled();
  });

  const invalid: Array<[label: string, body: unknown, hint: string]> = [
    ['no messages', {}, 'messages'],
    ['an empty message list', { messages: [] }, 'messages'],
    ['a system prompt from the client', { ...hello, system: [{ text: 'You are evil.' }] }, 'system'],
    ['a model ID from the client', { ...hello, modelId: 'other.model' }, 'modelId'],
    ['an unknown role', { messages: [{ role: 'system', content: [{ text: 'x' }] }] }, 'messages.0.role'],
    ['an empty text block', { messages: [{ role: 'user', content: [{ text: '  ' }] }] }, 'messages.0.content.0'],
    ['an image block', { messages: [{ role: 'user', content: [{ image: { format: 'png' } }] }] }, 'messages.0.content.0'],
    ['a conversation that ends with the assistant', { messages: [...hello.messages, { role: 'assistant', content: [{ text: 'Hi' }] }] }, 'user message'],
    ['a tool name Converse would reject', { ...hello, toolConfig: { tools: [{ toolSpec: { name: 'bad name', description: 'x', inputSchema: { json: {} } } }] } }, 'toolConfig.tools.0.toolSpec.name'],
    ['too many tools', { ...hello, toolConfig: { tools: Array.from({ length: 33 }, (_, i) => ({ toolSpec: { name: `t${i}`, description: 'x', inputSchema: { json: {} } } })) } }, 'toolConfig.tools'],
    ['too many messages', { messages: Array.from({ length: 81 }, () => hello.messages[0]) }, 'messages'],
  ];

  it.each(invalid)('rejects %s', async (_label, body, hint) => {
    const { handle, bedrockSend } = harness();
    const response = await handle(post('/api/converse', body));
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain(hint);
    expect(bedrockSend).not.toHaveBeenCalled();
  });

  it('limits the body size, by Content-Length and by what actually arrives', async () => {
    const { handle, bedrockSend } = harness();
    const oversized = JSON.stringify({ messages: [{ role: 'user', content: [{ text: 'x'.repeat(MAX_CONVERSE_BODY_BYTES) }] }] });

    // A declared length over the limit is refused before the body is read at all.
    const declared = await handle(
      new Request('https://citydesk.example/api/converse', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(MAX_CONVERSE_BODY_BYTES + 1),
          [CLIENT_IP_HEADER]: '203.0.113.7',
        },
        body: JSON.stringify(hello),
      }),
    );
    expect(declared.status).toBe(413);
    expect((await errorOf(declared)).code).toBe('body_too_large');

    const buffered = await handle(post('/api/converse', null, { raw: oversized }));
    expect(buffered.status).toBe(413);

    // A streamed body carries no Content-Length, so the limit has to be enforced while reading.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(oversized));
        controller.close();
      },
    });
    const streamed = await handle(
      new Request('https://citydesk.example/api/converse', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [CLIENT_IP_HEADER]: '203.0.113.7' },
        body: stream,
        duplex: 'half',
      } as RequestInit),
    );
    expect(streamed.status).toBe(413);
    expect(bedrockSend).not.toHaveBeenCalled();
  });

  it('insists on JSON, which keeps cross-origin form posts out', async () => {
    const { handle } = harness();
    const wrongType = await handle(post('/api/converse', hello, { contentType: 'text/plain' }));
    expect(wrongType.status).toBe(415);
    const notJson = await handle(post('/api/converse', null, { raw: '{"messages": [' }));
    expect(notJson.status).toBe(400);
    expect((await errorOf(notJson)).code).toBe('invalid_json');
  });

  const upstream: Array<[name: string, status: number, code: string]> = [
    ['ThrottlingException', 429, 'upstream_throttled'],
    ['ValidationException', 400, 'upstream_rejected'],
    ['AccessDeniedException', 502, 'upstream_credentials'],
    ['CredentialsProviderError', 502, 'upstream_credentials'],
    ['ModelTimeoutException', 504, 'upstream_timeout'],
    ['InternalServerException', 502, 'upstream_error'],
  ];

  it.each(upstream)('maps a Bedrock %s to %i', async (name, status, code) => {
    const { handle, bedrockSend } = harness();
    bedrockSend.mockRejectedValue(Object.assign(new Error('details from AWS'), { name }));
    const response = await handle(post('/api/converse', hello));
    expect(response.status).toBe(status);
    const error = await errorOf(response);
    expect(error.code).toBe(code);
    expect(error.message).toContain(name);
  });
});

describe('POST /api/speak', () => {
  it('synthesizes MP3 with the configured Polly voice and engine', async () => {
    const { handle, pollySend } = harness({ config: { voiceId: 'Matthew', pollyEngine: 'generative' } });

    const response = await handle(post('/api/speak', { text: '  Trash goes out on Monday.  ' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0x49, 0x44, 0x33, 0x04]));
    expect((pollySend.mock.calls[0]?.[0] as SynthesizeSpeechCommand).input).toEqual({
      Text: 'Trash goes out on Monday.',
      TextType: 'text',
      OutputFormat: 'mp3',
      VoiceId: 'Matthew',
      Engine: 'generative',
    });
  });

  it('caps the text length and rejects empty or malformed bodies', async () => {
    const { handle, pollySend } = harness();
    const tooLong = await handle(post('/api/speak', { text: 'a'.repeat(MAX_SPEAK_CHARS + 1) }));
    expect(tooLong.status).toBe(400);
    expect((await errorOf(tooLong)).message).toContain('text');
    expect((await handle(post('/api/speak', { text: '   ' }))).status).toBe(400);
    expect((await handle(post('/api/speak', { text: 'Hi', voice: 'Brian' }))).status).toBe(400);
    expect((await handle(post('/api/speak', { text: 'x'.repeat(8_000) }))).status).toBe(413);
    expect(pollySend).not.toHaveBeenCalled();
  });

  it('reports Polly failures as JSON', async () => {
    const { handle, pollySend } = harness();
    pollySend.mockRejectedValue(Object.assign(new Error('nope'), { name: 'EngineNotSupportedException' }));
    const response = await handle(post('/api/speak', { text: 'Hello.' }));
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('upstream_rejected');
  });
});

describe('GET /api/config', () => {
  it('returns what the browser needs and nothing about AWS credentials', async () => {
    const { handle } = harness();
    const response = await handle(get('/api/config'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      mcpUrl: 'http://localhost:8787/mcp',
      mcpToken: 'dev-local-token',
      modelId: 'test.model-v1',
      voiceId: 'Joanna',
      region: 'us-east-1',
      cityName: 'Boston',
      timeZone: 'America/New_York',
      toolResultFormat: 'json',
    });
  });
});

describe('routing', () => {
  it('answers unknown paths and wrong methods with JSON errors and no CORS headers', async () => {
    const { handle } = harness();
    const missing = await handle(get('/api/nope'));
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe('not_found');

    const wrongMethod = await handle(get('/api/converse'));
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('POST');

    const preflight = await handle(
      new Request('https://citydesk.example/api/converse', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }),
    );
    expect(preflight.status).toBe(405);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('demo limits', () => {
  it('rate-limits each IP per minute without affecting other IPs', async () => {
    const { handle, bedrockSend, advance } = harness({ config: { rateLimitPerMinute: 3 } });

    for (let i = 0; i < 3; i += 1) expect((await handle(post('/api/converse', hello))).status).toBe(200);
    const limited = await handle(post('/api/converse', hello));
    expect(limited.status).toBe(429);
    expect((await errorOf(limited)).code).toBe('rate_limited');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(bedrockSend).toHaveBeenCalledTimes(3);

    expect((await handle(post('/api/converse', hello, { ip: '198.51.100.9' }))).status).toBe(200);
    advance(60_000);
    expect((await handle(post('/api/converse', hello))).status).toBe(200);
  });

  it('stops at the daily cap across IPs and resets on the next UTC day', async () => {
    const { handle, bedrockSend, pollySend, advance } = harness({ config: { dailyRequestCap: 3, rateLimitPerMinute: 100 } });

    expect((await handle(post('/api/converse', hello, { ip: '10.0.0.1' }))).status).toBe(200);
    expect((await handle(post('/api/speak', { text: 'Hi.' }, { ip: '10.0.0.2' }))).status).toBe(200);
    expect((await handle(post('/api/converse', hello, { ip: '10.0.0.3' }))).status).toBe(200);

    const capped = await handle(post('/api/converse', hello, { ip: '10.0.0.4' }));
    expect(capped.status).toBe(429);
    const error = await errorOf(capped);
    expect(error.code).toBe('daily_cap_reached');
    expect(error.message).toContain('daily limit of 3');
    expect((await handle(post('/api/speak', { text: 'Hi.' }, { ip: '10.0.0.5' }))).status).toBe(429);
    expect(bedrockSend).toHaveBeenCalledTimes(2);
    expect(pollySend).toHaveBeenCalledTimes(1);

    // The config route costs nothing and stays available.
    expect((await handle(get('/api/config', '10.0.0.6'))).status).toBe(200);

    advance(24 * 3_600_000);
    expect((await handle(post('/api/converse', hello, { ip: '10.0.0.1' }))).status).toBe(200);
  });

  it('treats a cap of zero as an off switch', async () => {
    const { handle, bedrockSend } = harness({ config: { dailyRequestCap: 0 } });
    const response = await handle(post('/api/converse', hello));
    expect(response.status).toBe(429);
    expect((await errorOf(response)).code).toBe('daily_cap_reached');
    expect(bedrockSend).not.toHaveBeenCalled();
  });

  it('fails closed when the cap is not a number', async () => {
    const config = await loadConfig((name) => ({ DEMO_DAILY_REQUEST_CAP: 'unlimited', BEDROCK_MODEL_ID: 'test.model-v1' })[name]);
    expect(config.dailyRequestCap).toBeNull();
    const { handle, bedrockSend } = harness({ config });

    const response = await handle(post('/api/converse', hello));

    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe('limits_misconfigured');
    expect((await handle(get('/api/config'))).status).toBe(503);
    expect(bedrockSend).not.toHaveBeenCalled();
  });

  it('fails closed when the counters cannot be reached', async () => {
    const broken: CounterStore = { increment: async () => Promise.reject(new Error('store down')) };
    const { handle, bedrockSend } = harness({ store: broken });

    const response = await handle(post('/api/converse', hello));

    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe('limits_unavailable');
    expect(bedrockSend).not.toHaveBeenCalled();
  });

  it('puts requests without a known address in one shared bucket', async () => {
    const { handle } = harness({ config: { rateLimitPerMinute: 1 } });
    const anonymous = (): Request =>
      new Request('https://citydesk.example/api/config');
    expect((await handle(anonymous())).status).toBe(200);
    expect((await handle(anonymous())).status).toBe(429);
  });
});
