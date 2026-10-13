import { describe, expect, it } from 'vitest';
import { isAppCallable, isModelVisible, toToolConfig } from '../src/assistant/tools.ts';
import type { McpToolLike } from '../src/assistant/types.ts';

const schema = { type: 'object', properties: { issue_type: { type: 'string' } }, required: ['issue_type'] };

describe('tool visibility', () => {
  const cases: Array<[label: string, meta: Record<string, unknown> | undefined, model: boolean, app: boolean]> = [
    ['no _meta', undefined, true, true],
    ['a card but no visibility', { ui: { resourceUri: 'ui://x/card.html' } }, true, true],
    ['model and app', { ui: { visibility: ['model', 'app'] } }, true, true],
    ['app only', { ui: { visibility: ['app'] } }, false, true],
    ['model only', { ui: { visibility: ['model'] } }, true, false],
    ['an empty list', { ui: { visibility: [] } }, false, false],
    ['a malformed value', { ui: { visibility: 'app' } }, true, true],
  ];

  it.each(cases)('with %s', (_label, meta, model, app) => {
    const tool: McpToolLike = { name: 't', ...(meta ? { _meta: meta } : {}) };
    expect(isModelVisible(tool)).toBe(model);
    expect(isAppCallable(tool)).toBe(app);
  });
});

describe('toToolConfig', () => {
  it('converts tools/list entries into Converse tool specs', () => {
    const { toolConfig, mcpNameFor } = toToolConfig([
      { name: 'report_issue', description: 'Report a city issue.', inputSchema: schema },
    ]);

    expect(toolConfig).toEqual({
      tools: [{ toolSpec: { name: 'report_issue', description: 'Report a city issue.', inputSchema: { json: schema } } }],
    });
    expect([...mcpNameFor]).toEqual([['report_issue', 'report_issue']]);
  });

  it('hides app-only tools from the model', () => {
    const { toolConfig, mcpNameFor } = toToolConfig([
      { name: 'report_issue', description: 'Report.', inputSchema: schema },
      { name: 'static_map', description: 'Map for cards.', inputSchema: schema, _meta: { ui: { visibility: ['app'] } } },
      { name: 'my_requests', description: 'List.', inputSchema: schema, _meta: { ui: { visibility: ['model', 'app'] } } },
    ]);

    expect(toolConfig?.tools.map((tool) => tool.toolSpec.name)).toEqual(['report_issue', 'my_requests']);
    expect(mcpNameFor.has('static_map')).toBe(false);
  });

  it('returns no toolConfig when nothing is visible to the model', () => {
    expect(toToolConfig([]).toolConfig).toBeUndefined();
    expect(toToolConfig([{ name: 'static_map', _meta: { ui: { visibility: ['app'] } } }]).toolConfig).toBeUndefined();
  });

  it('falls back to the title, then the name, for a missing description', () => {
    const { toolConfig } = toToolConfig([
      { name: 'a', title: 'Tool A', description: '   ' },
      { name: 'b' },
    ]);
    expect(toolConfig?.tools.map((tool) => tool.toolSpec.description)).toEqual(['Tool A', 'b']);
  });

  it('drops $schema, forces an object schema, and tolerates a missing one', () => {
    const { toolConfig } = toToolConfig([
      { name: 'a', inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', properties: { x: { type: 'number' } } } },
      { name: 'b' },
    ]);
    expect(toolConfig?.tools[0]?.toolSpec.inputSchema.json).toEqual({ type: 'object', properties: { x: { type: 'number' } } });
    expect(toolConfig?.tools[1]?.toolSpec.inputSchema.json).toEqual({ type: 'object', properties: {} });
  });

  it('makes names Converse-safe and maps them back to the MCP names', () => {
    const { toolConfig, mcpNameFor } = toToolConfig([
      { name: 'city.report/issue' },
      { name: 'city_report_issue' },
      { name: 'x'.repeat(80) },
    ]);
    const names = toolConfig?.tools.map((tool) => tool.toolSpec.name) ?? [];

    expect(names).toEqual(['city_report_issue', 'city_report_issue_2', 'x'.repeat(64)]);
    for (const name of names) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(mcpNameFor.get('city_report_issue')).toBe('city.report/issue');
    expect(mcpNameFor.get('city_report_issue_2')).toBe('city_report_issue');
    expect(mcpNameFor.get('x'.repeat(64))).toBe('x'.repeat(80));
  });
});
