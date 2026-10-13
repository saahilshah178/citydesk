/**
 * Everything a card needs from the MCP Apps host, built on the ext-apps `App` class:
 * the ui/initialize handshake, tool results, host context (theme, style variables, fonts, container
 * size), size reporting, server tool calls (static_map) and user messages (clarification chips).
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import { STATIC_MAP_TOOL, type StaticMapInput } from '../../../src/contract.ts';
import { safeTimeZone } from './format.ts';
import { renderLoading, renderMessage } from './views.ts';

/** The Echo Show authoring base: design at 768x480; a 1280x800 screen shows it at 1280 / 768 = 1.667. */
const BASE_WIDTH = 768;
const BASE_HEIGHT = 480;
const BASE_FONT_PX = 16;
/** Largest scale used when the host lets the card pick its own height (an inline chat card). */
const MAX_FLEXIBLE_SCALE = 1280 / BASE_WIDTH;
const MAP_PIXEL_MIN = 64;
const MAP_PIXEL_MAX = 1024;

/** A tool result reduced to what the cards read. */
export interface ToolPayload {
  /** structuredContent, when the host passed one. Unvalidated. */
  data: unknown;
  /** The text content blocks joined together (the spoken summary). */
  text: string;
  isError: boolean;
}

export interface CardContext {
  readonly app: App;
  readonly stage: HTMLElement;
  /** The user's IANA time zone from the host, when it sent a usable one. */
  timeZone(): string | undefined;
  /** Posts `text` to the conversation as a user message. Resolves false when the host refused or failed. */
  say(text: string): Promise<boolean>;
  /** A map image as a data: URL from the server's static_map tool, or null when it is unavailable. */
  staticMap(lat: number, long: number, cssWidth: number, cssHeight: number): Promise<string | null>;
}

export interface CardDefinition {
  name: string;
  version: string;
  render(payload: ToolPayload, ctx: CardContext): void;
}

function fixedHeight(ctx: McpUiHostContext | undefined): number | undefined {
  const dims = ctx?.containerDimensions;
  if (dims && 'height' in dims && typeof dims.height === 'number' && dims.height > 0) {
    return Math.min(dims.height, window.innerHeight || dims.height);
  }
  // A fullscreen card fills whatever box the host made, even if the host did not send its height.
  if (ctx?.displayMode === 'fullscreen' && window.innerHeight > 0) return window.innerHeight;
  return undefined;
}

/** Sizes the root font so the 48rem x 30rem stage fits the container the host describes. */
function applyScale(ctx: McpUiHostContext | undefined): void {
  const root = document.documentElement;
  const width = root.clientWidth || window.innerWidth;
  if (!(width > 0)) return;

  let scale = width / BASE_WIDTH;
  const height = fixedHeight(ctx);
  if (height !== undefined) {
    scale = Math.min(scale, height / BASE_HEIGHT);
  } else {
    const dims = ctx?.containerDimensions;
    if (dims && 'maxHeight' in dims && typeof dims.maxHeight === 'number' && dims.maxHeight > 0) {
      scale = Math.min(scale, dims.maxHeight / BASE_HEIGHT);
    }
    scale = Math.min(scale, MAX_FLEXIBLE_SCALE);
  }

  root.classList.toggle('fixed', height !== undefined);
  root.style.fontSize = `${(BASE_FONT_PX * scale).toFixed(3)}px`;
}

/**
 * Applies the parts of the host context that `changed` carries. On connect that is the whole
 * context; on ui/notifications/host-context-changed it is only the fields that changed, which
 * matters because hosts send that notification in bursts while they animate the container.
 */
function applyHostContext(changed: McpUiHostContext | undefined, full: McpUiHostContext | undefined): void {
  if (changed?.theme === 'light' || changed?.theme === 'dark') applyDocumentTheme(changed.theme);
  if (changed?.styles?.variables) applyHostStyleVariables(changed.styles.variables);
  if (changed?.styles?.css?.fonts) applyHostFonts(changed.styles.css.fonts);
  applyScale(full);
}

