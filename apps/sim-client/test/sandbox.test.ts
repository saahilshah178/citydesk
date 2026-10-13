import { describe, expect, it } from 'vitest';
import { buildCsp, sanitizeCspDomains } from '../src/apps/csp.ts';
import { resolveSandbox } from '../src/apps/sandbox-config.ts';

describe('resolveSandbox', () => {
  it('defaults to the same host with an opaque origin, which never gets allow-same-origin', () => {
    const sandbox = resolveSandbox(undefined, 'https://d111.cloudfront.net/?dev');
    expect(sandbox).toEqual({
      url: 'https://d111.cloudfront.net/sandbox.html',
      mode: 'opaque',
      iframeSandbox: 'allow-scripts allow-forms',
      messageOrigin: 'null',
    });
    expect(resolveSandbox('  ', 'http://localhost:5173/').mode).toBe('opaque');
    // An absolute URL that happens to be the host itself is still treated as same-host.
    expect(resolveSandbox('http://localhost:5173/sandbox.html', 'http://localhost:5173/').iframeSandbox).not.toContain('allow-same-origin');
  });

  it('uses allow-same-origin only for a proxy on a different origin', () => {
    expect(resolveSandbox('https://d222.cloudfront.net/sandbox.html', 'https://d111.cloudfront.net/')).toEqual({
      url: 'https://d222.cloudfront.net/sandbox.html',
      mode: 'dedicated',
      iframeSandbox: 'allow-scripts allow-same-origin allow-forms',
      messageOrigin: 'https://d222.cloudfront.net',
    });
    // localhost and 127.0.0.1 are different origins, which makes a one-server dev setup possible.
    expect(resolveSandbox('http://127.0.0.1:5173/sandbox.html', 'http://localhost:5173/').mode).toBe('dedicated');
    // So is a different port.
    expect(resolveSandbox('http://localhost:5174/sandbox.html', 'http://localhost:5173/').mode).toBe('dedicated');
  });

  it('refuses URLs that are not http(s)', () => {
    expect(() => resolveSandbox('javascript:alert(1)', 'http://localhost:5173/')).toThrow('http(s)');
    expect(() => resolveSandbox('data:text/html,hi', 'http://localhost:5173/')).toThrow('http(s)');
  });
});

describe('buildCsp', () => {
  it('allows nothing from the network by default and never grants self', () => {
    const csp = buildCsp();
    expect(csp).not.toContain("'self'");
    expect(csp.split('; ')).toEqual([
      "default-src 'none'",
      "script-src 'unsafe-inline' 'unsafe-eval' blob: data:",
      "style-src 'unsafe-inline' blob: data:",
      'img-src data: blob:',
      'font-src data: blob:',
      'media-src data: blob:',
      "connect-src 'none'",
      'worker-src blob:',
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ]);
  });

  it('adds the domains a resource declares to the matching directives', () => {
    const csp = buildCsp({
      connectDomains: ['https://api.example.com', 'wss://live.example.com'],
      resourceDomains: ['https://cdn.example.com'],
      frameDomains: ['https://www.youtube.com'],
      baseUriDomains: ['https://cdn.example.com'],
    });
    const directive = (name: string): string | undefined => csp.split('; ').find((part) => part.startsWith(`${name} `));

    expect(directive('connect-src')).toBe('connect-src https://api.example.com wss://live.example.com');
    expect(directive('img-src')).toBe('img-src data: blob: https://cdn.example.com');
    expect(directive('script-src')).toBe("script-src 'unsafe-inline' 'unsafe-eval' blob: data: https://cdn.example.com");
    expect(directive('frame-src')).toBe('frame-src https://www.youtube.com');
    expect(directive('base-uri')).toBe('base-uri https://cdn.example.com');
  });

  it('drops entries that could inject directives or keywords', () => {
    expect(
      sanitizeCspDomains([
        'https://ok.example.com',
        "https://a.example.com; script-src 'unsafe-eval'",
        "'unsafe-inline'",
        'https://a.example.com https://b.example.com',
        'https://a.example.com,https://b.example.com',
        'https://a.example.com\nscript-src *',
        42,
        '',
      ]),
    ).toEqual(['https://ok.example.com']);
    expect(sanitizeCspDomains('https://not-an-array.example.com')).toEqual([]);
    expect(buildCsp({ connectDomains: ["*; default-src *"] })).toContain("connect-src 'none'");
  });
});
