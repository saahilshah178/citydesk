/**
 * Code-side guard on what the assistant says. The system prompt asks for at most two sentences
 * and no long IDs; this module enforces both on the model's text before it is shown or spoken.
 */

export const MAX_REPLY_SENTENCES = 2;
export const MAX_REPLY_CHARS = 400;

/** Tokens that end in a period without ending a sentence. Compared lowercase, without the dot. */
const ABBREVIATIONS = new Set([
  // streets and places
  'st', 'ave', 'blvd', 'rd', 'dr', 'ln', 'ct', 'pl', 'sq', 'hwy', 'pkwy', 'ter', 'mt', 'ft', 'apt', 'ste',
  // titles and common short forms
  'mr', 'mrs', 'ms', 'jr', 'sr', 'no', 'vs', 'etc', 'approx', 'dept', 'inc', 'ext', 'est',
  'e.g', 'i.e', 'a.m', 'p.m', 'u.s',
  // months and weekdays
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
]);

const TERMINATORS = new Set(['.', '!', '?', '…']);
const CLOSERS = new Set(['"', "'", ')', ']', '”', '’']);

function tokenBefore(text: string, index: number): string {
  let start = index;
  while (start > 0 && !/\s/.test(text[start - 1] ?? '')) start -= 1;
  return text.slice(start, index);
}

function isSentenceEnd(text: string, dotIndex: number, afterIndex: number): boolean {
  if (afterIndex >= text.length) return true;
  // A terminator not followed by whitespace is inside a token: "4.5", "boston.gov", "a.m.".
  if (!/\s/.test(text[afterIndex] ?? '')) return false;
  if (text[dotIndex] !== '.') return true;

  const token = tokenBefore(text, dotIndex).replace(/^[("'“‘[]+/, '').toLowerCase();
  if (ABBREVIATIONS.has(token)) return false;
  // A single letter before the dot is an initial ("J. Smith"), not a sentence.
  if (/^[a-z]$/.test(token)) return false;

  const next = text.slice(afterIndex).trimStart()[0];
  // Sentences start with a capital, a digit or a quote. A lowercase letter means we are mid-sentence.
  if (next !== undefined && /[a-z]/.test(next)) return false;
  return true;
}

/** Splits text into sentences. Whitespace between sentences is dropped. */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    if (!TERMINATORS.has(text[i] ?? '')) {
      i += 1;
      continue;
    }
    const first = i;
    let end = i + 1;
    while (end < text.length && TERMINATORS.has(text[end] ?? '')) end += 1;
    while (end < text.length && CLOSERS.has(text[end] ?? '')) end += 1;
    if (isSentenceEnd(text, first, end)) {
      const sentence = text.slice(start, end).trim();
      if (sentence) sentences.push(sentence);
      start = end;
    }
    i = end;
  }
  const rest = text.slice(start).trim();
  if (rest) sentences.push(rest);
  return sentences;
}

/**
 * Machine identifiers nobody should hear read aloud:
 * a UUID, a CityDesk request handle ("<endpoint id>/<service_request_id>"), a run of nine or more
 * digits (a city case number), or sixteen or more hex characters (a hash).
 */
const LONG_IDS = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\b[a-z][\w-]*\/[\w-]*\d{5,}[\w-]*/gi,
  /\b(?:\d{9,}|(?=[0-9a-f]*\d)[0-9a-f]{16,})\b/gi,
];
/** Words that only introduce an ID ("ID", "number", "#"), directly before it. */
const ID_LEAD_IN = /(?:\bwith\s+)?(?:\b(?:id|number|no\.?)|#)\s*(?:is\s+|of\s+|:\s*)?$/i;

/** Removes UUIDs and other long machine IDs, together with a lead-in such as "ID" or "number". */
export function stripLongIds(text: string): string {
  const spans: Array<[start: number, end: number]> = [];
  for (const pattern of LONG_IDS) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      spans.push([start, start + match[0].length]);
    }
  }
  if (spans.length === 0) return text;
  spans.sort((a, b) => a[0] - b[0]);

  let out = '';
  let cursor = 0;
  for (const [start, end] of spans) {
    if (start < cursor) continue;
    out += text.slice(cursor, start).replace(ID_LEAD_IN, '');
    cursor = end;
  }
  out += text.slice(cursor);
  return out
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/[,;:](?=[.!?])/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Flattens markdown and line breaks into one line of plain prose. */
export function toPlainSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|\*)(?=\S)([^*]+?)(?<=\S)\1/g, '$2')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function clampChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:]+$/, '');
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export interface GuardedReply {
  /** What to show and speak. */
  text: string;
  /** Number of sentences the model produced, before the guard. */
  sentenceCount: number;
  /** True when sentences or characters were cut. */
  truncated: boolean;
  /** True when a long ID was removed. */
  idsRemoved: boolean;
}

export interface GuardOptions {
  maxSentences?: number;
  maxChars?: number;
}

/** Applies every reply rule: plain prose, no long IDs, at most two sentences, bounded length. */
export function guardReply(raw: string, options: GuardOptions = {}): GuardedReply {
  const maxSentences = options.maxSentences ?? MAX_REPLY_SENTENCES;
  const maxChars = options.maxChars ?? MAX_REPLY_CHARS;

  const plain = toPlainSpeech(raw);
  const withoutIds = stripLongIds(plain);
  const sentences = splitSentences(withoutIds);
  const kept = sentences.slice(0, maxSentences).join(' ');
  const text = clampChars(kept, maxChars);

  return {
    text,
    sentenceCount: sentences.length,
    truncated: sentences.length > maxSentences || text !== kept,
    idsRemoved: withoutIds !== plain,
  };
}
