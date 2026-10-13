/**
 * The one place the backend reads configuration.
 *
 * Every value comes through a `ConfigSource`, a function from a name to a value. Locally that is
 * `process.env` (filled from the repo-root `.env` by `server/dev.ts`). In Lambda the token and
 * keys live in SSM Parameter Store: put a source that reads them in front of the environment with
 * `layeredSource(ssmSource, envSource())` and hand the result to `loadConfig`. Nothing else in the
 * backend touches `process.env`.
 */

import type { StructuredFormat } from '../src/assistant/loop.ts';

export type ConfigSource = (name: string) => string | undefined | Promise<string | undefined>;

export const DEFAULT_MCP_URL = 'http://localhost:8787/mcp';
export const DEFAULT_DAILY_REQUEST_CAP = 2000;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 40;

export interface AppConfig {
  region: string;
  /** Bedrock model or inference profile ID. Never defaulted: Converse is refused without it. */
  modelId: string | undefined;
  voiceId: string;
  pollyEngine: string;
  mcpUrl: string;
  /** Bearer token the browser presents to the MCP server. */
  mcpToken: string | undefined;
  cityName: string;
  timeZone: string;
  maxTokens: number;
  /** Sent to Bedrock only when set. */
  temperature: number | undefined;
  toolResultFormat: StructuredFormat;
  /** Requests per day across all visitors. `null` means the setting is present but not a number. */
  dailyRequestCap: number | null;
  /** Requests per minute per IP. `null` means the setting is present but not a number. */
  rateLimitPerMinute: number | null;
  /** Lowercase name of a trusted header carrying the visitor's address (Lambda behind CloudFront). */
  clientIpHeader: string | undefined;
}

/** Reads from an environment-like record. Empty strings count as unset. */
export function envSource(env: Record<string, string | undefined> = process.env): ConfigSource {
  return (name) => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };
}

/** Asks each source in turn; the first one with a value wins. */
export function layeredSource(...sources: ConfigSource[]): ConfigSource {
  return async (name) => {
    for (const source of sources) {
      const value = await source(name);
      if (value !== undefined && value !== '') return value;
    }
    return undefined;
  };
}

/** A whole number of at least `min`, the default when unset, or `null` when set to anything else. */
function wholeNumber(raw: string | undefined, fallback: number, min: number): number | null {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min ? value : null;
}

export async function loadConfig(source: ConfigSource = envSource()): Promise<AppConfig> {
  const get = async (name: string): Promise<string | undefined> => (await source(name)) || undefined;

  const [
    region,
    modelId,
    voiceId,
    pollyEngine,
    mcpUrl,
    viteMcpUrl,
    mcpToken,
    serverTokens,
    cityName,
    timeZone,
    maxTokens,
    temperature,
    toolResultFormat,
    dailyCap,
    perMinute,
    clientIpHeader,
  ] = await Promise.all(
    [
      'AWS_REGION',
      'BEDROCK_MODEL_ID',
      'POLLY_VOICE_ID',
      'POLLY_ENGINE',
      'MCP_URL',
      'VITE_MCP_URL',
      'MCP_CLIENT_TOKEN',
      'MCP_BEARER_TOKENS',
      'CITYDESK_CITY_NAME',
      'CITYDESK_TIME_ZONE',
      'ASSISTANT_MAX_TOKENS',
      'ASSISTANT_TEMPERATURE',
      'ASSISTANT_TOOL_RESULT_FORMAT',
      'DEMO_DAILY_REQUEST_CAP',
      'DEMO_RATE_LIMIT_PER_MINUTE',
      'CLIENT_IP_HEADER',
    ].map(get),
  );

  const parsedTemperature = temperature === undefined ? Number.NaN : Number(temperature);

  return {
    region: region ?? 'us-east-1',
    modelId,
    voiceId: voiceId ?? 'Joanna',
    pollyEngine: pollyEngine ?? 'neural',
    mcpUrl: mcpUrl ?? viteMcpUrl ?? DEFAULT_MCP_URL,
    // The MCP server accepts a comma-separated list of tokens; locally the client uses the first.
    mcpToken: mcpToken ?? (serverTokens?.split(',')[0]?.trim() || undefined),
    cityName: cityName ?? 'Boston',
    timeZone: timeZone ?? 'America/New_York',
    maxTokens: wholeNumber(maxTokens, 400, 16) ?? 400,
    temperature: Number.isFinite(parsedTemperature) && parsedTemperature >= 0 && parsedTemperature <= 1
      ? parsedTemperature
      : undefined,
    toolResultFormat: toolResultFormat === 'text' ? 'text' : 'json',
    dailyRequestCap: wholeNumber(dailyCap, DEFAULT_DAILY_REQUEST_CAP, 0),
    rateLimitPerMinute: wholeNumber(perMinute, DEFAULT_RATE_LIMIT_PER_MINUTE, 1),
    clientIpHeader: clientIpHeader?.toLowerCase(),
  };
}

/** Loads once and reuses the result for `ttlMs`, so a warm Lambda does not re-read on every request. */
export function cachedConfig(
  load: () => Promise<AppConfig>,
  ttlMs: number = 5 * 60_000,
  now: () => number = Date.now,
): () => Promise<AppConfig> {
  let cached: { value: Promise<AppConfig>; expiresAt: number } | undefined;
  return () => {
    const time = now();
    if (!cached || cached.expiresAt <= time) {
      const value = load();
      cached = { value, expiresAt: time + ttlMs };
      // A failed load must not be remembered.
      value.catch(() => {
        if (cached?.value === value) cached = undefined;
      });
    }
    return cached.value;
  };
}

/** The process-wide configuration, read from the environment. Swap the source here to add SSM. */
export const sharedConfig: () => Promise<AppConfig> = cachedConfig(() => loadConfig());
