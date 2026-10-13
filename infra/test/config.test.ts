import { describe, expect, it } from 'vitest';

import { ConfigError, DEFAULTS, MISSING_MODEL_MESSAGE, loadDeployConfig } from '../lib/config.ts';
import { resolveRegion } from '../lib/env.ts';

describe('loadDeployConfig', () => {
  it('fails with a readable message when BEDROCK_MODEL_ID is missing or blank', () => {
    expect(() => loadDeployConfig({})).toThrow(ConfigError);
    expect(() => loadDeployConfig({})).toThrow(MISSING_MODEL_MESSAGE);
    expect(() => loadDeployConfig({ BEDROCK_MODEL_ID: '   ' })).toThrow(/BEDROCK_MODEL_ID is not set/);
  });

  it('fills in the documented defaults', () => {
    expect(loadDeployConfig({ BEDROCK_MODEL_ID: 'us.amazon.nova-lite-v1:0' })).toEqual({
      bedrockModelId: 'us.amazon.nova-lite-v1:0',
      pollyVoiceId: 'Joanna',
      pollyEngine: 'neural',
      demoDailyRequestCap: 600,
      tableName: 'citydesk-user-requests',
      placeIndexName: 'citydesk-places',
    });
    expect(DEFAULTS.demoDailyRequestCap).toBe(600);
  });

  it('takes overrides from the environment and treats blank values as unset', () => {
    const config = loadDeployConfig({
      BEDROCK_MODEL_ID: ' amazon.nova-lite-v1:0 ',
      POLLY_VOICE_ID: 'Matthew',
      POLLY_ENGINE: 'generative',
      DEMO_DAILY_REQUEST_CAP: '500',
      CITYDESK_TABLE: '',
      LOCATION_PLACE_INDEX: 'my-places',
    });
    expect(config).toEqual({
      bedrockModelId: 'amazon.nova-lite-v1:0',
      pollyVoiceId: 'Matthew',
      pollyEngine: 'generative',
      demoDailyRequestCap: 500,
      tableName: 'citydesk-user-requests',
      placeIndexName: 'my-places',
    });
  });

  it('rejects values that would only fail later at runtime', () => {
    const base = { BEDROCK_MODEL_ID: 'amazon.nova-lite-v1:0' };
    expect(() => loadDeployConfig({ ...base, POLLY_ENGINE: 'robot' })).toThrow(/POLLY_ENGINE must be one of/);
    expect(() => loadDeployConfig({ ...base, DEMO_DAILY_REQUEST_CAP: 'lots' })).toThrow(/positive whole number/);
    expect(() => loadDeployConfig({ ...base, DEMO_DAILY_REQUEST_CAP: '0' })).toThrow(/positive whole number/);
    expect(() => loadDeployConfig({ BEDROCK_MODEL_ID: 'two words' })).toThrow(/whitespace/);
  });
});

describe('resolveRegion', () => {
  it('defaults to us-east-1 and prefers AWS_REGION', () => {
    expect(resolveRegion({})).toBe('us-east-1');
    expect(resolveRegion({ AWS_DEFAULT_REGION: 'eu-west-1' })).toBe('eu-west-1');
    expect(resolveRegion({ AWS_REGION: 'us-west-2', AWS_DEFAULT_REGION: 'eu-west-1' })).toBe('us-west-2');
    expect(resolveRegion({ AWS_REGION: ' ' })).toBe('us-east-1');
  });
});
