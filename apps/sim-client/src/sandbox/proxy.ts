/**
 * The sandbox proxy: the document inside the outer iframe. It creates the inner iframe that runs
 * a card's HTML and relays JSON-RPC messages between the card and the host page.
 *
 *   Host page  <->  sandbox proxy (this file)  <->  card (inner iframe)
 *
 * Ported from ext-apps `examples/basic-host/src/sandbox.ts` (v2.0.3). What changed:
 *
 * - It runs in two modes (see `src/apps/sandbox-config.ts`). With an opaque origin, the inner
 *   frame cannot be scripted from here, so the card is loaded with `srcdoc`; with a dedicated
 *   origin it is written with `document.write`, as basic-host does.
 * - The card's CSP is injected into its HTML here instead of arriving as an HTTP header.
 * - The embedding check is not hard-coded to localhost: an opaque proxy accepts the host it was
 *   served from, and other embedders come from a build-time allowlist.
 * - The inner iframe is created when the HTML arrives, so its `sandbox` and `allow` attributes
 *   are in place before its first document exists.
 *
 * This file is bundled on its own and inlined into `sandbox.html` (see `vite.config.ts`): a
 * document with an opaque origin cannot load module scripts from its own host without CORS
 * headers, so the proxy must not depend on any external script. Keep its imports tiny.
 */

import { buildCsp, injectCsp, type ResourceCsp } from '../apps/csp.ts';

/** Origins allowed to embed the proxy, set at build time from `VITE_SANDBOX_ALLOWED_HOSTS`. */
declare const __SANDBOX_ALLOWED_EMBEDDERS__: string[];

const RESOURCE_READY = 'ui/notifications/sandbox-resource-ready';
const PROXY_READY = 'ui/notifications/sandbox-proxy-ready';
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

interface ResourceReadyParams {
  html?: unknown;
  sandbox?: unknown;
  csp?: ResourceCsp;
  permissions?: { camera?: unknown; microphone?: unknown; geolocation?: unknown; clipboardWrite?: unknown };
}

function refuse(reason: string): never {
  document.body.textContent = `Sandbox proxy refused to start: ${reason}`;
  throw new Error(`[sandbox] ${reason}`);
}

/** Same mapping as `buildAllowAttribute` in ext-apps, repeated here to keep the bundle small. */
function allowAttribute(permissions: ResourceReadyParams['permissions']): string {
  const allow: string[] = [];
  if (permissions?.camera) allow.push('camera');
  if (permissions?.microphone) allow.push('microphone');
  if (permissions?.geolocation) allow.push('geolocation');
  if (permissions?.clipboardWrite) allow.push('clipboard-write');
  return allow.join('; ');
}

function embedderOrigin(): string | undefined {
  const ancestor = window.location.ancestorOrigins?.[0];
  if (ancestor) return ancestor;
  try {
    return document.referrer ? new URL(document.referrer).origin : undefined;
  } catch {
    return undefined;
  }
}

function start(): void {
  if (window.self === window.top) refuse('this page only works inside the CityDesk client.');

  // `window.origin` is "null" when the iframe that loaded this page has no `allow-same-origin`.
  const opaque = window.origin === 'null';
  const servedFrom = new URL(window.location.href).origin;
  const host = embedderOrigin();
  if (!host) refuse('the embedding page could not be identified.');

  const allowed =
    __SANDBOX_ALLOWED_EMBEDDERS__.length > 0 ? __SANDBOX_ALLOWED_EMBEDDERS__.includes(host) : LOCAL_ORIGIN.test(host);
  if (opaque) {
    // Same-host deployment: the client that embeds the proxy is the site that serves it.
    if (host !== servedFrom && !allowed) refuse(`${host} is not allowed to embed this sandbox.`);
  } else {
    if (host === servedFrom) {
      refuse('it shares an origin with the host page. Load it without allow-same-origin, or from another origin.');
    }
    if (!allowed) refuse(`${host} is not allowed to embed this sandbox.`);
  }

  // Self-test: reaching into the host page must fail. If it works, isolation is broken.
  let isolated = false;
  try {
    void window.parent.document;
  } catch {
    isolated = true;
  }
  if (!isolated) refuse('the host page is reachable from the sandbox.');

  let inner: HTMLIFrameElement | undefined;

  const loadCard = ({ html, sandbox, csp, permissions }: ResourceReadyParams): void => {
    if (typeof html !== 'string') return;
    inner?.remove();
    const frame = document.createElement('iframe');
    frame.style.cssText = 'width:100%;height:100%;border:none;';
    frame.setAttribute('sandbox', typeof sandbox === 'string' ? sandbox : 'allow-scripts allow-same-origin allow-forms');
    const allow = allowAttribute(permissions);
    if (allow) frame.setAttribute('allow', allow);

    const guarded = injectCsp(html, buildCsp(csp), new DOMParser());
    if (opaque) {
      // The inner document gets its own opaque origin, so it can only be loaded declaratively.
      frame.srcdoc = guarded;
      document.body.appendChild(frame);
    } else {
      // basic-host writes the document instead of using srcdoc, which some views do not run under.
      document.body.appendChild(frame);
      const doc = frame.contentDocument;
      if (doc) {
        doc.open();
        doc.write(guarded);
        doc.close();
      } else {
        frame.srcdoc = guarded;
      }
    }
    inner = frame;
  };

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source === window.parent) {
      if (event.origin !== host) return;
      const data = event.data as { method?: unknown; params?: ResourceReadyParams } | null;
      if (data?.method === RESOURCE_READY) {
        loadCard(data.params ?? {});
      } else {
        // The card's origin is opaque or our own; the frame reference is what scopes delivery.
        inner?.contentWindow?.postMessage(event.data, '*');
      }
    } else if (inner && event.source === inner.contentWindow) {
      if (event.origin !== (opaque ? 'null' : servedFrom)) return;
      window.parent.postMessage(event.data, host);
    }
  });

  window.parent.postMessage({ jsonrpc: '2.0', method: PROXY_READY, params: {} }, host);
}

start();
