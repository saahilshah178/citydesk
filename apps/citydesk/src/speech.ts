/** Helpers for writing summaries that sound right when spoken aloud. */
import type { Weekday } from './contract.ts';

const ORDINALS = ['th', 'st', 'nd', 'rd'];
function ordinal(n: number): string {
  const v = n % 100;
  return `${n}${ORDINALS[(v - 20) % 10] ?? ORDINALS[v] ?? ORDINALS[0]}`;
}

/** Calendar date parts of an instant in a time zone. */
export function zonedDate(ms: number, timeZone: string): { year: number; month: number; day: number; weekday: Weekday; ymd: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
  }).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  return { year, month, day, weekday: get('weekday') as Weekday, ymd: `${get('year')}-${get('month')}-${get('day')}` };
}

/** Whole days between two YYYY-MM-DD dates (b minus a). */
export function daysBetween(aYmd: string, bYmd: string): number {
  return Math.round((Date.parse(`${bYmd}T00:00:00Z`) - Date.parse(`${aYmd}T00:00:00Z`)) / 86_400_000);
}

export function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS: Weekday[] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function weekdayOf(ymd: string): Weekday {
  return WEEKDAYS[new Date(`${ymd}T00:00:00Z`).getUTCDay()]!;
}

/** "October 15th" */
export function sayMonthDay(ymd: string): string {
  const [, m, d] = ymd.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${ordinal(d ?? 1)}`;
}

/** A past moment relative to now: "today", "yesterday", "on Monday", "on October 9th". */
export function sayPastDay(iso: string, timeZone: string, now: number): string {
  const then = zonedDate(Date.parse(iso), timeZone);
  const today = zonedDate(now, timeZone);
  const diff = daysBetween(then.ymd, today.ymd);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'yesterday';
  if (diff < 7) return `on ${then.weekday}`;
  return `on ${sayMonthDay(then.ymd)}`;
}

/** A coming date relative to now: "today", "tomorrow", "this Thursday, October 15th". */
export function sayComingDay(ymd: string, todayYmd: string): string {
  const diff = daysBetween(todayYmd, ymd);
  if (diff === 0) return `today, ${sayMonthDay(ymd)}`;
  if (diff === 1) return `tomorrow, ${sayMonthDay(ymd)}`;
  if (diff < 7) return `this ${weekdayOf(ymd)}, ${sayMonthDay(ymd)}`;
  return `${weekdayOf(ymd)}, ${sayMonthDay(ymd)}`;
}

/** Street part of an address: "700 Boylston St, Boston, MA 02116" becomes "700 Boylston St". */
export function sayAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const head = address.split(',')[0]!.trim();
  return head === '' ? undefined : head;
}

/** Distances are spoken in feet for a US audience; the structured data keeps meters. */
export function sayDistance(meters: number): string {
  const feet = meters * 3.28084;
  if (feet < 15) return 'at the same spot';
  if (feet < 100) return `about ${Math.round(feet / 10) * 10} feet away`;
  return `about ${Math.round(feet / 50) * 50} feet away`;
}

export function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
