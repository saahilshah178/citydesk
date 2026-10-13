import { describe, expect, it } from 'vitest';

import { bedrockInvokeGrants, classifyBedrockModelId } from '../lib/bedrock.ts';

const parts = { partition: 'aws', region: 'us-east-1', account: '111122223333' };

describe('classifyBedrockModelId', () => {
  it.each([
    ['amazon.nova-lite-v1:0', 'foundation-model'],
    ['anthropic.claude-3-haiku-20240307-v1:0', 'foundation-model'],
    ['us.amazon.nova-lite-v1:0', 'inference-profile'],
    ['eu.anthropic.claude-3-haiku-20240307-v1:0', 'inference-profile'],
    ['global.anthropic.claude-sonnet-4-5-20250929-v1:0', 'inference-profile'],
    ['us-gov.anthropic.claude-3-haiku-20240307-v1:0', 'inference-profile'],
    // A prefix the list does not know, or a model name with a dot in it: cannot be told apart.
    ['mx.example.model-v1:0', 'ambiguous'],
    ['example.model-4.6', 'ambiguous'],
    ['arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.amazon.nova-lite-v1:0', 'arn'],
  ])('%s is %s', (id, kind) => {
    expect(classifyBedrockModelId(id)).toBe(kind);
  });
});

describe('bedrockInvokeGrants', () => {
  it('scopes a plain foundation model to that model in the stack Region', () => {
    expect(bedrockInvokeGrants('amazon.nova-lite-v1:0', parts)).toEqual([
      { sid: 'InvokeAssistantModel', resources: ['arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0'] },
    ]);
  });

  it('grants a cross-Region profile plus its model in any Region, only through that profile', () => {
    const profile = 'arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.amazon.nova-lite-v1:0';
    expect(bedrockInvokeGrants('us.amazon.nova-lite-v1:0', parts)).toEqual([
      { sid: 'InvokeAssistantInferenceProfile', resources: [profile] },
      {
        sid: 'InvokeAssistantModelThroughProfile',
        resources: ['arn:aws:bedrock:*::foundation-model/amazon.nova-lite-v1:0'],
        conditions: { StringLike: { 'bedrock:InferenceProfileArn': profile } },
      },
    ]);
  });

  it('adds the Region-less foundation model ARN for a global profile', () => {
    const id = 'global.anthropic.claude-sonnet-4-5-20250929-v1:0';
    const profile = `arn:aws:bedrock:us-east-1:111122223333:inference-profile/${id}`;
    expect(bedrockInvokeGrants(id, parts)).toEqual([
      { sid: 'InvokeAssistantInferenceProfile', resources: [profile] },
      {
        sid: 'InvokeAssistantModelThroughProfile',
        resources: [
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
          'arn:aws:bedrock:::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
        ],
        conditions: { StringLike: { 'bedrock:InferenceProfileArn': profile } },
      },
    ]);
  });

  it('grants both readings of an ID it cannot classify', () => {
    const profile = 'arn:aws:bedrock:us-east-1:111122223333:inference-profile/mx.example.model-v1:0';
    expect(bedrockInvokeGrants('mx.example.model-v1:0', parts)).toEqual([
      {
        sid: 'InvokeAssistantModel',
        resources: ['arn:aws:bedrock:us-east-1::foundation-model/mx.example.model-v1:0', profile],
      },
      {
        sid: 'InvokeAssistantModelThroughProfile',
        resources: [
          'arn:aws:bedrock:*::foundation-model/example.model-v1:0',
          'arn:aws:bedrock:::foundation-model/example.model-v1:0',
        ],
        conditions: { StringLike: { 'bedrock:InferenceProfileArn': profile } },
      },
    ]);
  });

  it('accepts a system-defined inference profile ARN', () => {
    const arn = 'arn:aws:bedrock:us-west-2:111122223333:inference-profile/us.amazon.nova-lite-v1:0';
    expect(bedrockInvokeGrants(arn, parts)).toEqual([
      { sid: 'InvokeAssistantInferenceProfile', resources: [arn] },
      {
        sid: 'InvokeAssistantModelThroughProfile',
        resources: ['arn:aws:bedrock:*::foundation-model/amazon.nova-lite-v1:0'],
        conditions: { StringLike: { 'bedrock:InferenceProfileArn': arn } },
      },
    ]);
  });

  it('accepts an application inference profile ARN, with models reachable only through it', () => {
    const arn = 'arn:aws:bedrock:us-east-1:111122223333:application-inference-profile/abc123';
    expect(bedrockInvokeGrants(arn, parts)).toEqual([
      { sid: 'InvokeAssistantInferenceProfile', resources: [arn] },
      {
        sid: 'InvokeAssistantModelThroughProfile',
        resources: ['arn:aws:bedrock:*::foundation-model/*', 'arn:aws:bedrock:::foundation-model/*'],
        conditions: { StringLike: { 'bedrock:InferenceProfileArn': arn } },
      },
    ]);
  });

  it('passes any other ARN through unchanged', () => {
    const arn = 'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0';
    expect(bedrockInvokeGrants(arn, parts)).toEqual([{ sid: 'InvokeAssistantModel', resources: [arn] }]);
  });
});
