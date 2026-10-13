/**
 * A fingerprint of everything the card bundles are built from. build.ts stamps it into the
 * generated module and the test suite recomputes it, so a card source change that was not followed
 * by `pnpm build:cards` fails the tests instead of shipping a stale card.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CARDS_DIR = dirname(fileURLToPath(import.meta.url));

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

export function cardSourceHash(): string {
  const files = [...walk(join(CARDS_DIR, 'src')), join(CARDS_DIR, 'build.ts')]
    .map((path) => ({ path, name: relative(CARDS_DIR, path).split(sep).join('/') }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.name);
    hash.update('\0');
    hash.update(readFileSync(file.path, 'utf8').replace(/\r\n/g, '\n'));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}
