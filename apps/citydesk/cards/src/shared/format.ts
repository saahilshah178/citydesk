/**
 * Formatting and calendar helpers shared by both cards. No DOM access here, so the vitest suite can
 * import this file directly under Node.
 */

/** Card copy is English, so dates are formatted in one fixed locale to match it. */
const LOCALE = 'en-US';
const DAY_MS = 86_400_000;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Returns the zone when the runtime knows it, otherwise undefined (which means "device zone"). */
export function safeTimeZone(timeZone: unknown): string | undefined {
  if (typeof timeZone !== 'string' || timeZone === '') return undefined;
  try {
    new Intl.DateTimeFormat(LOCALE, { timeZone });
    return timeZone;
  } catch {
    return undefined;
  }
}

function toDate(iso: unknown): Date | null {
  if (typeof iso !== 'string' || iso === '') return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function yearIn(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat(LOCALE, { year: 'numeric', timeZone }).format(date);
}

/** "Oct 12, 9:14 AM". The year is added only when it differs from the reference instant's year. */
export function formatDateTime(iso: unknown, timeZone?: string, referenceIso?: unknown): string | null {
  const date = toDate(iso);
  if (!date) return null;
  const reference = toDate(referenceIso) ?? new Date();
  const withYear = yearIn(date, timeZone) !== yearIn(reference, timeZone);
  return new Intl.DateTimeFormat(LOCALE, {
    month: 'short',
    day: 'numeric',
    year: withYear ? 'numeric' : undefined,
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(date);
}

/** "Oct 12". */
export function formatDay(iso: unknown, timeZone?: string, referenceIso?: unknown): string | null {
  const date = toDate(iso);
  if (!date) return null;
  const reference = toDate(referenceIso) ?? new Date();
  const withYear = yearIn(date, timeZone) !== yearIn(reference, timeZone);
  return new Intl.DateTimeFormat(LOCALE, {
    month: 'short',
    day: 'numeric',
    year: withYear ? 'numeric' : undefined,
    timeZone,
  }).format(date);
}

/**
 * Request IDs. Boston's newer IDs are UUIDs, which nobody can read off a screen, so the card leads
 * with the first 8 characters and keeps the full ID in small type. Short IDs are shown whole.
 */
export function shortId(id: string): { short: string; full: string | null } {
  const trimmed = id.trim();
  if (trimmed.length <= 12) return { short: trimmed, full: null };
  return { short: trimmed.slice(0, 8), full: trimmed };
}

/** Distances stay metric because the contract's fields (distance_m, radius_m) are metric. */
export function formatDistance(meters: unknown): string | null {
  if (typeof meters !== 'number' || !Number.isFinite(meters) || meters < 0) return null;
  if (meters < 1000) return `${Math.max(1, Math.round(meters))} m`;
  const km = meters / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

export function formatCoordinates(lat: unknown, long: unknown): string | null {
  if (typeof lat !== 'number' || typeof long !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(long)) return null;
  if (Math.abs(lat) > 90 || Math.abs(long) > 180) return null;
  return `${lat.toFixed(5)}, ${long.toFixed(5)}`;
}

export function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

// ---------- calendar days ----------
// A "day number" is the count of days since 1970-01-01 for a calendar date, with no time zone
// attached. Schedule dates arrive as YYYY-MM-DD in the city's zone and must never be shifted.

export function parseYmd(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return Math.round(ms / DAY_MS);
}

function dayDate(dayNumber: number): Date {
  return new Date(dayNumber * DAY_MS);
}

/** The calendar day an instant falls on in the given zone. */
export function dayNumberInZone(iso: unknown, timeZone?: string): number | null {
  const date = toDate(iso);
  if (!date) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const ms = Date.UTC(pick('year'), pick('month') - 1, pick('day'));
  return Number.isNaN(ms) ? null : Math.round(ms / DAY_MS);
}

export function weekdayName(dayNumber: number): string {
  return WEEKDAYS[dayDate(dayNumber).getUTCDay()] ?? '';
}

export function dayOfMonth(dayNumber: number): number {
  return dayDate(dayNumber).getUTCDate();
}

/** "October 15". */
export function longDate(dayNumber: number): string {
  const date = dayDate(dayNumber);
  return `${MONTHS[date.getUTCMonth()] ?? ''} ${date.getUTCDate()}`;
}

/** "Oct 15". */
export function shortDate(dayNumber: number): string {
  const date = dayDate(dayNumber);
  return `${(MONTHS[date.getUTCMonth()] ?? '').slice(0, 3)} ${date.getUTCDate()}`;
}

/** "Today", "Tomorrow", "In 3 days", "Yesterday", "3 days ago". */
export function relativeDay(target: number, today: number): string {
  const delta = target - today;
  if (delta === 0) return 'Today';
  if (delta === 1) return 'Tomorrow';
  if (delta === -1) return 'Yesterday';
  return delta > 0 ? `In ${delta} days` : `${-delta} days ago`;
}

/** ["Monday", "Thursday"] -> "Every Monday and Thursday". */
export function weekdayPhrase(weekdays: readonly string[]): string {
  const days = weekdays.filter((day) => typeof day === 'string' && day !== '');
  if (days.length === 0) return '';
  if (days.length === 7) return 'Every day';
  if (days.length === 1) return `Every ${days[0]}`;
  return `Every ${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}`;
}
