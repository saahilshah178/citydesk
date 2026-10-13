/**
 * The one place that talks to Amazon Bedrock. Maps the loop's message types onto the Converse API
 * (`ConverseCommand` in AWS SDK v3) and back. Used by the `/api/converse` route and by
 * `scripts/conversation.ts`, so the browser and the headless runner send identical requests.
 */

import {
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type Message as BedrockMessage,
  type ToolConfiguration,
} from '@aws-sdk/client-bedrock-runtime';
import type {
  ContentBlock,
  ConverseFn,
  ConverseRequest,
  ConverseResponse,
  Message,
  TokenUsage,
} from '../src/assistant/types.ts';

/** The slice of `BedrockRuntimeClient` this module needs. Tests pass a fake. */
export interface BedrockLike {
  send(command: ConverseCommand, options?: { abortSignal?: AbortSignal }): Promise<ConverseCommandOutput>;
}

export interface ConverseSettings {
  modelId: string;
  system: string;
  maxTokens: number;
  temperature?: number | undefined;
}

export function buildConverseInput(request: ConverseRequest, settings: ConverseSettings): ConverseCommandInput {
  return {
    modelId: settings.modelId,
    system: [{ text: settings.system }],
    // The loop's blocks are a structural subset of the SDK's unions (text, toolUse, toolResult).
    messages: request.messages as unknown as BedrockMessage[],
    inferenceConfig: {
      maxTokens: settings.maxTokens,
      ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
    },
    ...(request.toolConfig ? { toolConfig: request.toolConfig as unknown as ToolConfiguration } : {}),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keeps non-empty text and well-formed tool use blocks; drops reasoning and anything else. */
export function normalizeOutputMessage(output: ConverseCommandOutput['output']): Message {
  const content: ContentBlock[] = [];
  for (const block of output?.message?.content ?? []) {
    if (typeof block.text === 'string') {
      if (block.text.trim()) content.push({ text: block.text });
    } else if (block.toolUse?.toolUseId && block.toolUse.name) {
      content.push({
        toolUse: {
          toolUseId: block.toolUse.toolUseId,
          name: block.toolUse.name,
          input: isPlainObject(block.toolUse.input) ? block.toolUse.input : {},
        },
      });
    }
  }
  return { role: 'assistant', content };
}

function normalizeUsage(usage: ConverseCommandOutput['usage']): TokenUsage | undefined {
  if (!usage) return undefined;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  return { inputTokens, outputTokens, totalTokens: usage.totalTokens ?? inputTokens + outputTokens };
}

export interface ConverseOutcome extends ConverseResponse {
  /** Wall-clock time of the SDK call. */
  latencyMs: number;
  /** Bedrock's own `metrics.latencyMs`, when it reports one. */
  modelLatencyMs?: number;
}

export async function converseOnce(
  client: BedrockLike,
  request: ConverseRequest,
  settings: ConverseSettings,
  options: { signal?: AbortSignal; now?: () => number } = {},
): Promise<ConverseOutcome> {
  const now = options.now ?? Date.now;
  const started = now();
  const output = await client.send(
    new ConverseCommand(buildConverseInput(request, settings)),
    options.signal ? { abortSignal: options.signal } : undefined,
  );
  const usage = normalizeUsage(output.usage);
  const modelLatencyMs = output.metrics?.latencyMs;
  return {
    message: normalizeOutputMessage(output.output),
    stopReason: output.stopReason ?? 'unknown',
    latencyMs: now() - started,
    ...(usage ? { usage } : {}),
    ...(typeof modelLatencyMs === 'number' ? { modelLatencyMs } : {}),
  };
}

/** A `ConverseFn` bound to one client and one set of settings, for the Node runner. */
export function createDirectConverse(client: BedrockLike, settings: () => ConverseSettings): ConverseFn {
  return (request, options) => converseOnce(client, request, settings(), options?.signal ? { signal: options.signal } : {});
}
