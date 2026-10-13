/**
 * The sim client's backend, as one web-standard handler: `handleApi(request) => Response`.
 *
 *   POST /api/converse   one Amazon Bedrock Converse call (the browser runs the tool loop)
 *   POST /api/speak      Amazon Polly SynthesizeSpeech, returned as audio/mpeg
 *   GET  /api/config     what the browser needs to reach the MCP server
 *
 * `server/dev.ts` serves it from a Node http server and `server/lambda.ts` from a Lambda Function
 * URL. The handler sends no CORS headers: it is meant to be reached same-origin (through the Vite
 * proxy locally, through CloudFront in production), and POST bodies must be `application/json`,
 * which a cross-origin page cannot send without a preflight that this handler does not answer.
 */

import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import {
  PollyClient,
  SynthesizeSpeechCommand,
  type Engine,
  type SynthesizeSpeechCommandOutput,
  type VoiceId,
} from '@aws-sdk/client-polly';
import { z } from 'zod';
import type { ConverseRequest } from '../src/assistant/types.ts';
import { converseOnce, type BedrockLike } from './bedrock.ts';
import { sharedConfig, type AppConfig } from './config.ts';
import { createLimiter, type Limiter } from './limits.ts';
import { buildSystemPrompt } from './prompt.ts';

/** Set by the adapter (dev server, Lambda) from the connection; any value sent by a client is replaced. */
export const CLIENT_IP_HEADER = 'x-citydesk-client-ip';

export const MAX_CONVERSE_BODY_BYTES = 256 * 1024;
export const MAX_SPEAK_BODY_BYTES = 4 * 1024;
export const MAX_SPEAK_CHARS = 600;
const CONVERSE_TIMEOUT_MS = 25_000;
const SPEAK_TIMEOUT_MS = 10_000;

/** The slice of `PollyClient` this module needs. Tests pass a fake. */
export interface PollyLike {
  send(
    command: SynthesizeSpeechCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<Pick<SynthesizeSpeechCommandOutput, 'AudioStream' | 'ContentType'>>;
}

export interface ApiDeps {
  config: () => Promise<AppConfig>;
  bedrock: (config: AppConfig) => BedrockLike;
  polly: (config: AppConfig) => PollyLike;
  limiter: Limiter;
  now: () => number;
  log: (message: string, detail?: unknown) => void;
}

// ---- request validation -------------------------------------------------------------------

const toolName = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, 'must match [a-zA-Z0-9_-]{1,64}');
const jsonObject = z.record(z.string(), z.unknown());
const toolUseId = z.string().min(1).max(256);

const textBlock = z.strictObject({ text: z.string().trim().min(1).max(8_000) });
const toolUseBlock = z.strictObject({
  toolUse: z.strictObject({ toolUseId, name: toolName, input: jsonObject }),
});
const toolResultBlock = z.strictObject({
  toolResult: z.strictObject({
    toolUseId,
    content: z
      .array(z.union([z.strictObject({ text: z.string().min(1).max(40_000) }), z.strictObject({ json: jsonObject })]))
      .min(1)
      .max(8),
    status: z.literal('error').optional(),
  }),
});

const converseBody = z.strictObject({
  messages: z
    .array(
      z.strictObject({
        role: z.enum(['user', 'assistant']),
        content: z.array(z.union([textBlock, toolUseBlock, toolResultBlock])).min(1).max(16),
      }),
    )
    .min(1)
    .max(80),
  toolConfig: z
    .strictObject({
      tools: z
        .array(
          z.strictObject({
            toolSpec: z.strictObject({
              name: toolName,
              description: z.string().min(1).max(4_000),
              inputSchema: z.strictObject({ json: jsonObject }),
            }),
          }),
        )
        .min(1)
        .max(32),
    })
    .optional(),
});

const speakBody = z.strictObject({ text: z.string().trim().min(1).max(MAX_SPEAK_CHARS) });

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'The request body is not valid.';
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

// ---- responses ----------------------------------------------------------------------------

const BASE_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function errorResponse(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return json(status, { error: { code, message } }, headers);
}

