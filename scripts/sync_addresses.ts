/**
 * Builds the local address index from Boston's "Trash Schedules by Address" CSV.
 *
 *   pnpm sync:addresses
 *
 * Downloads the CSV (about 35 MB), collapses unit rows into one row per building, and writes
 * .citydesk/addresses.json.gz, which the server loads at startup and the deploy copies into the
 * Lambda bundle. Also writes results/address_index.json with the numbers from this run.
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { buildAddressIndex, IndexedAddressDirectory } from '../apps/citydesk/src/addressIndex.ts';
import { TRASH_RESOURCE_ID, type AddressRecord } from '../apps/citydesk/src/addresses.ts';
import { USER_AGENT } from './lib/env.ts';

const CKAN = 'https://data.boston.gov/api/3/action';
const root = resolve(import.meta.dirname, '..');
const headers = { 'user-agent': USER_AGENT };

/** Minimal RFC 4180 line parser: handles quoted fields and doubled quotes. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(field);
      field = '';
    } else field += ch;
  }
  out.push(field);
  return out;
}

const started = Date.now();
const meta = (await (await fetch(`${CKAN}/resource_show?id=${TRASH_RESOURCE_ID}`, { headers })).json()) as {
  result: { url: string; last_modified?: string };
};
const sourceLastModified = meta.result.last_modified ? new Date(`${meta.result.last_modified}Z`).toISOString() : undefined;
console.error(`[sync] downloading ${meta.result.url}`);
const res = await fetch(meta.result.url, { headers });
if (!res.ok) throw new Error(`CSV download failed: HTTP ${res.status}`);
const csv = await res.text();
const downloadMs = Date.now() - started;

const lines = csv.split(/\r?\n/);
const header = parseCsvLine(lines[0] ?? '');
const col = (name: string): number => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`CSV has no "${name}" column; the dataset layout changed.`);
  return i;
};
const c = {
  id: col('sam_address_id'),
  address: col('full_address'),
  hood: col('mailing_neighborhood'),
  zip: col('zip_code'),
  x: col('x_coord'),
  y: col('y_coord'),
  recollect: col('recollect'),
  trash: col('trashday'),
};
const clean = (v: string | undefined): string | undefined => {
  const s = (v ?? '').trim();
  return s === '' || s === 'None' ? undefined : s;
};
const num = (v: string | undefined): number | undefined => {
  const n = Number(v);
  return v === undefined || v.trim() === '' || !Number.isFinite(n) ? undefined : n;
};

function* records(): Generator<AddressRecord> {
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === '') continue;
    const f = parseCsvLine(line);
    const full = clean(f[c.address]);
    const id = clean(f[c.id]);
    if (!full || !id) continue;
    yield {
      address_id: id,
      full_address: full,
      neighborhood: clean(f[c.hood]),
      zip_code: clean(f[c.zip]),
      lat: num(f[c.y]),
      long: num(f[c.x]),
      trashday: clean(f[c.trash]),
      recollect: clean(f[c.recollect]),
    };
  }
}

const index = buildAddressIndex(records(), { generatedAt: new Date().toISOString(), sourceLastModified });
const outFile = resolve(root, '.citydesk', 'addresses.json.gz');
mkdirSync(resolve(root, '.citydesk'), { recursive: true });
writeFileSync(outFile, gzipSync(JSON.stringify(index), { level: 9 }));

// Prove the file loads and time real lookups against it.
const loadStarted = performance.now();
const directory = IndexedAddressDirectory.load(outFile);
if (!directory) throw new Error('The index that was just written does not load.');
const loadMs = performance.now() - loadStarted;
const probes = ['700 Boylston Street', '1 City Hall Plaza', '10 Washington Street', '1079 Commonwealth Avenue', '88 East Brookline Street'];
const lookups = [];
for (const text of probes) {
  const t0 = performance.now();
  const { matches } = await directory.search(text);
  lookups.push({
    query: text,
    ms: Math.round((performance.now() - t0) * 1000) / 1000,
    matches: matches.map((m) => `${m.full_address}, ${m.neighborhood ?? ''} ${m.zip_code ?? ''}`.trim()),
  });
}

const summary = {
  ranAt: new Date().toISOString(),
  source: meta.result.url,
  source_last_modified: sourceLastModified,
  source_rows: index.source_rows,
  buildings_indexed: index.rows.length,
  neighborhoods: index.neighborhoods.length,
  csv_bytes: Buffer.byteLength(csv),
  index_bytes_gzipped: statSync(outFile).size,
  download_ms: downloadMs,
  index_load_ms: Math.round(loadMs),
  lookups,
};
mkdirSync(resolve(root, 'results'), { recursive: true });
writeFileSync(resolve(root, 'results', 'address_index.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(
  `Indexed ${summary.buildings_indexed} buildings from ${summary.source_rows} address rows ` +
    `(${(summary.index_bytes_gzipped / 1e6).toFixed(1)} MB gzipped, loads in ${summary.index_load_ms} ms). Saved ${outFile}`,
);
for (const l of lookups) console.log(`  ${l.ms.toFixed(3)} ms  ${l.query} -> ${l.matches.join(' | ') || '(no match)'}`);
