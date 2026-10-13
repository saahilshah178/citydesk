/**
 * Builds the two MCP Apps cards.
 *
 *   pnpm --filter @citydesk/server build:cards
 *
 * For each card this bundles the TypeScript entry (with the ext-apps SDK) into one IIFE, minifies
 * the CSS, and inlines both into template.html, giving a single self-contained HTML document with
 * no external script, stylesheet or font. The documents are then written as string constants to
 * src/cards/generated.ts, which is committed: the server serves the cards straight from that
 * module, so it works from a fresh clone and bundles into Lambda without reading files at runtime.
 *
 * Copies of the HTML also go to cards/dist/ (git-ignored) for inspection.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transform, type Plugin } from 'esbuild';
import { cardSourceHash } from './source-hash.ts';

const CARDS_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(CARDS_DIR, 'src');
const DIST_DIR = join(CARDS_DIR, 'dist');
const GENERATED = join(CARDS_DIR, '..', 'src', 'cards', 'generated.ts');

interface CardSpec {
  constant: string;
  bytesKey: string;
  file: string;
  title: string;
  entry: string;
  css: string[];
}

const CARDS: CardSpec[] = [
  {
    constant: 'ISSUE_CARD_HTML',
    bytesKey: 'issueCardBytes',
    file: 'issue-card.html',
    title: 'CityDesk service request',
    entry: 'issue-card.ts',
    css: ['shared/base.css', 'issue-card.css'],
  },
  {
    constant: 'SCHEDULE_CARD_HTML',
    bytesKey: 'scheduleCardBytes',
    file: 'schedule-card.html',
    title: 'CityDesk collection schedule',
    entry: 'schedule-card.ts',
    css: ['shared/base.css', 'schedule-card.css'],
  },
];

/**
 * The ext-apps SDK validates messages with zod, and zod's entry point re-exports every locale
 * (about 260 kB minified) in a way bundlers cannot tree-shake. The cards only ever need English
 * error text, so every other locale module is replaced with a stub.
 */
const zodEnglishOnly: Plugin = {
  name: 'zod-english-only',
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /[\\/]zod[\\/]v4[\\/]locales[\\/][^\\/]+\.js$/ }, (args) => {
      const name = basename(args.path);
      if (name === 'en.js' || name === 'index.js') return undefined;
      return { contents: 'export default function () { return { localeError: function () {} }; }', loader: 'js' };
    });
  },
};

function extAppsVersion(): string {
  const require = createRequire(import.meta.url);
  // The package does not export ./package.json, so walk up from its entry (dist/src/app.js).
  const entry = require.resolve('@modelcontextprotocol/ext-apps');
  const manifest = JSON.parse(readFileSync(join(dirname(entry), '..', '..', 'package.json'), 'utf8')) as {
    name?: string;
    version?: string;
  };
  if (manifest.name !== '@modelcontextprotocol/ext-apps' || !manifest.version) {
    throw new Error(`Could not read the ext-apps version next to ${entry}`);
  }
  return manifest.version;
}

async function bundleScript(entry: string): Promise<string> {
  const result = await build({
    entryPoints: [join(SRC_DIR, entry)],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    legalComments: 'none',
    charset: 'ascii',
    plugins: [zodEnglishOnly],
    logLevel: 'warning',
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error(`esbuild produced no output for ${entry}`);
  return output.text.trim();
}

async function bundleStyles(files: string[]): Promise<string> {
  const source = files.map((file) => readFileSync(join(SRC_DIR, file), 'utf8')).join('\n');
  const result = await transform(source, { loader: 'css', minify: true, legalComments: 'none', charset: 'ascii' });
  return result.code.trim();
}

function assemble(template: string, card: CardSpec, css: string, js: string): string {
  // Inline content must not be able to close its own tag.
  if (/<\/script/i.test(js)) throw new Error(`${card.entry}: bundle contains "</script", which would end the inline script`);
  if (/<\/style/i.test(css)) throw new Error(`${card.entry}: CSS contains "</style", which would end the inline style`);
  // Function replacers, so "$&" and friends inside the bundle are not treated as patterns.
  return template
    .replace('{{title}}', () => card.title)
    .replace('{{css}}', () => css)
    .replace('{{js}}', () => js);
}

async function main(): Promise<void> {
  const template = readFileSync(join(SRC_DIR, 'template.html'), 'utf8');
  mkdirSync(DIST_DIR, { recursive: true });
  mkdirSync(dirname(GENERATED), { recursive: true });

  const constants: string[] = [];
  const sizes: string[] = [];
  for (const card of CARDS) {
    const [js, css] = await Promise.all([bundleScript(card.entry), bundleStyles(card.css)]);
    const html = assemble(template, card, css, js);
    const bytes = Buffer.byteLength(html, 'utf8');
    writeFileSync(join(DIST_DIR, card.file), html);
    constants.push(`export const ${card.constant}: string = ${JSON.stringify(html)};`);
    sizes.push(`  ${card.bytesKey}: ${bytes},`);
    console.log(`${card.file}: ${(bytes / 1024).toFixed(1)} kB (script ${(js.length / 1024).toFixed(1)} kB, styles ${(css.length / 1024).toFixed(1)} kB)`);
  }

  const lines = [
    '// GENERATED FILE. Do not edit by hand.',
    '// Built from apps/citydesk/cards/src by `pnpm --filter @citydesk/server build:cards`.',
    '// Each *_HTML constant is one self-contained document: inline CSS and JS, no external requests.',
    '',
    '/** Facts about the build that produced this file. `sourceHash` is checked by the test suite. */',
    'export const CARD_BUILD = {',
    `  sourceHash: '${cardSourceHash()}',`,
    `  extAppsVersion: '${extAppsVersion()}',`,
    ...sizes,
    '} as const;',
    '',
    ...constants,
    '',
  ];
  writeFileSync(GENERATED, lines.join('\n'));
  console.log(`wrote ${GENERATED}`);
}

await main();
