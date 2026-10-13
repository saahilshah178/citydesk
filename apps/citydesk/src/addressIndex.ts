/**
 * A local copy of Boston's address records, so address lookups take microseconds instead of the
 * two to five seconds the open-data portal needs (and keep working when the portal is slow).
 *
 * `pnpm sync:addresses` downloads the city's CSV, collapses apartment and suite rows into one row
 * per building, and writes a gzipped index. The server loads it at startup when it is present and
 * falls back to querying the portal live when it is not.
 */
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  parseSpokenAddress,
  rankAddresses,
  type AddressDirectory,
  type AddressRecord,
  type AddressSearch,
} from './addresses.ts';

/** [address, neighborhood index, zip, lat, long, trashday, recollect, address id] */
export type IndexRow = [string, number, string, number | null, number | null, string, string, string];

export interface AddressIndexFile {
  version: 1;
  /** ISO 8601. When the index was built. */
  generated_at: string;
  /** ISO 8601. When the city last refreshed the dataset, if the portal said. */
  source_last_modified?: string;
  source_rows: number;
  neighborhoods: string[];
  rows: IndexRow[];
}

const STREET_SUFFIX =
  /^(st|ave|rd|blvd|dr|pl|plz|sq|ct|ter|ln|pkwy|hwy|cir|way|park|row|wharf|aly|path|walk|cres|grn|hl|hts|xing|ext|pk|tpke|mall|vw|rdg|gdn|gdns|cv|est|trl|sta|fwy|lndg|pier|common|circuit|green|cswy|brg|ctr|bch|is|ests|byp|fens|fenway|riverway|jamaicaway|arborway|broadway)$/i;
const UNIT_WORD = /^(apt|ste|suite|unit|ph|fl|floor|rm|room|bldg|lot|rear|bsmt|basement|frnt|front|upper|lower|uppr|lowr|side|ofc|office|#.*)$/i;

/**
 * The building part of a full address: "1 City Hall Plz 802" becomes "1 City Hall Plz",
 * "607 Boylston St Ste 700" becomes "607 Boylston St". Addresses without a recognizable street
 * word lose only trailing unit-looking tokens.
 */
export function baseAddress(full: string): string {
  const tokens = full.trim().split(/\s+/);
  // The last street word wins, so "10 Park St" and "1 Court St Pl" are handled.
  let cut = -1;
  for (let i = 1; i < tokens.length; i++) {
    if (STREET_SUFFIX.test(tokens[i]!)) cut = i;
    // Stop scanning once unit words begin: "12 Main St Apt Park" is not a real pattern.
    if (UNIT_WORD.test(tokens[i]!) && cut >= 0) break;
  }
  if (cut >= 0) return tokens.slice(0, cut + 1).join(' ');
  let end = tokens.length;
  while (end > 2 && (UNIT_WORD.test(tokens[end - 1]!) || /\d/.test(tokens[end - 1]!))) end--;
  return tokens.slice(0, end).join(' ');
}

/** Collapses address rows into one row per building, neighborhood and ZIP code. */
export function buildAddressIndex(
  records: Iterable<AddressRecord>,
  meta: { generatedAt: string; sourceLastModified?: string },
): AddressIndexFile {
  const neighborhoods: string[] = [];
  const hoodIndex = new Map<string, number>();
  const groups = new Map<string, { row: IndexRow; exact: boolean }>();
  let sourceRows = 0;
  for (const r of records) {
    sourceRows++;
    const base = baseAddress(r.full_address);
    if (base.length < 3) continue;
    const hood = r.neighborhood ?? '';
    let h = hoodIndex.get(hood);
    if (h === undefined) {
      h = neighborhoods.push(hood) - 1;
      hoodIndex.set(hood, h);
    }
    const key = `${base.toLowerCase()}|${h}|${r.zip_code ?? ''}`;
    const exact = r.full_address === base;
    const current = groups.get(key);
    // The row that is the building itself (no unit) is the best representative.
    if (current && (current.exact || !exact)) continue;
    groups.set(key, {
      exact,
      row: [base, h, r.zip_code ?? '', round6(r.lat), round6(r.long), r.trashday ?? '', r.recollect ?? '', r.address_id],
    });
  }
  const rows = [...groups.values()].map((g) => g.row).sort((a, b) => (a[0].toLowerCase() < b[0].toLowerCase() ? -1 : 1));
  return {
    version: 1,
    generated_at: meta.generatedAt,
    source_last_modified: meta.sourceLastModified,
    source_rows: sourceRows,
    neighborhoods,
    rows,
  };
}

function round6(n: number | undefined): number | null {
  return n === undefined ? null : Math.round(n * 1e6) / 1e6;
}

export class IndexedAddressDirectory implements AddressDirectory {
  readonly source: string;
  private readonly byAddress = new Map<string, IndexRow[]>();
  private readonly keys: string[];

  constructor(private readonly file: AddressIndexFile) {
    for (const row of file.rows) {
      const key = row[0].toLowerCase();
      const list = this.byAddress.get(key);
      if (list) list.push(row);
      else this.byAddress.set(key, [row]);
    }
    this.keys = [...this.byAddress.keys()].sort();
    this.source = `local index of ${file.rows.length} buildings (built ${file.generated_at.slice(0, 10)})`;
  }

  /** Loads a gzipped index file. Undefined when the file is missing or unreadable. */
  static load(path: string): IndexedAddressDirectory | undefined {
    if (!existsSync(path)) return undefined;
    try {
      const file = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as AddressIndexFile;
      return file.version === 1 && Array.isArray(file.rows) ? new IndexedAddressDirectory(file) : undefined;
    } catch {
      return undefined;
    }
  }

  get size(): number {
    return this.file.rows.length;
  }

  async search(text: string): Promise<AddressSearch> {
    const parsed = parseSpokenAddress(text);
    if (parsed.core.length < 3) return { parsed, matches: [] };
    const core = parsed.core.toLowerCase();
    let rows = this.byAddress.get(core) ?? [];
    if (rows.length === 0 && parsed.number) {
      // The resident left off "Street" or "Avenue": accept the address if exactly one street fits.
      const prefix = `${core} `;
      const streets = new Set<string>();
      const found: IndexRow[] = [];
      for (let i = lowerBound(this.keys, prefix); i < this.keys.length && this.keys[i]!.startsWith(prefix); i++) {
        const key = this.keys[i]!;
        if (key.slice(prefix.length).includes(' ')) continue;
        streets.add(key);
        found.push(...this.byAddress.get(key)!);
      }
      if (streets.size === 1) rows = found;
    }
    const records = rows.map((row) => this.toRecord(row));
    const first = records[0];
    // Rank against the matched address so the neighborhood and ZIP narrowing applies to it.
    const matches = first ? rankAddresses({ ...parsed, core: first.full_address }, records) : [];
    return { parsed: first ? { ...parsed, core: first.full_address } : parsed, matches };
  }

  async datasetLastModified(): Promise<string | undefined> {
    return this.file.source_last_modified;
  }

  private toRecord(row: IndexRow): AddressRecord {
    return {
      full_address: row[0],
      neighborhood: this.file.neighborhoods[row[1]] || undefined,
      zip_code: row[2] || undefined,
      lat: row[3] ?? undefined,
      long: row[4] ?? undefined,
      trashday: row[5] || undefined,
      recollect: row[6] || undefined,
      address_id: row[7],
    };
  }
}

function lowerBound(sorted: string[], target: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
