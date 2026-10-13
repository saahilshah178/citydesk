/**
 * Content Security Policy for a card (an MCP App view), built from the resource's `_meta.ui.csp`.
 *
 * Ported from `sanitizeCspDomains` and `buildCspHeader` in ext-apps `examples/basic-host/serve.ts`
 * (v2.0.3), with two changes:
 *
 * 1. basic-host sends the policy as an HTTP header on `sandbox.html`, computed by its own Express
 *    server from a `?csp=` query parameter. This client is static files behind one CloudFront
 *    origin, with no server to compute headers per card, so the sandbox proxy injects the same
 *    policy as the first element of the card's `<head>` (see `injectCsp`). A policy delivered that
 *    way applies to everything parsed after it and cannot be lifted by removing the element.
 * 2. `'self'` is gone from every directive. In basic-host `'self'` is the dedicated sandbox
 *    origin, which serves nothing else. Here the sandbox can share a host with the client, so
 *    `'self'` would let a card load from, and send requests to, the client's own origin.
 *
 * This module has no imports: it is bundled into the sandbox proxy as well as the client.
 */

export interface ResourceCsp {
  connectDomains?: string[] | undefined;
  resourceDomains?: string[] | undefined;
  frameDomains?: string[] | undefined;
  baseUriDomains?: string[] | undefined;
}

/**
 * Drops entries that could break out of a directive: `;` or a newline starts a new directive,
 * quotes inject keywords such as 'unsafe-eval', a space or comma adds a second source.
 */
export function sanitizeCspDomains(domains: unknown): string[] {
  if (!Array.isArray(domains)) return [];
  return domains.filter((domain): domain is string => typeof domain === 'string' && /^[^\s;,'"<>]+$/.test(domain));
}

export function buildCsp(csp?: ResourceCsp | null): string {
  const resource = sanitizeCspDomains(csp?.resourceDomains).join(' ');
  const connect = sanitizeCspDomains(csp?.connectDomains).join(' ');
  const frame = sanitizeCspDomains(csp?.frameDomains).join(' ');
  const baseUri = sanitizeCspDomains(csp?.baseUriDomains).join(' ');
  const withDomains = (directive: string, domains: string): string => (domains ? `${directive} ${domains}` : directive);

  return [
    "default-src 'none'",
    // Cards are single-file bundles: their scripts and styles are inline. Some libraries need eval.
    withDomains("script-src 'unsafe-inline' 'unsafe-eval' blob: data:", resource),
    withDomains("style-src 'unsafe-inline' blob: data:", resource),
    // data: covers images a card receives through a tool call (CityDesk's static map).
    withDomains('img-src data: blob:', resource),
    withDomains('font-src data: blob:', resource),
    withDomains('media-src data: blob:', resource),
    connect ? `connect-src ${connect}` : "connect-src 'none'",
    withDomains('worker-src blob:', resource),
    frame ? `frame-src ${frame}` : "frame-src 'none'",
    "object-src 'none'",
    baseUri ? `base-uri ${baseUri}` : "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * Returns the card's HTML with the policy as the first element of `<head>`.
 * The HTML is parsed and re-serialized, so no markup or script from the card can sit in front of
 * the policy. `parser` is injectable for tests; the sandbox proxy uses the browser's `DOMParser`.
 */
export function injectCsp(html: string, policy: string, parser: Pick<DOMParser, 'parseFromString'>): string {
  const doc = parser.parseFromString(html, 'text/html');
  const meta = doc.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', policy);
  doc.head.prepend(meta);
  const doctype = doc.doctype ? '<!DOCTYPE html>' : '';
  return `${doctype}${doc.documentElement.outerHTML}`;
}
