import { describe, expect, it, vi } from 'vitest';
import { cachedConfig, envSource, layeredSource, loadConfig, type AppConfig } from '../server/config.ts';
import { buildSystemPrompt, formatToday } from '../server/prompt.ts';

describe('loadConfig', () => {
  it('has safe defaults and never invents a model ID', async () => {
    const config = await loadConfig(envSource({}));
    expect(config).toEqual({
      region: 'us-east-1',
      modelId: undefined,
      voiceId: 'Joanna',
      pollyEngine: 'neural',
      mcpUrl: 'http://localhost:8787/mcp',
      mcpToken: undefined,
      cityName: 'Boston',
      timeZone: 'America/New_York',
      maxTokens: 400,
      temperature: undefined,
      toolResultFormat: 'json',
      dailyRequestCap: 2000,
      rateLimitPerMinute: 40,
      clientIpHeader: undefined,
    } satisfies AppConfig);
  });

  it('reads every setting from its source', async () => {
    const config = await loadConfig(
      envSource({
        AWS_REGION: 'us-west-2',
        BEDROCK_MODEL_ID: 'some.model-id',
        POLLY_VOICE_ID: 'Matthew',
        POLLY_ENGINE: 'generative',
        MCP_URL: 'https://mcp.example.com/mcp',
        MCP_CLIENT_TOKEN: 'client-token',
        MCP_BEARER_TOKENS: 'server-a,server-b',
        CITYDESK_CITY_NAME: 'New Haven',
        CITYDESK_TIME_ZONE: 'America/Chicago',
        ASSISTANT_MAX_TOKENS: '256',
        ASSISTANT_TEMPERATURE: '0.3',
        ASSISTANT_TOOL_RESULT_FORMAT: 'text',
        DEMO_DAILY_REQUEST_CAP: '500',
        DEMO_RATE_LIMIT_PER_MINUTE: '12',
        CLIENT_IP_HEADER: 'CloudFront-Viewer-Address',
      }),
    );
    expect(config).toMatchObject({
      region: 'us-west-2',
      modelId: 'some.model-id',
      voiceId: 'Matthew',
      pollyEngine: 'generative',
      mcpUrl: 'https://mcp.example.com/mcp',
      mcpToken: 'client-token',
      cityName: 'New Haven',
      timeZone: 'America/Chicago',
      maxTokens: 256,
      temperature: 0.3,
      toolResultFormat: 'text',
      dailyRequestCap: 500,
      rateLimitPerMinute: 12,
      clientIpHeader: 'cloudfront-viewer-address',
    });
  });

  it('falls back to VITE_MCP_URL and to the first server token for local development', async () => {
    const config = await loadConfig(
      envSource({ VITE_MCP_URL: 'http://localhost:9000/mcp', MCP_BEARER_TOKENS: ' dev-local-token , other ' }),
    );
    expect(config.mcpUrl).toBe('http://localhost:9000/mcp');
    expect(config.mcpToken).toBe('dev-local-token');
  });

  it('marks unusable limits as invalid instead of falling back to a default', async () => {
    const invalid = ['abc', '-5', '1.5', '10 per day'];
    for (const value of invalid) {
      const config = await loadConfig(envSource({ DEMO_DAILY_REQUEST_CAP: value, DEMO_RATE_LIMIT_PER_MINUTE: value }));
      expect([value, config.dailyRequestCap, config.rateLimitPerMinute]).toEqual([value, null, null]);
    }
    const zero = await loadConfig(envSource({ DEMO_DAILY_REQUEST_CAP: '0', DEMO_RATE_LIMIT_PER_MINUTE: '0' }));
    expect(zero.dailyRequestCap).toBe(0);
    // Zero requests per minute would be a confusing way to close the endpoint; the cap does that.
    expect(zero.rateLimitPerMinute).toBeNull();
  });

  it('ignores an out-of-range temperature', async () => {
    expect((await loadConfig(envSource({ ASSISTANT_TEMPERATURE: '7' }))).temperature).toBeUndefined();
    expect((await loadConfig(envSource({ ASSISTANT_TEMPERATURE: 'warm' }))).temperature).toBeUndefined();
  });
});

describe('config sources', () => {
  it('lets another store sit in front of the environment', async () => {
    const parameterStore = vi.fn(async (name: string) => (name === 'MCP_CLIENT_TOKEN' ? 'from-ssm' : undefined));
    const config = await loadConfig(
      layeredSource(parameterStore, envSource({ MCP_CLIENT_TOKEN: 'from-env', BEDROCK_MODEL_ID: 'env.model' })),
    );
    expect(config.mcpToken).toBe('from-ssm');
    expect(config.modelId).toBe('env.model');
    expect(parameterStore).toHaveBeenCalledWith('BEDROCK_MODEL_ID');
  });

  it('caches a successful load for its lifetime and retries after a failure', async () => {
    let time = 0;
    const load = vi
      .fn<() => Promise<AppConfig>>()
      .mockRejectedValueOnce(new Error('parameter store unavailable'))
      .mockImplementation(() => loadConfig(envSource({})));
    const get = cachedConfig(load, 1_000, () => time);

    await expect(get()).rejects.toThrow('parameter store unavailable');
    await get();
    await get();
    expect(load).toHaveBeenCalledTimes(2);
    time = 1_001;
    await get();
    expect(load).toHaveBeenCalledTimes(3);
  });
});

describe('system prompt', () => {
  it('states the date in the city time zone', () => {
    // 02:30 UTC on the 14th is still the evening of the 13th in Boston.
    const now = new Date('2026-10-14T02:30:00Z');
    expect(formatToday(now, 'America/New_York')).toBe('Tuesday, October 13, 2026');
    expect(formatToday(now, 'UTC')).toBe('Wednesday, October 14, 2026');
  });

  it('carries every rule the assistant is held to', () => {
    const prompt = buildSystemPrompt({ cityName: 'Boston', timeZone: 'America/New_York', now: new Date('2026-10-13T15:00:00Z') });
    for (const phrase of [
      'voice assistant for city services',
      'Echo Show',
      'Today is Tuesday, October 13, 2026 in Boston',
      'at most two short sentences',
      'UUIDs',
      'type, place and date',
      '"needs_clarification"',
      'clarification.question',
      '"possible_duplicate"',
      'offer to follow that report instead of filing a new one',
    ]) {
      expect(prompt).toContain(phrase);
    }
  });
});
