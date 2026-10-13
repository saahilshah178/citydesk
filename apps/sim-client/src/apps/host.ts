/**
 * MCP Apps host logic: read a tool's UI resource, load the sandbox proxy, connect an `AppBridge`,
 * deliver tool input and result, and answer the card's own requests.
 *
 * Ported from ext-apps `examples/basic-host/src/implementation.ts` (v2.0.3): `getUiResource`,
 * `loadSandboxProxy`, `initializeApp`, `hookInitializedCallback` and `newAppBridge`. Differences:
 *
 * - The bridge is created without an MCP client (`new AppBridge(null, ...)`) and its server-facing
 *   handlers are registered by hand. With a client, the bridge forwards every `tools/call` from a
 *   card straight to the server; the spec requires the host to refuse calls to tools whose
 *   visibility lacks "app", and going through `McpSession` also puts the card's calls in the
 *   developer drawer.
 * - The CSP travels to the proxy in `sandbox-resource-ready`, not in a `?csp=` query parameter.
 * - `ui/message` and `ui/open-link` are wired to the assistant and to a link notice.
 * - One display mode (inline), a dark theme, and a fixed container: the Echo Show card area.
 */

import {
  AppBridge,
  buildAllowAttribute,
  getToolUiResourceUri,
  PostMessageTransport,
  RESOURCE_MIME_TYPE,
  type McpUiHostContext,
  type McpUiResourceCsp,
  type McpUiResourcePermissions,
  type McpUiSandboxProxyReadyNotification,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import { ProtocolError, ProtocolErrorCode, type CallToolResult, type Tool } from '@modelcontextprotocol/client';
import { isAppCallable } from '../assistant/tools.ts';
import { CLIENT_INFO, type McpSession } from '../mcp/session.ts';
import { HOST_STYLE_VARIABLES } from './host-styles.ts';
import type { SandboxConfig } from './sandbox-config.ts';

const SANDBOX_READY_TIMEOUT_MS = 8_000;
const CARD_INIT_TIMEOUT_MS = 10_000;

export interface UiResource {
  uri: string;
  html: string;
  csp?: McpUiResourceCsp;
  permissions?: McpUiResourcePermissions;
}

/** The UI resource a tool points at, or `undefined` when it has none or the pointer is malformed. */
export function uiResourceUriOf(tool: Tool): string | undefined {
  try {
    return getToolUiResourceUri(tool);
  } catch {
    return undefined;
  }
}

function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function fetchUiResource(session: McpSession, uri: string): Promise<UiResource> {
  const resource = await session.readResource(uri);
  if (resource.contents.length !== 1) {
    throw new Error(`Expected one content item for ${uri}, got ${resource.contents.length}.`);
  }
  const content = resource.contents[0]!;
  // "text/html;profile=mcp-app" is what marks a resource as an MCP App view.
  if (content.mimeType !== RESOURCE_MIME_TYPE) {
    throw new Error(`Unsupported MIME type for ${uri}: ${content.mimeType ?? 'none'}.`);
  }
  const html = 'blob' in content ? decodeBase64Utf8(content.blob) : content.text;

  // CSP and permissions: the content item wins, the resources/list entry is the fallback.
  const contentUi = (content._meta as { ui?: unknown } | undefined)?.ui;
  const listingUi = (session.resources.get(uri)?._meta as { ui?: unknown } | undefined)?.ui;
  const ui = (contentUi ?? listingUi) as { csp?: McpUiResourceCsp; permissions?: McpUiResourcePermissions } | undefined;
  return {
    uri,
    html,
    ...(ui?.csp ? { csp: ui.csp } : {}),
    ...(ui?.permissions ? { permissions: ui.permissions } : {}),
  };
}

const resourceCache = new WeakMap<McpSession, Map<string, Promise<UiResource>>>();

/** Reads a UI resource once per connection. A failed read is forgotten so it can be retried. */
export function readUiResource(session: McpSession, uri: string): Promise<UiResource> {
  let cache = resourceCache.get(session);
  if (!cache) {
    cache = new Map();
    resourceCache.set(session, cache);
  }
  let pending = cache.get(uri);
  if (!pending) {
    pending = fetchUiResource(session, uri);
    cache.set(uri, pending);
    pending.catch(() => cache.delete(uri));
  }
  return pending;
}

/** Fetches every card the server's tools point at, so the first card appears without a wait. */
export function preloadUiResources(session: McpSession): void {
  const uris = new Set(session.tools.map(uiResourceUriOf).filter((uri): uri is string => uri !== undefined));
  for (const uri of uris) void readUiResource(session, uri).catch(() => undefined);
}

/** Points the iframe at the sandbox proxy and resolves once the proxy says it is ready. */
export function loadSandboxProxy(
  iframe: HTMLIFrameElement,
  sandbox: SandboxConfig,
  permissions?: McpUiResourcePermissions,
): Promise<void> {
  iframe.setAttribute('sandbox', sandbox.iframeSandbox);
  const allow = buildAllowAttribute(permissions);
  if (allow) iframe.setAttribute('allow', allow);

  const ready: McpUiSandboxProxyReadyNotification['method'] = 'ui/notifications/sandbox-proxy-ready';
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', listener);
      reject(new Error(`The sandbox proxy at ${sandbox.url} did not start.`));
    }, SANDBOX_READY_TIMEOUT_MS);
    const listener = (event: MessageEvent): void => {
      if (event.source !== iframe.contentWindow || event.origin !== sandbox.messageOrigin) return;
      if ((event.data as { method?: unknown } | null)?.method !== ready) return;
      window.clearTimeout(timer);
      window.removeEventListener('message', listener);
      resolve();
    };
    window.addEventListener('message', listener);
    iframe.src = sandbox.url;
  });
}

