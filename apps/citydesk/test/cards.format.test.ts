/**
 * The DOM-free logic the cards rely on: request ID short forms, calendar-day arithmetic that must
 * not drift across time zones, and the schedule card's facts and 14-day strip.
 */
import { describe, expect, it } from 'vitest';
import { buildStrip, scheduleToday, streamFact, STRIP_DAYS } from '../cards/src/schedule-model.ts';
import {
  dayNumberInZone,
  formatCoordinates,
  formatDateTime,
  formatDistance,
  longDate,
  parseYmd,
  relativeDay,
  safeTimeZone,
  shortId,
  weekdayName,
  weekdayPhrase,
} from '../cards/src/shared/format.ts';
import type { CollectionSchedule } from '../src/contract.ts';

function day(ymd: string): number {
  const parsed = parseYmd(ymd);
  if (parsed === null) throw new Error(`bad test date ${ymd}`);
  return parsed;
}

describe('shortId', () => {
  it('leads with the first 8 characters of a Boston UUID and keeps the full ID', () => {
    expect(shortId('3f7faa33-fcd0-4907-a1f4-26f26614cec2')).toEqual({
      short: '3f7faa33',
      full: '3f7faa33-fcd0-4907-a1f4-26f26614cec2',
    });
  });

  it('shows short and legacy numeric IDs whole', () => {
    expect(shortId('101006763545')).toEqual({ short: '101006763545', full: null });
    expect(shortId(' 4821 ')).toEqual({ short: '4821', full: null });
  });
});

describe('formatting', () => {
  it('formats distances in metric, as the contract carries them', () => {
    expect(formatDistance(12)).toBe('12 m');
    expect(formatDistance(0.2)).toBe('1 m');
    expect(formatDistance(999.4)).toBe('999 m');
    expect(formatDistance(1250)).toBe('1.3 km');
    expect(formatDistance(12_400)).toBe('12 km');
    expect(formatDistance(undefined)).toBeNull();
    expect(formatDistance(-5)).toBeNull();
  });

  it('formats coordinates and rejects impossible ones', () => {
    expect(formatCoordinates(42.352443, -71.124948)).toBe('42.35244, -71.12495');
    expect(formatCoordinates(142, -71)).toBeNull();
    expect(formatCoordinates(undefined, -71)).toBeNull();
  });

  it('formats instants in the given zone and adds the year only when it differs', () => {
    expect(formatDateTime('2026-10-12T13:14:00Z', 'America/New_York', '2026-10-13T12:00:00Z')).toBe('Oct 12, 9:14 AM');
    expect(formatDateTime('2025-12-31T23:30:00Z', 'America/New_York', '2026-10-13T12:00:00Z')).toBe('Dec 31, 2025, 6:30 PM');
    expect(formatDateTime('not a date', 'America/New_York')).toBeNull();
    expect(formatDateTime(undefined)).toBeNull();
  });

  it('ignores a time zone the runtime does not know', () => {
    expect(safeTimeZone('America/New_York')).toBe('America/New_York');
    expect(safeTimeZone('Mars/Olympus_Mons')).toBeUndefined();
    expect(safeTimeZone(undefined)).toBeUndefined();
  });

  it('writes weekday rules', () => {
    expect(weekdayPhrase([])).toBe('');
    expect(weekdayPhrase(['Monday'])).toBe('Every Monday');
    expect(weekdayPhrase(['Monday', 'Thursday'])).toBe('Every Monday and Thursday');
    expect(weekdayPhrase(['Monday', 'Wednesday', 'Friday'])).toBe('Every Monday, Wednesday and Friday');
  });
});

describe('calendar days', () => {
  it('parses YYYY-MM-DD without shifting it', () => {
    expect(weekdayName(day('2026-10-15'))).toBe('Thursday');
    expect(longDate(day('2026-10-15'))).toBe('October 15');
    expect(day('2026-11-01') - day('2026-10-31')).toBe(1);
    expect(parseYmd('2026-02-30')).toBeNull();
    expect(parseYmd('10/15/2026')).toBeNull();
    expect(parseYmd(undefined)).toBeNull();
  });

  it('finds the calendar day of an instant in the city zone', () => {
    // 03:30 UTC on Oct 13 is still 11:30 PM on Oct 12 in Boston.
    expect(dayNumberInZone('2026-10-13T03:30:00Z', 'America/New_York')).toBe(day('2026-10-12'));
    expect(dayNumberInZone('2026-10-13T04:30:00Z', 'America/New_York')).toBe(day('2026-10-13'));
  });

  it('names days relative to today', () => {
    const today = day('2026-10-13');
    expect(relativeDay(today, today)).toBe('Today');
    expect(relativeDay(today + 1, today)).toBe('Tomorrow');
    expect(relativeDay(today + 2, today)).toBe('In 2 days');
    expect(relativeDay(today - 1, today)).toBe('Yesterday');
    expect(relativeDay(today - 3, today)).toBe('3 days ago');
  });
});

