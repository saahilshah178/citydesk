/**
 * Boston's address directory, read from the city's open-data portal (CKAN datastore, dataset
 * "Trash Schedules by Address"). One record per address: coordinates plus trash and recycling days.
 *
 * It serves two purposes: collection_schedule answers come straight from it, and it is the fallback
 * geocoder for plain street addresses when Amazon Location Service is not configured.
 */
import type { Weekday } from './contract.ts';

export const TRASH_RESOURCE_ID = 'fee8ee07-b8b5-4ee5-b540-5162590ba5c1';
export const TRASH_DATASET_NAME = 'Trash Schedules by Address (data.boston.gov)';
const CKAN_ACTION = 'https://data.boston.gov/api/3/action';

export interface AddressRecord {
  /** Boston Street Address Management (SAM) ID. */
  address_id: string;
  /** As the city writes it, e.g. "700 Boylston St". */
  full_address: string;
  neighborhood?: string;
  zip_code?: string;
  lat?: number;
  long?: number;
  /** Raw day code for trash, e.g. "MTH". */
  trashday?: string;
  /** Raw day code for recycling, e.g. "MTH" or "W1A" (day letters plus a route suffix). */
  recollect?: string;
}

export interface ParsedAddress {
  /** Street number and name in the dataset's style, e.g. "700 Boylston St". */
  core: string;
  /** Leading street number, when the text has one. */
  number?: string;
  /** Lowercased words after the street name: neighborhood, city, state. */
  qualifiers: string;
  zip?: string;
}

const SUFFIXES: Record<string, string> = {
  street: 'St', st: 'St', avenue: 'Ave', ave: 'Ave', av: 'Ave', road: 'Rd', rd: 'Rd', boulevard: 'Blvd',
  blvd: 'Blvd', drive: 'Dr', dr: 'Dr', place: 'Pl', pl: 'Pl', plaza: 'Plz', plz: 'Plz', square: 'Sq',
  sq: 'Sq', court: 'Ct', ct: 'Ct', terrace: 'Ter', ter: 'Ter', lane: 'Ln', ln: 'Ln', parkway: 'Pkwy',
  pkwy: 'Pkwy', highway: 'Hwy', hwy: 'Hwy', circle: 'Cir', cir: 'Cir', way: 'Way', park: 'Park',
  row: 'Row', wharf: 'Wharf', alley: 'Aly', aly: 'Aly', path: 'Path', walk: 'Walk', crescent: 'Cres',
};
const DIRECTIONS: Record<string, string> = { east: 'E', west: 'W', north: 'N', south: 'S', e: 'E', w: 'W', n: 'N', s: 'S' };

/** Turns "700 boylston street, Boston MA 02116" into the dataset's "700 Boylston St" plus qualifiers. */
export function parseSpokenAddress(text: string): ParsedAddress {
  const zip = /\b(0\d{4})(?:-\d{4})?\b/.exec(text)?.[1];
  const words = text
    .replace(/\b0\d{4}(?:-\d{4})?\b/g, ' ')
    .replace(/[.,;#]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const core: string[] = [];
  let suffixAt = -1;
  for (let i = 0; i < words.length; i++) {
    const raw = words[i]!;
    const lower = raw.toLowerCase();
    // A direction word is abbreviated only before the street name ("East Brookline" to "E Brookline").
    const isLeadingDirection = DIRECTIONS[lower] !== undefined && i <= 1 && i < words.length - 1 && lower.length > 1;
    if (SUFFIXES[lower] !== undefined && i > 0) {
      core.push(SUFFIXES[lower]!);
      suffixAt = i;
      break;
    }
    core.push(isLeadingDirection ? DIRECTIONS[lower]! : titleCase(raw));
  }
  const qualifiers = suffixAt >= 0 ? words.slice(suffixAt + 1).join(' ').toLowerCase() : '';
  const number = /^\d+[a-z]?(?:-\d+)?$/i.test(core[0] ?? '') ? core[0] : undefined;
  return { core: core.join(' '), number, qualifiers, zip };
}

function titleCase(word: string): string {
  if (/^\d/.test(word)) return word.toUpperCase();
  return word
    .split('-')
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1).toLowerCase() : part))
    .join('-');
}