type BodyResult = { ok: true; value: unknown } | { ok: false; response: Response };

async function readJsonBody(request: Request, maxBytes: number): Promise<BodyResult> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(contentType.trim())) {
    return { ok: false, response: errorResponse(415, 'unsupported_media_type', 'Send the body as application/json.') };
  }
  const tooLarge = (): BodyResult => ({
    ok: false,
    response: errorResponse(413, 'body_too_large', `The request body is limited to ${maxBytes} bytes.`),
  });
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge();
  if (!request.body) {
    return { ok: false, response: errorResponse(400, 'invalid_json', 'The request body is empty.') };
  }

  // Read with a running total so an oversized body without a Content-Length is cut off early.
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false, response: errorResponse(400, 'invalid_json', 'The request body is not valid JSON.') };
  }
}

const THROTTLED = new Set(['ThrottlingException', 'TooManyRequestsException', 'ServiceQuotaExceededException']);
const REJECTED = new Set([
  'ValidationException',
  'TextLengthExceededException',
  'InvalidSsmlException',
  'EngineNotSupportedException',
  'LanguageNotSupportedException',
  'ResourceNotFoundException',
]);
const CREDENTIALS = new Set([
  'AccessDeniedException',
  'UnrecognizedClientException',
  'ExpiredTokenException',
  'InvalidSignatureException',
  'CredentialsProviderError',
]);

function upstreamError(service: 'bedrock' | 'polly', error: unknown): Response {
  const name = error instanceof Error ? error.name : 'Error';
  const detail = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  const message = `${service === 'bedrock' ? 'Amazon Bedrock' : 'Amazon Polly'}: ${name}: ${detail}`;
  if (name === 'AbortError' || name === 'TimeoutError' || name === 'ModelTimeoutException') {
    return errorResponse(504, 'upstream_timeout', message);
  }
  if (THROTTLED.has(name)) return errorResponse(429, 'upstream_throttled', message, { 'retry-after': '5' });
  if (REJECTED.has(name)) return errorResponse(400, 'upstream_rejected', message);
  if (CREDENTIALS.has(name)) return errorResponse(502, 'upstream_credentials', message);
  return errorResponse(502, 'upstream_error', message);
}

function timeoutSignal(request: Request, ms: number): AbortSignal {
  return AbortSignal.any([request.signal, AbortSignal.timeout(ms)]);
}

// ---- handler ------------------------------------------------------------------------------

function defaultDeps(): ApiDeps {
  let bedrock: { region: string; client: BedrockRuntimeClient } | undefined;
  let polly: { region: string; client: PollyClient } | undefined;
  return {
    config: sharedConfig,
    bedrock: ({ region }) => {
      if (bedrock?.region !== region) bedrock = { region, client: new BedrockRuntimeClient({ region }) };
      return bedrock.client;
    },
    polly: ({ region }) => {
      if (polly?.region !== region) polly = { region, client: new PollyClient({ region }) };
      return polly.client;
    },
    limiter: createLimiter(),
    now: Date.now,
    log: (message, detail) => console.error(`[sim-client api] ${message}`, detail ?? ''),
  };
}

type Route = { method: 'GET' | 'POST'; metered: boolean; run: (request: Request, config: AppConfig) => Promise<Response> };

