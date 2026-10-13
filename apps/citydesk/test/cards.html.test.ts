/**
 * The generated card documents: each must be one self-contained HTML file (no external script,
 * stylesheet or font), stay under the size budget, and match the sources it was built from.
 */
import { describe, expect, it } from 'vitest';
import { cardSourceHash } from '../cards/source-hash.ts';
import { CARD_BUILD, ISSUE_CARD_HTML, SCHEDULE_CARD_HTML } from '../src/cards/index.ts';

/**
 * Size budget per card, in bytes of HTML. The cards are about 360 kB today, nearly all of it the
 * ext-apps SDK and the zod validators it needs. 450 kB leaves room for card changes and SDK patch
 * releases, and fails loudly if a dependency (for example every zod locale, +260 kB) leaks back in.
 */
const SIZE_BUDGET_BYTES = 450 * 1024;

const CARDS = [
  { name: 'issue card', html: ISSUE_CARD_HTML, bytes: CARD_BUILD.issueCardBytes },
  { name: 'schedule card', html: SCHEDULE_CARD_HTML, bytes: CARD_BUILD.scheduleCardBytes },
];

function between(html: string, open: RegExp, close: string): string {
  const start = open.exec(html);
  if (!start) return '';
  const from = start.index + start[0].length;
  const to = html.indexOf(close, from);
  return to < 0 ? '' : html.slice(from, to);
}

describe.each(CARDS)('generated $name', ({ html, bytes }) => {
  const head = html.slice(0, html.indexOf('</head>'));
  const style = between(html, /<style>/, '</style>');
  const script = between(html, /<script>/, '</script>');
  // The page's own markup: everything except the inline style and script bodies.
  const markup = html.replace(style, '').replace(script, '');

  it('is a complete HTML document with one inline style and one inline script', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect(markup).toContain('<main id="stage"');
    expect(html.match(/<style\b/g)).toHaveLength(1);
    expect(html.match(/<\/style>/g)).toHaveLength(1);
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(style.length).toBeGreaterThan(1000);
    expect(script.length).toBeGreaterThan(10_000);
  });

  it('references no external script', () => {
    expect(markup).not.toMatch(/<script[^>]*\ssrc\s*=/i);
    expect(markup).not.toMatch(/<script[^>]*\stype\s*=\s*["']?(module|importmap)/i);
    // No runtime loading of more code either.
    expect(script).not.toMatch(/\bimportScripts\s*\(/);
    expect(script).not.toMatch(/createElement\(\s*["'`]script["'`]\s*\)/);
    expect(script).not.toMatch(/\bimport\s*\(\s*["'`]https?:/);
  });

  it('references no external stylesheet', () => {
    expect(markup).not.toMatch(/<link\b/i);
    expect(style).not.toMatch(/@import/i);
    expect(script).not.toMatch(/createElement\(\s*["'`]link["'`]\s*\)/);
  });

  it('references no external font', () => {
    expect(style).not.toMatch(/@font-face/i);
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com|use\.typekit\.net|fonts\.bunny\.net/i);
    expect(script).not.toMatch(/["'`][^"'`\s]*\.(woff2?|ttf|otf|eot)["'`?#]/i);
  });

  it('loads nothing else from the network in its own markup or styles', () => {
    expect(style).not.toMatch(/url\(/i);
    expect(markup).not.toMatch(/<(img|iframe|object|embed|video|audio|source|base)\b/i);
    expect(markup).not.toMatch(/\s(src|href)\s*=/i);
    expect(head).not.toMatch(/http-equiv/i);
  });

  it('bundles the real ext-apps SDK and the contract tool name', () => {
    for (const method of ['ui/initialize', 'ui/notifications/initialized', 'ui/notifications/size-changed', 'ui/message']) {
      expect(script).toContain(method);
    }
    expect(script).toContain('tools/call');
    expect(script).toContain('citydesk-');
  });

  it(`stays under the ${SIZE_BUDGET_BYTES / 1024} kB budget`, () => {
    const actual = Buffer.byteLength(html, 'utf8');
    expect(actual).toBe(bytes);
    expect(actual).toBeLessThanOrEqual(SIZE_BUDGET_BYTES);
  });
});

describe('generated cards module', () => {
  it('was rebuilt after the last card source change', () => {
    // If this fails, run: pnpm --filter @citydesk/server build:cards   (and commit src/cards/generated.ts)
    expect(CARD_BUILD.sourceHash).toBe(cardSourceHash());
  });

  it('was built against ext-apps 2.x', () => {
    expect(CARD_BUILD.extAppsVersion).toMatch(/^2\.\d+\.\d+/);
  });

  it('gives the two cards different documents', () => {
    expect(ISSUE_CARD_HTML).not.toBe(SCHEDULE_CARD_HTML);
    expect(ISSUE_CARD_HTML).toContain('<title>CityDesk service request</title>');
    expect(SCHEDULE_CARD_HTML).toContain('<title>CityDesk collection schedule</title>');
    // The issue card asks the server for its map through the contract's static_map tool.
    expect(ISSUE_CARD_HTML).toContain('static_map');
  });
});