function clampMapPixels(cssWidth: number, cssHeight: number): { width: number; height: number } {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  let width = cssWidth * ratio;
  let height = cssHeight * ratio;
  const shrink = Math.min(1, MAP_PIXEL_MAX / Math.max(width, height));
  width *= shrink;
  height *= shrink;
  // Snap to 16px steps so a re-render at a near-identical size reuses the cached image.
  const snap = (value: number) => Math.min(MAP_PIXEL_MAX, Math.max(MAP_PIXEL_MIN, Math.round(value / 16) * 16));
  return { width: snap(width), height: snap(height) };
}

export function startCard(card: CardDefinition): void {
  const stage = document.getElementById('stage');
  if (!stage) return;

  // autoResize (the default) makes the SDK report the document size with a ResizeObserver.
  const app = new App({ name: card.name, version: card.version }, {}, { autoResize: true });
  let received = false;
  const maps = new Map<string, Promise<string | null>>();
  // Host capabilities exist from the moment the ui/initialize handshake has answered.
  const connected = () => app.getHostCapabilities() !== undefined;

  const ctx: CardContext = {
    app,
    stage,
    timeZone: () => safeTimeZone(app.getHostContext()?.timeZone),

    async say(text) {
      if (!connected()) return false;
      try {
        const result = await app.sendMessage(
          { role: 'user', content: [{ type: 'text', text }] },
          { timeout: 10_000 },
        );
        return result.isError !== true;
      } catch {
        return false;
      }
    },

    staticMap(lat, long, cssWidth, cssHeight) {
      if (!app.getHostCapabilities()?.serverTools) return Promise.resolve(null);
      if (!(cssWidth > 0) || !(cssHeight > 0)) return Promise.resolve(null);
      const size = clampMapPixels(cssWidth, cssHeight);
      const key = `${lat.toFixed(6)},${long.toFixed(6)},${size.width}x${size.height}`;
      const cached = maps.get(key);
      if (cached) return cached;

      const args: StaticMapInput = { lat, long, width: size.width, height: size.height };
      const pending = app
        .callServerTool({ name: STATIC_MAP_TOOL, arguments: { ...args } }, { timeout: 12_000 })
        .then((result) => {
          if (result.isError) return null;
          for (const block of result.content) {
            if (block.type === 'image' && /^image\/(png|jpeg|webp|gif)$/.test(block.mimeType) && block.data) {
              return `data:${block.mimeType};base64,${block.data}`;
            }
          }
          return null;
        })
        .catch(() => null);
      maps.set(key, pending);
      return pending;
    },
  };

  const draw = (payload: ToolPayload) => {
    try {
      card.render(payload, ctx);
    } catch (error) {
      renderMessage(stage, {
        eyebrow: 'CityDesk',
        icon: 'alert',
        title: 'This card could not be drawn',
        body: payload.text || (error instanceof Error ? error.message : String(error)),
      });
    }
  };

  // Listeners go on before connect(): the host sends the tool result right after the handshake.
  app.addEventListener('toolinput', () => {
    if (!received) renderLoading(stage);
  });
  app.addEventListener('toolresult', (result) => {
    received = true;
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .filter((part) => part !== '')
      .join(' ');
    draw({ data: result.structuredContent, text, isError: result.isError === true });
  });
  app.addEventListener('toolcancelled', (params) => {
    if (received) return;
    // No claim about what did or did not happen on the city's side: the card cannot know.
    renderMessage(stage, {
      eyebrow: 'CityDesk',
      icon: 'alert',
      title: 'That request was cancelled',
      body: params.reason,
    });
  });
  // The SDK has already merged `changed` into getHostContext() when this fires.
  app.addEventListener('hostcontextchanged', (changed) => applyHostContext(changed, app.getHostContext()));
  window.addEventListener('resize', () => applyScale(app.getHostContext()));

  applyScale(undefined);
  renderLoading(stage);

  if (window.parent === window) {
    renderMessage(stage, {
      eyebrow: 'CityDesk',
      icon: 'alert',
      title: 'This card needs an assistant to show it',
      body: 'Open it from an MCP Apps host, which passes the card its data.',
    });
    return;
  }

  app.connect().then(
    () => applyHostContext(app.getHostContext(), app.getHostContext()),
    (error: unknown) => {
      renderMessage(stage, {
        eyebrow: 'CityDesk',
        icon: 'alert',
        title: 'Could not reach the assistant',
        body: error instanceof Error ? error.message : String(error),
      });
    },
  );
}
