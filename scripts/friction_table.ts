/**
 * Rebuilds the friction-log table in docs/submission.md from FRICTION_LOG.md, so the submission
 * text cannot drift from the log. Fails if any entry is missing one of the six required fields.
 *
 *   pnpm friction:table
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const FIELDS = ['Task', 'Steps taken', 'Expected vs actual', 'Severity', 'Workaround', 'Suggestion'] as const;

const log = readFileSync(resolve(root, 'FRICTION_LOG.md'), 'utf8');
const entries = log.split(/\n(?=## \d+\. )/).slice(1);
const rows: string[] = [];
for (const entry of entries) {
  const title = /^## (\d+)\. (.+)$/m.exec(entry);
  if (!title) continue;
  const cells: string[] = [];
  for (const field of FIELDS) {
    // A field runs from its bold label to the next bullet or the end of the entry.
    const match = new RegExp(`- \\*\\*${field}:\\*\\*([\\s\\S]*?)(?=\\n- \\*\\*|$)`).exec(entry);
    const text = match?.[1]?.replace(/\s+/g, ' ').trim();
    if (!text) throw new Error(`Friction entry ${title[1]} ("${title[2]}") has no "${field}" field.`);
    cells.push(text.replace(/\|/g, '\\|'));
  }
  rows.push(`| ${title[1]} | ${title[2]!.replace(/\|/g, '\\|')} | ${cells.join(' | ')} |`);
}

const table = [
  `| # | Tool and problem | ${FIELDS.join(' | ')} |`,
  `| --- | --- | ${FIELDS.map(() => '---').join(' | ')} |`,
  ...rows,
].join('\n');

const file = resolve(root, 'docs', 'submission.md');
const doc = readFileSync(file, 'utf8');
const start = '<!-- friction:start -->';
const end = '<!-- friction:end -->';
if (!doc.includes(start) || !doc.includes(end)) throw new Error('docs/submission.md has no friction markers.');
const updated = `${doc.slice(0, doc.indexOf(start) + start.length)}\n${table}\n${doc.slice(doc.indexOf(end))}`;
writeFileSync(file, updated.replace(/(\d+) entries, each with the six fields/, `${rows.length} entries, each with the six fields`));
console.log(`docs/submission.md: friction table rebuilt with ${rows.length} entries, all six fields present in each.`);