export function createApiHandler(overrides: Partial<ApiDeps> = {}): (request: Request) => Promise<Response> {
  const deps: ApiDeps = { ...defaultDeps(), ...overrides };

  const routes: Record<string, Route> = {
    '/api/config': {
      method: 'GET',
      metered: false,
      run: async (_request, config) =>
        json(200, {
          mcpUrl: config.mcpUrl,
          mcpToken: config.mcpToken ?? null,
          modelId: config.modelId ?? null,
          voiceId: config.voiceId,
          region: config.region,
          cityName: config.cityName,
          timeZone: config.timeZone,
          toolResultFormat: config.toolResultFormat,
        }),
    },

    '/api/converse': {
      method: 'POST',
      metered: true,
      run: async (request, config) => {
        if (!config.modelId) {
          return errorResponse(503, 'not_configured', 'BEDROCK_MODEL_ID is not set, so the assistant is unavailable.');
        }
        const body = await readJsonBody(request, MAX_CONVERSE_BODY_BYTES);
        if (!body.ok) return body.response;
        const parsed = converseBody.safeParse(body.value);
        if (!parsed.success) return errorResponse(400, 'invalid_request', describeIssue(parsed.error));
        const messages = parsed.data.messages;
        if (messages[0]?.role !== 'user' || messages.at(-1)?.role !== 'user') {
          return errorResponse(400, 'invalid_request', 'messages must start and end with a user message.');
        }

        try {
          const outcome = await converseOnce(
            deps.bedrock(config),
            parsed.data as ConverseRequest,
            {
              modelId: config.modelId,
              system: buildSystemPrompt({
                cityName: config.cityName,
                timeZone: config.timeZone,
                now: new Date(deps.now()),
              }),
              maxTokens: config.maxTokens,
              temperature: config.temperature,
            },
            { signal: timeoutSignal(request, CONVERSE_TIMEOUT_MS), now: deps.now },
          );
          return json(200, outcome);
        } catch (error) {
          deps.log('converse failed', error);
          return upstreamError('bedrock', error);
        }
      },
    },

    '/api/speak': {
      method: 'POST',
      metered: true,
      run: async (request, config) => {
        const body = await readJsonBody(request, MAX_SPEAK_BODY_BYTES);
        if (!body.ok) return body.response;
        const parsed = speakBody.safeParse(body.value);
        if (!parsed.success) return errorResponse(400, 'invalid_request', describeIssue(parsed.error));

        try {
          const output = await deps.polly(config).send(
            new SynthesizeSpeechCommand({
              Text: parsed.data.text,
              TextType: 'text',
              OutputFormat: 'mp3',
              VoiceId: config.voiceId as VoiceId,
              Engine: config.pollyEngine as Engine,
            }),
            { abortSignal: timeoutSignal(request, SPEAK_TIMEOUT_MS) },
          );
          if (!output.AudioStream) return errorResponse(502, 'upstream_error', 'Amazon Polly returned no audio.');
          // Copied into a plain ArrayBuffer-backed array, which is what a Response body accepts.
          const audio = new Uint8Array(await output.AudioStream.transformToByteArray());
          return new Response(audio, {
            status: 200,
            headers: { ...BASE_HEADERS, 'content-type': 'audio/mpeg', 'content-length': String(audio.byteLength) },
          });
        } catch (error) {
          deps.log('speak failed', error);
          return upstreamError('polly', error);
        }
      },
    },
  };

  return async function handleApi(request: Request): Promise<Response> {
    try {
      const { pathname } = new URL(request.url);
      const route = routes[pathname.replace(/\/+$/, '') || '/'];
      if (!route) return errorResponse(404, 'not_found', `No route for ${pathname}.`);
      if (request.method !== route.method) {
        return errorResponse(405, 'method_not_allowed', `Use ${route.method} for ${pathname}.`, { allow: route.method });
      }

      const config = await deps.config();
      const decision = await deps.limiter.check(
        { ip: request.headers.get(CLIENT_IP_HEADER)?.trim() || 'unknown', metered: route.metered },
        { perMinute: config.rateLimitPerMinute, dailyCap: config.dailyRequestCap },
      );
      if (!decision.ok) {
        return errorResponse(decision.status, decision.code, decision.message, {
          'retry-after': String(decision.retryAfterSeconds),
        });
      }
      return await route.run(request, config);
    } catch (error) {
      deps.log('unhandled error', error);
      return errorResponse(500, 'internal', 'The server could not handle the request.');
    }
  };
}

let defaultHandler: ((request: Request) => Promise<Response>) | undefined;

/** The handler with real AWS clients and environment configuration, built on first use. */
export function handleApi(request: Request): Promise<Response> {
  defaultHandler ??= createApiHandler();
  return defaultHandler(request);
}
