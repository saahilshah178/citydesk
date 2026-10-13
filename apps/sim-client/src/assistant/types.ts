/**
 * Message shapes shared by the conversation loop, the browser, the backend route and the Node
 * runner.
 *
 * These are a structural subset of the Amazon Bedrock Converse API types (`Message`,
 * `ContentBlock`, `ToolConfiguration` in `@aws-sdk/client-bedrock-runtime`). They are declared
 * here, without importing the AWS SDK, so the loop stays environment-agnostic and the browser
 * bundle never pulls the SDK in. `server/bedrock.ts` is the one place that maps them onto the SDK.
 */

export type ConverseRole = 'user' | 'assistant';

export interface TextBlock {
  text: string;
}

export interface ToolUseBlock {
  toolUse: {
    toolUseId: string;
    /** The Converse-safe tool name (see `toToolConfig`), not necessarily the MCP name. */
    name: string;
    input: Record<string, unknown>;
  };
}

export type ToolResultContent = { text: string } | { json: Record<string, unknown> };

export interface ToolResultBlock {
  toolResult: {
    toolUseId: string;
    content: ToolResultContent[];
    /** Omitted on success: Bedrock documents `status` as supported only by some model families. */
    status?: 'error';
  };
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: ConverseRole;
  content: ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: { json: Record<string, unknown> };
}

export interface ToolConfig {
  tools: Array<{ toolSpec: ToolSpec }>;
}

export interface ConverseRequest {
  messages: Message[];
  /** Left out when the server exposes no model-visible tools (Bedrock rejects an empty list). */
  toolConfig?: ToolConfig;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ConverseResponse {
  /** The assistant message, reduced to non-empty text blocks and tool use blocks. */
  message: Message;
  /** Bedrock `stopReason`, e.g. `end_turn`, `tool_use`, `max_tokens`. */
  stopReason: string;
  usage?: TokenUsage;
  /** Wall-clock time of the Converse call in milliseconds, measured by whoever made it. */
  latencyMs?: number;
}

/** One Converse call. The system prompt, model ID and inference settings belong to the callee. */
export type ConverseFn = (
  request: ConverseRequest,
  options?: { signal?: AbortSignal },
) => Promise<ConverseResponse>;

/** The subset of an MCP `tools/list` entry the assistant code reads. */
export interface McpToolLike {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  _meta?: Record<string, unknown>;
}

/** The subset of an MCP `CallToolResult` the assistant code reads. */
export interface McpToolResultLike {
  content?: ReadonlyArray<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/** Calls an MCP tool by its MCP name. May throw on transport or protocol failures. */
export type CallToolFn = (
  name: string,
  args: Record<string, unknown>,
  options?: { signal?: AbortSignal },
) => Promise<McpToolResultLike>;

export function isTextBlock(block: ContentBlock): block is TextBlock {
  return typeof (block as TextBlock).text === 'string';
}

export function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return typeof (block as ToolUseBlock).toolUse === 'object' && (block as ToolUseBlock).toolUse !== null;
}

export function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return (
    typeof (block as ToolResultBlock).toolResult === 'object' && (block as ToolResultBlock).toolResult !== null
  );
}
