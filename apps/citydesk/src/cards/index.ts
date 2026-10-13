/**
 * MCP Apps cards for CityDesk: the two `ui://` resources and the tool metadata that links to them.
 *
 *   registerCards(server);                                              // once per McpServer
 *   server.registerTool('report_issue', { ..., _meta: cardToolMeta(ISSUE_CARD_URI) }, handler);
 *   server.registerTool(STATIC_MAP_TOOL, { ..., _meta: cardOnlyToolMeta() }, handler);
 *
 * The HTML lives in ./generated.ts, built from apps/citydesk/cards by `pnpm build:cards`.
 */
import { registerAppResource } from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/server';
import { CARD_MIME_TYPE, ISSUE_CARD_URI, SCHEDULE_CARD_URI } from '../contract.ts';
import { ISSUE_CARD_HTML, SCHEDULE_CARD_HTML } from './generated.ts';

export { CARD_BUILD, ISSUE_CARD_HTML, SCHEDULE_CARD_HTML } from './generated.ts';

/** The card URIs this module serves. */
export type CardUri = typeof ISSUE_CARD_URI | typeof SCHEDULE_CARD_URI;

/** Where Boston's Open311 photos (`media_url`) are hosted. */
export const BOSTON_PHOTO_ORIGIN = 'https://spot-boston-res.cloudinary.com';

/** What a card may load, as MCP Apps `_meta.ui.csp`. Hosts turn this into the iframe's CSP. */
export interface CardCsp {
  /** Origins for images (img-src and the other static resource directives). */
  resourceDomains: string[];
}

/** `_meta.ui` of a card resource. */
export interface CardResourceUi {
  csp?: CardCsp;
  prefersBorder: boolean;
}

export interface RegisterCardsOptions {
  /**
   * Origins request photos may load from, e.g. "https://images.example.gov". Defaults to Boston's
   * photo host. Pass every origin the configured cities use for `media_url`; a photo from any other
   * origin is blocked by the host's CSP and the card simply hides it.
   */
  photoOrigins?: readonly string[];
}

interface CardSpec {
  uri: CardUri;
  name: string;
  title: string;
  description: string;
  html: string;
  /** Only the issue card shows photos, so only it asks for an image origin. */
  loadsPhotos: boolean;
}

const CARDS: readonly CardSpec[] = [
  {
    uri: ISSUE_CARD_URI,
    name: 'citydesk-issue-card',
    title: 'Service request card',
    description:
      'Shows one city service request or a short list of them: map, status timeline, request ID and photo.',
    html: ISSUE_CARD_HTML,
    loadsPhotos: true,
  },
  {
    uri: SCHEDULE_CARD_URI,
    name: 'citydesk-schedule-card',
    title: 'Collection schedule card',
    description: 'Shows the next trash and recycling pickups for an address and the next 14 days.',
    html: SCHEDULE_CARD_HTML,
    loadsPhotos: false,
  },
];

function cardUi(card: CardSpec, photoOrigins: readonly string[]): CardResourceUi {
  // The cards are single files: scripts, styles and the static map (a data: URL) are all inline.
  // With no `csp` the host applies its default policy, which allows no outside origin at all.
  const ui: CardResourceUi = { prefersBorder: true };
  if (card.loadsPhotos && photoOrigins.length > 0) ui.csp = { resourceDomains: [...photoOrigins] };
  return ui;
}

/**
 * Registers both card resources on the server with the MCP Apps MIME type
 * (`text/html;profile=mcp-app`). `_meta.ui` is set on the `resources/list` entry and on the
 * `resources/read` content item, because hosts read the content item first and fall back to the
 * listing.
 */
export function registerCards(server: McpServer, options: RegisterCardsOptions = {}): void {
  const photoOrigins = options.photoOrigins ?? [BOSTON_PHOTO_ORIGIN];
  for (const card of CARDS) {
    const ui = cardUi(card, photoOrigins);
    registerAppResource(
      server,
      card.name,
      card.uri,
      { title: card.title, description: card.description, mimeType: CARD_MIME_TYPE, _meta: { ui } },
      () => ({
        contents: [{ uri: card.uri, mimeType: CARD_MIME_TYPE, text: card.html, _meta: { ui } }],
      }),
    );
  }
}

/** `_meta` of a tool that shows a card. */
export interface CardToolMeta {
  [key: string]: unknown;
  ui: { resourceUri: CardUri };
  /** The pre-1.0 flat key. ext-apps `registerAppTool` still writes it, and older hosts read only this. */
  'ui/resourceUri': CardUri;
}

/**
 * The `_meta` a tool definition needs so hosts render `uri` with the tool's result. This is the
 * same pair of keys `registerAppTool` from ext-apps writes, so a plain `server.registerTool` call
 * can use it directly.
 */
export function cardToolMeta(uri: CardUri): CardToolMeta {
  return { ui: { resourceUri: uri }, 'ui/resourceUri': uri };
}

/** `_meta` of a tool only the cards call. */
export interface CardOnlyToolMeta {
  [key: string]: unknown;
  ui: { visibility: ['app'] };
}

/**
 * The `_meta` for a tool that only the cards call (`static_map`): `visibility: ["app"]` keeps it
 * out of the assistant's tool list while cards can still reach it through the host.
 */
export function cardOnlyToolMeta(): CardOnlyToolMeta {
  return { ui: { visibility: ['app'] } };
}
