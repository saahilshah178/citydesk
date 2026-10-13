import type { McpToolLike, ToolConfig } from './types.ts';

/**
 * MCP Apps tool visibility (`_meta.ui.visibility`). The default is `["model", "app"]`.
 * A host must keep tools without `"model"` out of the model's tool list, and must refuse
 * `tools/call` from a view for tools without `"app"`.
 */
export type ToolAudience = 'model' | 'app';

function readVisibility(tool: McpToolLike): string[] | undefined {
  const ui = tool._meta?.['ui'];
  if (typeof ui !== 'object' || ui === null) return undefined;
  const visibility = (ui as { visibility?: unknown }).visibility;
  if (!Array.isArray(visibility)) return undefined;
  return visibility.filter((entry): entry is string => typeof entry === 'string');
}

export function isToolVisibleTo(tool: McpToolLike, audience: ToolAudience): boolean {
  const visibility = readVisibility(tool);
  return visibility === undefined ? true : visibility.includes(audience);
}

export function isModelVisible(tool: McpToolLike): boolean {
  return isToolVisibleTo(tool, 'model');
}

export function isAppCallable(tool: McpToolLike): boolean {
  return isToolVisibleTo(tool, 'app');
}

/** Bedrock Converse tool names must match `[a-zA-Z0-9_-]+` and be at most 64 characters. */
const CONVERSE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

function converseSafeName(name: string, taken: Set<string>): string {
  const base = CONVERSE_NAME.test(name) ? name : name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'tool';
  if (!taken.has(base)) return base;
  // Two MCP names collapsed to one Converse name: keep them apart with a numeric suffix.
  for (let n = 2; ; n += 1) {
    const suffix = `_${n}`;
    const candidate = base.slice(0, 64 - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

function toInputSchema(schema: unknown): Record<string, unknown> {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  // Converse models differ in how much JSON Schema they accept at the top level of a tool schema;
  // the three keys every one of them documents are type, properties and required. Annotations such
  // as `$schema` and `additionalProperties` are dropped here. The MCP server still validates the
  // arguments against its full schema when the tool is called.
  const { properties, required } = schema as { properties?: unknown; required?: unknown };
  return {
    type: 'object',
    properties: typeof properties === 'object' && properties !== null && !Array.isArray(properties) ? properties : {},
    ...(Array.isArray(required) && required.length > 0 ? { required } : {}),
  };
}

export interface ConverseTools {
  /** `undefined` when no tool is visible to the model. */
  toolConfig: ToolConfig | undefined;
  /** Converse tool name to MCP tool name. Only model-visible tools appear here. */
  mcpNameFor: ReadonlyMap<string, string>;
}

/**
 * Converts MCP `tools/list` entries into a Converse `toolConfig`.
 * App-only tools (`_meta.ui.visibility` without `"model"`) are left out, so the model never sees
 * them and, because the loop resolves names through `mcpNameFor`, can never call them either.
 */
export function toToolConfig(tools: readonly McpToolLike[]): ConverseTools {
  const mcpNameFor = new Map<string, string>();
  const taken = new Set<string>();
  const specs: ToolConfig['tools'] = [];

  for (const tool of tools) {
    if (!isModelVisible(tool)) continue;
    const name = converseSafeName(tool.name, taken);
    taken.add(name);
    mcpNameFor.set(name, tool.name);
    const description = tool.description?.trim() || tool.title?.trim() || tool.name;
    specs.push({ toolSpec: { name, description, inputSchema: { json: toInputSchema(tool.inputSchema) } } });
  }

  return { toolConfig: specs.length > 0 ? { tools: specs } : undefined, mcpNameFor };
}
