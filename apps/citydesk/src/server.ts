import { McpServer } from '@modelcontextprotocol/server';
import type { CityDeskRuntime } from './runtime.ts';
import { registerCityDeskTools, type ToolUiMeta, type UserContext } from './tools.ts';

export const CITYDESK_NAME = 'citydesk';
export const CITYDESK_VERSION = '0.1.0';

export interface CityDeskServerHooks {
  /** Registers extra resources and tools (the MCP Apps cards) and returns the UI links for the tools. */
  extend?: (server: McpServer, rt: CityDeskRuntime, user: UserContext) => ToolUiMeta | void;
}

/** Builds the CityDesk MCP server for one resident. Cheap enough to call on every request. */
export function createCityDeskServer(rt: CityDeskRuntime, user: UserContext, hooks: CityDeskServerHooks = {}): McpServer {
  const server = new McpServer(
    { name: CITYDESK_NAME, version: CITYDESK_VERSION, title: 'CityDesk' },
    {
      instructions:
        `CityDesk handles non-emergency city services for ${rt.city.name} by voice: reporting problems, following ` +
        'existing reports, checking on requests, and trash and recycling days. Every tool result starts with a ' +
        'spoken_summary written to be said aloud; keep replies to one or two sentences. Never read long IDs aloud: ' +
        'describe a request by its type, place and date. When a result has outcome "needs_clarification", ask its ' +
        'question and call the tool again with the answer. When report_issue returns "possible_duplicate", tell the ' +
        'resident a report already exists and offer follow_request. New reports are filed in a test system, not the ' +
        'live city system. For emergencies, tell the resident to call 911.',
    },
  );
  const ui = hooks.extend?.(server, rt, user) ?? {};
  registerCityDeskTools(server, rt, user, ui);
  return server;
}
