/**
 * The assistant's conversation loop: one user utterance in, one short reply out, with as many
 * tool rounds in between as the model asks for (up to a cap).
 *
 * This module is environment-agnostic on purpose. It knows nothing about fetch, Bedrock, MCP
 * transports or the DOM: the caller hands it a `converse` function and a `callTool` function.
 * The browser passes a `converse` that POSTs to `/api/converse` and a `callTool` backed by the
 * live MCP session; `scripts/conversation.ts` passes a `converse` that calls Bedrock directly.
 */

import { guardReply, splitSentences, type GuardedReply } from './guard.ts';
import { toToolConfig } from './tools.ts';
import {
  isTextBlock,
  isToolResultBlock,
  isToolUseBlock,
  type CallToolFn,
  type ContentBlock,
  type ConverseFn,
  type McpToolLike,
  type McpToolResultLike,
  type Message,
  type TokenUsage,
  type ToolResultBlock,
  type ToolResultContent,
  type ToolUseBlock,
} from './types.ts';

export const DEFAULT_MAX_TOOL_ROUNDS = 4;
export const DEFAULT_MAX_HISTORY_MESSAGES = 24;
/** Said when the model produced nothing usable and no tool offered a summary to fall back on. */
export const FALLBACK_REPLY = "Sorry, I couldn't finish that. Please try again.";

const MAX_TOOL_TEXT_CHARS = 6_000;
const MAX_STRUCTURED_CHARS = 24_000;

/** How `structuredContent` is fed back: as a Converse `json` block, or as JSON inside a text block. */
export type StructuredFormat = 'json' | 'text';

export interface ToolCallRecord {
  /** MCP tool name, or the name the model asked for when it does not exist. */
  name: string;
  arguments: Record<string, unknown>;
  toolUseId: string;
  /** 1-based tool round this call belonged to. */
  round: number;
  durationMs: number;
  /** True when the tool reported an error, could not be called, or is not available to the model. */
  isError: boolean;
  /** `structuredContent.outcome` when the tool returned one (CityDesk tools always do). */
  outcome?: string;
  /** `structuredContent.spoken_summary` when the tool returned one. */
  spokenSummary?: string;
  /** Set when the call threw (transport, timeout) or was refused by the loop. */
  error?: string;
  result?: McpToolResultLike;
}

export type LoopEvent =
  | { type: 'converse-start'; call: number }
  | { type: 'converse-end'; call: number; stopReason: string; latencyMs?: number; usage?: TokenUsage }
  | { type: 'tool-start'; round: number; name: string; arguments: Record<string, unknown>; toolUseId: string }
  | { type: 'tool-end'; round: number; record: ToolCallRecord };

export interface RunTurnOptions {
  converse: ConverseFn;
  callTool: CallToolFn;
  /** The server's `tools/list` entries, unfiltered. App-only tools are hidden here, not by the caller. */
  tools: readonly McpToolLike[];
  /** Conversation so far, as returned in `TurnResult.messages` by the previous turn. */
  history: readonly Message[];
  userText: string;
  /** Maximum rounds in which tools are executed. One more Converse call follows to get the reply. */
  maxToolRounds?: number;
  maxHistoryMessages?: number;
  structuredFormat?: StructuredFormat;
  onEvent?: (event: LoopEvent) => void;
  signal?: AbortSignal;
}

export type TurnEnding =
  /** The model answered in text. */
  | 'reply'
  /** The model still wanted tools after the last allowed round. */
  | 'round_cap'
  /** The model returned no usable text (empty reply, truncated tool call, content filter). */
  | 'no_text'
  /** A Converse call failed after tools had already run; the reply is the last tool's own summary. */
  | 'converse_failed';

export interface TurnResult {
  /** The guarded reply: at most two sentences, no long IDs. This is what gets shown and spoken. */
  reply: string;
  /** The model's text before the guard (or the fallback text when the model gave none). */
  rawReply: string;
  guard: GuardedReply;
  ending: TurnEnding;
  /** Updated conversation, valid as `history` for the next turn. */
  messages: Message[];
  toolCalls: ToolCallRecord[];
  /** Number of rounds in which tools ran. */
  toolRounds: number;
  converseCalls: number;
  stopReason: string;
  usage: TokenUsage;
  /** Sum of the Converse latencies reported by `converse`. */
  converseLatencyMs: number;
  /** Message of the Converse error when `ending` is `converse_failed`. */
  error?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
  }
}

function isTurnStart(message: Message): boolean {
  return message.role === 'user' && !message.content.some(isToolResultBlock);
}