export interface CardCallbacks {
  /** The card sent a user message (`ui/message`), e.g. a clarification chip was tapped. */
  onMessage: (text: string) => void;
  /** The card asked to open a link (`ui/open-link`). Return false to refuse. */
  onOpenLink: (url: string) => boolean;
  /** The card reported its content size (`ui/notifications/size-changed`). */
  onSizeChange: (size: { width?: number; height?: number }) => void;
  /** The card asked to be closed (`ui/notifications/request-teardown`). */
  onRequestClose: () => void;
}

export interface CardContainer {
  width: number;
  maxHeight: number;
}

export function createAppBridge(
  session: McpSession,
  tool: Tool,
  container: CardContainer,
  callbacks: CardCallbacks,
): AppBridge {
  const capabilities = session.serverCapabilities;
  const hostContext: McpUiHostContext = {
    toolInfo: { tool },
    theme: 'dark',
    styles: { variables: HOST_STYLE_VARIABLES },
    displayMode: 'inline',
    availableDisplayModes: ['inline'],
    containerDimensions: { width: container.width, maxHeight: container.maxHeight },
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgent: `${CLIENT_INFO.name}/${CLIENT_INFO.version}`,
    platform: 'web',
    // An Echo Show is a touch screen.
    deviceCapabilities: { touch: true, hover: false },
  };

  const bridge = new AppBridge(
    null,
    CLIENT_INFO,
    {
      openLinks: {},
      logging: {},
      message: { text: {} },
      ...(capabilities?.tools ? { serverTools: {} } : {}),
      ...(capabilities?.resources ? { serverResources: {} } : {}),
    },
    { hostContext },
  );

  // Handlers are registered before connect(): a view may send requests right after its handshake.

  bridge.oncalltool = async (params, extra): Promise<CallToolResult> => {
    const target = session.findTool(params.name);
    if (!target || !isAppCallable(target)) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool "${params.name}" is not available to views.`);
    }
    return session.callTool(params.name, params.arguments ?? {}, { origin: 'app', signal: extra.mcpReq.signal });
  };

  if (capabilities?.resources) {
    bridge.onreadresource = (params, extra) =>
      session.readResource(params.uri, { origin: 'app', signal: extra.mcpReq.signal });
    bridge.onlistresources = (params, extra) =>
      session.client.listResources(params, { signal: extra.mcpReq.signal, cacheMode: 'bypass' });
    bridge.onlistresourcetemplates = (params, extra) =>
      session.client.listResourceTemplates(params, { signal: extra.mcpReq.signal, cacheMode: 'bypass' });
  }

  bridge.onmessage = async ({ content }) => {
    const text = content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join(' ')
      .trim();
    if (!text) return { isError: true };
    callbacks.onMessage(text);
    // Nothing about the conversation is returned to the view.
    return {};
  };

  bridge.onopenlink = async ({ url }) => (callbacks.onOpenLink(url) ? {} : { isError: true });

  bridge.onrequestdisplaymode = async () => ({ mode: 'inline' });

  bridge.onloggingmessage = (params) => {
    console.debug('[card]', params.level, params.data);
  };

  bridge.addEventListener('sizechange', (size) => callbacks.onSizeChange(size));
  bridge.addEventListener('requestteardown', () => callbacks.onRequestClose());

  return bridge;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export interface CardStart {
  input: Record<string, unknown>;
  result: Promise<CallToolResult>;
  resource: UiResource;
}

/**
 * Runs the view lifecycle on a loaded sandbox proxy: connect the bridge, hand over the HTML, wait
 * for the view to initialize, then send the tool input and, when it arrives, the tool result.
 */
export async function startCard(iframe: HTMLIFrameElement, bridge: AppBridge, card: CardStart): Promise<void> {
  const target = iframe.contentWindow;
  if (!target) throw new Error('The card frame is gone.');

  const initialized = new Promise<void>((resolve) => {
    const onInitialized = (): void => {
      bridge.removeEventListener('initialized', onInitialized);
      resolve();
    };
    bridge.addEventListener('initialized', onInitialized);
  });

  // The same window is both target and source, so the bridge only hears this one iframe.
  await bridge.connect(new PostMessageTransport(target, target));

  const { html, csp, permissions } = card.resource;
  await bridge.sendSandboxResourceReady({
    html,
    ...(csp ? { csp } : {}),
    ...(permissions ? { permissions } : {}),
  });

  await withTimeout(initialized, CARD_INIT_TIMEOUT_MS, 'The card did not finish loading.');
  await bridge.sendToolInput({ arguments: card.input });

  card.result.then(
    (result) => bridge.sendToolResult(result).catch(() => undefined),
    (error: unknown) =>
      bridge
        .sendToolCancelled({ reason: error instanceof Error ? error.message : String(error) })
        .catch(() => undefined),
  );
}

/** Asks the view to wrap up (`ui/resource-teardown`), without waiting long, then closes the bridge. */
export async function stopCard(bridge: AppBridge): Promise<void> {
  try {
    await bridge.teardownResource({}, { timeout: 400 });
  } catch {
    // The view may never have initialized, or may already be gone.
  }
  await bridge.close().catch(() => undefined);
}
