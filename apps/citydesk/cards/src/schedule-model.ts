/**
 * Turns a CollectionSchedule into what the schedule card draws. No DOM access, so the vitest suite
 * can import it under Node.
 */
import type { CollectionSchedule, CollectionStream } from '../../src/contract.ts';
import {
  dayNumberInZone,
  dayOfMonth,
  longDate,
  parseYmd,
  relativeDay,
  safeTimeZone,
  shortDate,
  weekdayName,
  weekdayPhrase,
} from './shared/format.ts';

export const STRIP_DAYS = 14;

export interface StripDay {
  /** Days since 1970-01-01 for this calendar date. */
  day: number;
  /** "Mon". */
  weekday: string;
  date: number;
  trash: boolean;
  recycling: boolean;
  today: boolean;
}

export interface StreamFact {
  /** False when the city lists no pickup for this stream. */
  listed: boolean;
  /** The headline: "Today", "Tomorrow", a weekday, or a date. */
  big: string;
  sub: string;
  /** "Every Monday and Thursday". */
  rule: string;
  today: boolean;
}

/**
 * "Today" for the schedule: the calendar day of `as_of` in the city's zone. The pickup dates were
 * computed by the server at that instant, so the card measures from the same day.
 */
export function scheduleToday(schedule: CollectionSchedule, asOf: unknown): number {
  const zone = safeTimeZone(schedule.time_zone);
  const fromAsOf = dayNumberInZone(asOf, zone);
  if (fromAsOf !== null) return fromAsOf;
  const firstUpcoming = Array.isArray(schedule.upcoming) ? parseYmd(schedule.upcoming[0]?.date) : null;
  if (firstUpcoming !== null) return firstUpcoming;
  return dayNumberInZone(new Date().toISOString(), zone) ?? 0;
}

/** Fourteen consecutive days starting today, with the pickups from `upcoming` marked on them. */
export function buildStrip(schedule: CollectionSchedule, today: number): StripDay[] {
  const pickups = new Map<number, { trash: boolean; recycling: boolean }>();
  for (const entry of Array.isArray(schedule.upcoming) ? schedule.upcoming : []) {
    const day = parseYmd(entry?.date);
    if (day === null) continue;
    const seen = pickups.get(day) ?? { trash: false, recycling: false };
    pickups.set(day, { trash: seen.trash || entry.trash === true, recycling: seen.recycling || entry.recycling === true });
  }
  return Array.from({ length: STRIP_DAYS }, (_, offset) => {
    const day = today + offset;
    const pickup = pickups.get(day);
    return {
      day,
      weekday: weekdayName(day).slice(0, 3),
      date: dayOfMonth(day),
      trash: pickup?.trash ?? false,
      recycling: pickup?.recycling ?? false,
      today: offset === 0,
    };
  });
}

export function streamFact(stream: CollectionStream | undefined, today: number, noun: string): StreamFact {
  // Tool data is unvalidated JSON, so the declared Weekday type is checked rather than trusted.
  const listed: readonly unknown[] = Array.isArray(stream?.weekdays) ? stream.weekdays : [];
  const weekdays = listed.filter((day): day is string => typeof day === 'string' && day !== '');
  const next = parseYmd(stream?.next_date);
  const rule = weekdayPhrase(weekdays);

  if (next === null) {
    if (weekdays.length === 0) {
      return { listed: false, big: 'No pickup', sub: `The city lists no ${noun} days for this address.`, rule: '', today: false };
    }
    // Weekdays without a computed date: lead with the rule itself.
    return {
      listed: true,
      big: weekdays.length === 1 ? (weekdays[0] ?? '') : `${weekdays.length} days a week`,
      sub: rule,
      rule: '',
      today: false,
    };
  }

  const delta = next - today;
  const relative = relativeDay(next, today);
  if (delta === 0 || delta === 1) {
    return { listed: true, big: relative, sub: `${weekdayName(next)}, ${longDate(next)}`, rule, today: delta === 0 };
  }
  if (delta > 1 && delta < 7) {
    return { listed: true, big: weekdayName(next), sub: `${longDate(next)}, ${relative.toLowerCase()}`, rule, today: false };
  }
  return { listed: true, big: shortDate(next), sub: `${weekdayName(next)}, ${relative.toLowerCase()}`, rule, today: false };
}
