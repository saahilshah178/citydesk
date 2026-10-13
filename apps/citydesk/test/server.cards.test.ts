/**
 * The assembled server: the six tools, the two cards they link to, and the cards-only map tool.
 */
import { describe, expect, it } from 'vitest';
import { cardHooks } from '../src/cardsHook.ts';
import { CARD_MIME_TYPE, ISSUE_CARD_URI, SCHEDULE_CARD_URI, STATIC_MAP_TOOL, TOOL_NAMES, type IssueResult } from '../src/contract.ts';
import { harness } from './harness.ts';

type UiMeta = { ui?: { resourceUri?: string; visibility?: string[] } };

describe('CityDesk server with cards', () => {
  it('links every issue tool to the issue card and the schedule tool to the schedule card', async () => {
    const h = harness({ hooks: cardHooks() });
    const client = await h.connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ['report_issue', 'find_nearby_reports', 'follow_request', 'my_requests', 'request_status']) {
      expect((byName.get(name)!._meta as UiMeta).ui?.resourceUri).toBe(ISSUE_CARD_URI);
    }
    expect((byName.get('collection_schedule')!._meta as UiMeta).ui?.resourceUri).toBe(SCHEDULE_CARD_URI);
  });

  it('adds static_map for cards only, so the assistant still sees exactly six tools', async () => {
    const h = harness({ hooks: cardHooks() });
    const client = await h.connect();
    const { tools } = await client.listTools();
    const map = tools.find((t) => t.name === STATIC_MAP_TOOL)!;
    expect((map._meta as UiMeta).ui?.visibility).toEqual(['app']);
    const forAssistant = tools.filter((t) => ((t._meta as UiMeta | undefined)?.ui?.visibility ?? ['model', 'app']).includes('model'));
    expect(forAssistant.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('serves both cards as MCP Apps resources', async () => {
    const h = harness({ hooks: cardHooks() });
    const client = await h.connect();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual([ISSUE_CARD_URI, SCHEDULE_CARD_URI].sort());
    for (const uri of [ISSUE_CARD_URI, SCHEDULE_CARD_URI]) {
      const read = await client.readResource({ uri });
      const content = read.contents[0] as { mimeType?: string; text?: string };
      expect(content.mimeType).toBe(CARD_MIME_TYPE);
      expect(content.text).toMatch(/^<!doctype html>/i);
    }
  });

  it('static_map: returns the provider image, refuses points outside the city, and fails with a structured error when maps are off', async () => {
    const calls: unknown[] = [];
    const withMaps = harness({
      hooks: cardHooks(),
      staticMap: async (input) => {
        calls.push(input);
        return { data: Buffer.from('fake-png').toString('base64'), mimeType: 'image/png' };
      },
    });
    const client = await withMaps.connect();
    const ok = await client.callTool({ name: STATIC_MAP_TOOL, arguments: { lat: 42.3493, long: -71.0782, width: 640, height: 360 } });
    expect(ok.isError).toBeFalsy();
    expect(ok.content).toEqual([{ type: 'image', data: Buffer.from('fake-png').toString('base64'), mimeType: 'image/png' }]);
    expect(calls).toEqual([{ lat: 42.3493, long: -71.0782, width: 640, height: 360 }]);

    const paris = await client.callTool({ name: STATIC_MAP_TOOL, arguments: { lat: 48.8566, long: 2.3522, width: 640, height: 360 } });
    expect(paris.isError).toBe(true);
    expect((paris.structuredContent as { error: { code: string } }).error.code).toBe('outside_service_area');
    expect(calls).toHaveLength(1);

    const off = harness({ hooks: cardHooks() });
    const none = await (await off.connect()).callTool({ name: STATIC_MAP_TOOL, arguments: { lat: 42.3493, long: -71.0782, width: 640, height: 360 } });
    expect(none.isError).toBe(true);
    expect((none.structuredContent as { error: { code: string; retryable: boolean } }).error).toMatchObject({ code: 'not_configured', retryable: false });
  });

  it('tool results are unchanged by the cards: the spoken summary still stands alone', async () => {
    const h = harness({ hooks: cardHooks() });
    const client = await h.connect();
    const r = await h.call<IssueResult>(client, 'report_issue', { issue_type: 'pothole', description: 'Pothole', location: '1079 Commonwealth Avenue' });
    expect(r.data.outcome).toBe('possible_duplicate');
    expect(r.text).toMatch(/already reported a pothole at 1079-1089 Commonwealth Ave/);
  });
});