describe('schedule model', () => {
  const schedule: CollectionSchedule = {
    address: '700 Boylston St',
    neighborhood: 'Boston',
    zip_code: '02116',
    address_id: '156199',
    trash: { weekdays: ['Monday', 'Thursday'], next_date: '2026-10-15' },
    recycling: { weekdays: [], next_date: undefined },
    upcoming: [
      { date: '2026-10-15', weekday: 'Thursday', trash: true, recycling: false },
      { date: '2026-10-19', weekday: 'Monday', trash: true, recycling: true },
      { date: '2026-10-22', weekday: 'Thursday', trash: true, recycling: false },
      { date: '2026-10-26', weekday: 'Monday', trash: true, recycling: false },
      // Outside the 14-day window that starts on Oct 13: must not be drawn.
      { date: '2026-10-29', weekday: 'Thursday', trash: true, recycling: false },
    ],
    time_zone: 'America/New_York',
    dataset: { name: 'Trash Schedules by Address', resource_id: 'fee8ee07-b8b5-4ee5-b540-5162590ba5c1' },
  };
  const asOf = '2026-10-13T14:00:00Z';
  const today = scheduleToday(schedule, asOf);

  it('measures from the as_of day in the city zone', () => {
    expect(today).toBe(day('2026-10-13'));
    expect(scheduleToday(schedule, '2026-10-13T03:30:00Z')).toBe(day('2026-10-12'));
    // Without a usable as_of the first upcoming pickup anchors the strip.
    expect(scheduleToday(schedule, undefined)).toBe(day('2026-10-15'));
  });

  it('builds 14 consecutive days starting today with pickups marked', () => {
    const strip = buildStrip(schedule, today);
    expect(strip).toHaveLength(STRIP_DAYS);
    expect(strip[0]).toMatchObject({ weekday: 'Tue', date: 13, today: true, trash: false, recycling: false });
    expect(strip[13]).toMatchObject({ weekday: 'Mon', date: 26, today: false, trash: true });
    expect(strip.filter((entry) => entry.trash).map((entry) => entry.date)).toEqual([15, 19, 22, 26]);
    expect(strip.filter((entry) => entry.recycling).map((entry) => entry.date)).toEqual([19]);
    expect(strip.filter((entry) => entry.today)).toHaveLength(1);
  });

  it('leads with the weekday for a pickup later this week', () => {
    expect(streamFact(schedule.trash, today, 'trash')).toEqual({
      listed: true,
      big: 'Thursday',
      sub: 'October 15, in 2 days',
      rule: 'Every Monday and Thursday',
      today: false,
    });
  });

  it('says Today and Tomorrow', () => {
    expect(streamFact({ weekdays: ['Tuesday'], next_date: '2026-10-13' }, today, 'trash')).toMatchObject({
      big: 'Today',
      sub: 'Tuesday, October 13',
      today: true,
    });
    expect(streamFact({ weekdays: ['Wednesday'], next_date: '2026-10-14' }, today, 'trash')).toMatchObject({
      big: 'Tomorrow',
      sub: 'Wednesday, October 14',
      today: false,
    });
  });

  it('uses the date once a pickup is a week or more away', () => {
    expect(streamFact({ weekdays: ['Tuesday'], next_date: '2026-10-20' }, today, 'recycling')).toMatchObject({
      big: 'Oct 20',
      sub: 'Tuesday, in 7 days',
    });
  });

  it('handles a stream with no weekdays', () => {
    expect(streamFact(schedule.recycling, today, 'recycling')).toEqual({
      listed: false,
      big: 'No pickup',
      sub: 'The city lists no recycling days for this address.',
      rule: '',
      today: false,
    });
    expect(streamFact(undefined, today, 'trash').listed).toBe(false);
  });

  it('falls back to the rule when weekdays come without a next date', () => {
    expect(streamFact({ weekdays: ['Friday'] }, today, 'recycling')).toMatchObject({ listed: true, big: 'Friday', sub: 'Every Friday' });
    expect(streamFact({ weekdays: ['Monday', 'Thursday'] }, today, 'trash')).toMatchObject({
      big: '2 days a week',
      sub: 'Every Monday and Thursday',
    });
  });
});
