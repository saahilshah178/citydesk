/**
 * Connects the MCP Apps cards to the tools: registers the two `ui://` resources and the cards-only
 * `static_map` tool on each server, and tells the six tools which card shows their result.
 */
import { ISSUE_CARD_URI, SCHEDULE_CARD_URI } from './contract.ts';
import { cardOnlyToolMeta, cardToolMeta, registerCards } from './cards/index.ts';
import type { CityDeskServerHooks } from './server.ts';
import { registerStaticMapTool } from './staticMapTool.ts';

export function cardHooks(): CityDeskServerHooks {
  return {
    extend(server, rt) {
      registerCards(server);
      registerStaticMapTool(server, rt, cardOnlyToolMeta());
      return { issueCard: cardToolMeta(ISSUE_CARD_URI), scheduleCard: cardToolMeta(SCHEDULE_CARD_URI) };
    },
  };
}
