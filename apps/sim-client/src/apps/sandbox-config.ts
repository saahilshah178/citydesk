/**
 * Where the sandbox proxy lives, and what that means for the iframe that loads it.
 *
 * The MCP Apps spec says a web host must put each view behind an intermediate "sandbox proxy"
 * document whose origin differs from the host's. There are two ways to get a different origin:
 *
 * - `opaque` (the default): `sandbox.html` is served from the same host as the client, and the
 *   iframe that loads it is sandboxed WITHOUT `allow-same-origin`. The browser then gives the
 *   proxy document an opaque origin: it cannot reach the client's DOM, storage or cookies even
 *   though both came from the same server. This is what makes a single CloudFront origin work.
 *   The price: views also run with an opaque origin, so they have no localStorage/IndexedDB and
 *   their own network requests carry `Origin: null`.
 *
 * - `dedicated`: `VITE_SANDBOX_URL` points at `sandbox.html` on another origin (a second
 *   CloudFront distribution, or `127.0.0.1` vs `localhost` in development). The iframe gets
 *   `allow-same-origin`, exactly as in the ext-apps basic-host and as the spec words it, and views
 *   run with that real origin.
 *
 * The mode is derived from the URL rather than configured, so the dangerous combination (proxy on
 * the client's own origin AND `allow-same-origin`) cannot be expressed.
 */

export type SandboxMode = 'opaque' | 'dedicated';

export interface SandboxConfig {
  /** Absolute URL of the sandbox proxy document. */
  url: string;
  mode: SandboxMode;
  /** Value for the `sandbox` attribute of the iframe that loads the proxy. */
  iframeSandbox: string;
  /** `event.origin` expected on messages from the proxy. */
  messageOrigin: string;
}

export const DEFAULT_SANDBOX_PATH = '/sandbox.html';

export function resolveSandbox(configuredUrl: string | undefined, hostHref: string): SandboxConfig {
  const host = new URL(hostHref);
  const url = new URL(configuredUrl?.trim() || DEFAULT_SANDBOX_PATH, host);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`The sandbox URL must be http(s): ${url.href}`);
  }
  if (url.origin === host.origin) {
    return {
      url: url.href,
      mode: 'opaque',
      iframeSandbox: 'allow-scripts allow-forms',
      messageOrigin: 'null',
    };
  }
  return {
    url: url.href,
    mode: 'dedicated',
    iframeSandbox: 'allow-scripts allow-same-origin allow-forms',
    messageOrigin: url.origin,
  };
}