const DAY_TOKENS: Array<[string, Weekday]> = [
  ['TH', 'Thursday'],
  ['SU', 'Sunday'],
  ['SA', 'Saturday'],
  ['M', 'Monday'],
  ['T', 'Tuesday'],
  ['W', 'Wednesday'],
  ['F', 'Friday'],
  ['S', 'Saturday'],
];
const WEEK_ORDER: Weekday[] = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * Reads Boston's day codes: "M", "TH", "MTH" (Monday and Thursday), "TF", and recycling codes with a
 * route suffix such as "W1A" or "TH5" (the letters are the days; the suffix is ignored).
 */
export function parseDayCodes(code: string | undefined | null): Weekday[] {
  if (!code) return [];
  let rest = code.trim().toUpperCase();
  if (rest === '' || rest === 'NONE') return [];
  const days = new Set<Weekday>();
  while (rest.length > 0) {
    const token = DAY_TOKENS.find(([t]) => rest.startsWith(t));
    if (!token) break;
    days.add(token[1]);
    rest = rest.slice(token[0].length);
  }
  return WEEK_ORDER.filter((d) => days.has(d));
}

export interface AddressSearch {
  parsed: ParsedAddress;
  /** Distinct addresses (units collapsed), best match first. */
  matches: AddressRecord[];
}

/** Anything that can resolve a spoken address to Boston's address records. */
export interface AddressDirectory {
  /** Where answers come from, for logs. */
  readonly source: string;
  search(text: string): Promise<AddressSearch>;
  /** When the city last refreshed the dataset, if known. */
  datasetLastModified(): Promise<string | undefined>;
}

export interface AddressDirectoryOptions {
  fetch?: typeof fetch;
  userAgent?: string;
  timeoutMs?: number;
}

/** Queries the open-data portal live. Correct but slow (seconds per lookup); see addressIndex.ts for the fast path. */
export class BostonAddressDirectory implements AddressDirectory {
  readonly source = 'data.boston.gov (live)';
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private lastModified: { value?: string; at: number } | undefined;