/**
 * Drops the oldest whole turns until at most `maxMessages` remain. A turn starts at a user message
 * typed or spoken by the resident, so a tool use is never separated from its tool result.
 */
export function trimHistory(history: readonly Message[], maxMessages: number): Message[] {
  if (history.length <= maxMessages) return [...history];
  const starts: number[] = [];
  history.forEach((message, index) => {
    if (isTurnStart(message)) starts.push(index);
  });
  for (const start of starts) {
    if (history.length - start <= maxMessages) return history.slice(start);
  }
  const last = starts.at(-1);
  return last === undefined ? [] : history.slice(last);
}

function describeNonText(block: { type: string }): string {
  return `[${block.type.replace(/_/g, ' ')} omitted]`;
}

function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)} [truncated]`;
}

/**
 * Turns an MCP tool result into the Converse `toolResult` block: the text content first, then the
 * structured content as JSON. Binary content (images, audio) is named but not forwarded.
 */
export function toToolResultBlock(
  toolUseId: string,
  result: McpToolResultLike,
  format: StructuredFormat = 'json',
): ToolResultBlock {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      if (block.text.trim()) parts.push(block.text);
    } else {
      parts.push(describeNonText(block));
    }
  }

  const content: ToolResultContent[] = [];
  const text = clip(parts.join('\n'), MAX_TOOL_TEXT_CHARS);
  if (text) content.push({ text });

  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    const structured = isPlainObject(result.structuredContent)
      ? result.structuredContent
      : { value: result.structuredContent };
    const serialized = JSON.stringify(structured);
    if (serialized.length > MAX_STRUCTURED_CHARS) {
      content.push({ text: '[structured content omitted: too large]' });
    } else if (format === 'json') {
      content.push({ json: structured });
    } else {
      content.push({ text: serialized });
    }
  }

  if (content.length === 0) {
    content.push({ text: result.isError ? 'The tool failed without giving a reason.' : 'Done.' });
  }
  return { toolResult: { toolUseId, content, ...(result.isError ? { status: 'error' as const } : {}) } };
}

function errorToolResult(toolUseId: string, message: string): ToolResultBlock {
  return { toolResult: { toolUseId, content: [{ text: message }], status: 'error' } };
}

function readStructured(result: McpToolResultLike): { outcome?: string; spokenSummary?: string } {
  if (!isPlainObject(result.structuredContent)) return {};
  const { outcome, spoken_summary: spokenSummary } = result.structuredContent;
  return {
    ...(typeof outcome === 'string' ? { outcome } : {}),
    ...(typeof spokenSummary === 'string' && spokenSummary.trim() ? { spokenSummary } : {}),
  };
}

function textOf(message: Message): string {
  return message.content
    .filter(isTextBlock)
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join(' ');
}

/** When the model ran out of tokens mid-sentence, keeps only the sentences it finished. */
function dropCutOffSentence(text: string, stopReason: string): string {
  if (stopReason !== 'max_tokens' || /[.!?…]["')\]”’]*$/.test(text)) return text;
  const sentences = splitSentences(text);
  return sentences.length > 1 ? sentences.slice(0, -1).join(' ') : text;
}

function lastSpokenSummary(toolCalls: readonly ToolCallRecord[]): string | undefined {
  for (let i = toolCalls.length - 1; i >= 0; i -= 1) {
    const summary = toolCalls[i]?.spokenSummary;
    if (summary) return summary;
  }
  return undefined;
}

/** Runs one user turn to completion. Throws only when no reply can be produced at all. */
export async function runAssistantTurn(options: RunTurnOptions): Promise<TurnResult> {
  const {
    converse,
    callTool,
    onEvent,
    signal,
    maxToolRounds = DEFAULT_MAX_TOOL_ROUNDS,
    maxHistoryMessages = DEFAULT_MAX_HISTORY_MESSAGES,
    structuredFormat = 'json',
  } = options;

  const userText = options.userText.trim();
  if (!userText) throw new Error('The user turn is empty.');

  const { toolConfig, mcpNameFor } = toToolConfig(options.tools);
  const messages: Message[] = [
    ...trimHistory(options.history, maxHistoryMessages),
    { role: 'user', content: [{ text: userText }] },
  ];

  const toolCalls: ToolCallRecord[] = [];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let converseLatencyMs = 0;
  let converseCalls = 0;
  let toolRounds = 0;
  let stopReason = '';

  const finish = (ending: TurnEnding, modelText: string, error?: string): TurnResult => {
    const rawReply = modelText.trim() || lastSpokenSummary(toolCalls) || FALLBACK_REPLY;
    const guard = guardReply(rawReply);
    const reply = guard.text || FALLBACK_REPLY;
    // Store what the resident actually heard, so the model's memory matches the conversation.
    messages.push({ role: 'assistant', content: [{ text: reply }] });
    return {
      reply,
      rawReply,
      guard,
      ending,
      messages,
      toolCalls,
      toolRounds,
      converseCalls,
      stopReason,
      usage,
      converseLatencyMs,
      ...(error === undefined ? {} : { error }),
    };
  };

  const runTool = async (toolUse: ToolUseBlock['toolUse'], round: number): Promise<ToolResultBlock> => {
    const args = isPlainObject(toolUse.input) ? toolUse.input : {};
    const mcpName = mcpNameFor.get(toolUse.name);
    const started = Date.now();

    if (mcpName === undefined) {
      // Unknown to the model's tool list: a made-up name, or an app-only tool it should not know.
      const record: ToolCallRecord = {
        name: toolUse.name,
        arguments: args,
        toolUseId: toolUse.toolUseId,
        round,
        durationMs: 0,
        isError: true,
        error: 'not available to the assistant',
      };
      toolCalls.push(record);
      onEvent?.({ type: 'tool-end', round, record });
      return errorToolResult(toolUse.toolUseId, `There is no tool named "${toolUse.name}".`);
    }

    onEvent?.({ type: 'tool-start', round, name: mcpName, arguments: args, toolUseId: toolUse.toolUseId });
    let record: ToolCallRecord;
    let block: ToolResultBlock;
    try {
      const result = await callTool(mcpName, args, { signal });
      record = {
        name: mcpName,
        arguments: args,
        toolUseId: toolUse.toolUseId,
        round,
        durationMs: Date.now() - started,
        isError: result.isError === true,
        ...readStructured(result),
        result,
      };
      block = toToolResultBlock(toolUse.toolUseId, result, structuredFormat);
    } catch (error) {
      throwIfAborted(signal);
      const message = errorMessage(error);
      record = {
        name: mcpName,
        arguments: args,
        toolUseId: toolUse.toolUseId,
        round,
        durationMs: Date.now() - started,
        isError: true,
        error: message,
      };
      block = errorToolResult(toolUse.toolUseId, `The tool call failed: ${message}`);
    }
    toolCalls.push(record);
    onEvent?.({ type: 'tool-end', round, record });
    return block;
  };

  for (;;) {
    throwIfAborted(signal);
    const call = converseCalls + 1;
    onEvent?.({ type: 'converse-start', call });

    let response;
    try {
      response = await converse({ messages, ...(toolConfig ? { toolConfig } : {}) }, { signal });
    } catch (error) {
      throwIfAborted(signal);
      // Tools may already have had effects (a report was filed). Rather than lose the turn, say the
      // tool's own summary. With no tool result to fall back on there is nothing honest to say.
      if (lastSpokenSummary(toolCalls)) return finish('converse_failed', '', errorMessage(error));
      throw error;
    }
    converseCalls = call;
    stopReason = response.stopReason;
    if (response.usage) {
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      usage.totalTokens += response.usage.totalTokens;
    }
    converseLatencyMs += response.latencyMs ?? 0;
    onEvent?.({
      type: 'converse-end',
      call,
      stopReason,
      ...(response.latencyMs === undefined ? {} : { latencyMs: response.latencyMs }),
      ...(response.usage ? { usage: response.usage } : {}),
    });

    const content: ContentBlock[] = response.message.content.filter(
      (block) => isToolUseBlock(block) || (isTextBlock(block) && block.text.trim() !== ''),
    );
    const assistant: Message = { role: 'assistant', content };
    const toolUses = content.filter(isToolUseBlock);

    // Tools run only when the model stopped in order to use them. With any other stop reason
    // (max_tokens, malformed_tool_use, a content filter) a tool use block may be cut short, so its
    // input cannot be trusted and whatever text came with it is a preamble, not an answer.
    const wantsTools = toolUses.length > 0 && (stopReason === 'tool_use' || stopReason === 'end_turn');
    if (!wantsTools) {
      const text = toolUses.length > 0 ? '' : dropCutOffSentence(textOf(assistant), stopReason);
      return finish(text ? 'reply' : 'no_text', text);
    }

    if (toolRounds >= maxToolRounds) {
      // The assistant message is not appended: its tool uses would have no results.
      return finish('round_cap', '');
    }

    toolRounds += 1;
    messages.push(assistant);
    const results: ToolResultBlock[] = [];
    for (const { toolUse } of toolUses) {
      throwIfAborted(signal);
      results.push(await runTool(toolUse, toolRounds));
    }
    messages.push({ role: 'user', content: results });
  }
}