  constructor(opts: AddressDirectoryOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.userAgent = opts.userAgent ?? 'citydesk/0.1 (+https://github.com/saahilshah178/citydesk)';
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /** Finds the address a resident said. An exact match is tried first, then a full-text search. */
  async search(text: string): Promise<AddressSearch> {
    const parsed = parseSpokenAddress(text);
    if (parsed.core.length < 3) return { parsed, matches: [] };

    let rows = await this.query({ filters: JSON.stringify({ full_address: parsed.core }), limit: '25' });
    if (rows.length === 0) {
      rows = await this.query({ q: JSON.stringify({ full_address: parsed.core }), limit: '60' });
    }
    return { parsed, matches: rankAddresses(parsed, rows) };
  }

  /** When the city last refreshed the dataset. Cached for an hour; undefined if the portal will not say. */
  async datasetLastModified(): Promise<string | undefined> {
    if (this.lastModified && Date.now() - this.lastModified.at < 3_600_000) return this.lastModified.value;
    let value: string | undefined;
    try {
      const body = await this.get('resource_show', { id: TRASH_RESOURCE_ID });
      const raw = (body as { result?: { last_modified?: string } }).result?.last_modified;
      value = raw ? new Date(`${raw}Z`).toISOString() : undefined;
    } catch {
      value = undefined;
    }
    this.lastModified = { value, at: Date.now() };
    return value;
  }

  private async query(params: Record<string, string>): Promise<AddressRecord[]> {
    const body = await this.get('datastore_search', { resource_id: TRASH_RESOURCE_ID, ...params });
    const records = (body as { result?: { records?: Array<Record<string, unknown>> } }).result?.records ?? [];
    return records.map(toRecord).filter((r): r is AddressRecord => r !== undefined);
  }

  private async get(action: string, params: Record<string, string>): Promise<unknown> {
    const url = `${CKAN_ACTION}/${action}?${new URLSearchParams(params).toString()}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': this.userAgent },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      const why = cause instanceof Error && cause.name === 'TimeoutError' ? 'did not answer in time' : 'could not be reached';
      throw new AddressDirectoryError(`data.boston.gov ${why}`, true);
    }
    if (!res.ok) throw new AddressDirectoryError(`data.boston.gov answered HTTP ${res.status}`, res.status >= 500 || res.status === 429);
    const body = (await res.json()) as { success?: boolean };
    if (body.success !== true) throw new AddressDirectoryError('data.boston.gov reported a failed query', false);
    return body;
  }
}

export class AddressDirectoryError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'AddressDirectoryError';
    this.retryable = retryable;
  }
}

function toRecord(raw: Record<string, unknown>): AddressRecord | undefined {
  const full = typeof raw.full_address === 'string' ? raw.full_address.trim() : '';
  if (!full || raw.sam_address_id == null) return undefined;
  const num = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : Number(v);
    return v == null || v === '' || !Number.isFinite(n) ? undefined : n;
  };
  const str = (v: unknown): string | undefined => {
    const s = v == null ? '' : String(v).trim();
    return s === '' || s === 'None' ? undefined : s;
  };
  return {
    address_id: String(raw.sam_address_id),
    full_address: full,
    neighborhood: str(raw.mailing_neighborhood),
    zip_code: str(raw.zip_code),
    lat: num(raw.y_coord),
    long: num(raw.x_coord),
    trashday: str(raw.trashday),
    recollect: str(raw.recollect),
  };
}

/**
 * Orders candidate rows and collapses units. Full-text search returns "545 Boylston St 700" for
 * "700 Boylston St" because 700 appears as a unit, so rows whose street number differs are dropped.
 */
export function rankAddresses(parsed: ParsedAddress, rows: AddressRecord[]): AddressRecord[] {
  const core = parsed.core.toLowerCase();
  let candidates = rows.filter((r) => {
    const full = r.full_address.toLowerCase();
    if (parsed.number && full.split(/\s+/)[0] !== parsed.number.toLowerCase()) return false;
    return full === core || full.startsWith(`${core} `);
  });

  // Narrow by anything the resident added after the street: a ZIP code or a neighborhood name.
  if (parsed.zip) {
    const byZip = candidates.filter((r) => r.zip_code === parsed.zip);
    if (byZip.length > 0) candidates = byZip;
  }
  if (parsed.qualifiers) {
    const byHood = candidates.filter((r) => r.neighborhood && parsed.qualifiers.includes(r.neighborhood.toLowerCase()));
    if (byHood.length > 0) candidates = byHood;
  }

  // One entry per building and neighborhood; the row without a unit number wins.
  const groups = new Map<string, AddressRecord>();
  const isExact = new Set<string>();
  for (const r of candidates) {
    const key = `${r.neighborhood ?? ''}|${r.zip_code ?? ''}`;
    const current = groups.get(key);
    const exact = r.full_address.toLowerCase() === core;
    // A unit row stands in for its building: keep the street part only ("1 City Hall Plz 802" to "1 City Hall Plz").
    const building = exact ? r : { ...r, full_address: r.full_address.slice(0, parsed.core.length) };
    if (!current || (exact && current.address_id !== r.address_id && !isExact.has(key))) groups.set(key, building);
    if (exact) isExact.add(key);
  }
  return [...groups.values()].sort((a, b) => (a.neighborhood ?? '').localeCompare(b.neighborhood ?? ''));
}
