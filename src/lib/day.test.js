import { describe, it, expect } from 'vitest';
import { HOUSEHOLD_TIME_ZONE, householdToday, householdYearMonth } from './day';

// QA: "financial timezone handling — not revalidated end-to-end".
//
// The defect these pin down: the Edge Functions derive a calendar day from
// `new Date()` in a runtime whose local zone is UTC, while the household lives
// four hours ahead. The naive form below is exactly what telegram-webhook used
// to compute the date it hands the expense parser.
const naiveUtcToday = (now) => now.toISOString().slice(0, 10);

// 01:30 on the 16th in Dubai. 21:30 on the 15th in UTC.
const AFTER_MIDNIGHT_DUBAI = new Date('2026-09-15T21:30:00Z');
// 23:30 on the 15th in Dubai, still the 15th in UTC.
const BEFORE_MIDNIGHT_DUBAI = new Date('2026-09-15T19:30:00Z');

describe('household calendar day', () => {
  it('names the Dubai day just after midnight, where UTC still says yesterday', () => {
    expect(householdToday(AFTER_MIDNIGHT_DUBAI)).toBe('2026-09-16');
    // The bug, stated as a test: the old form dates it a day early.
    expect(naiveUtcToday(AFTER_MIDNIGHT_DUBAI)).toBe('2026-09-15');
  });

  it('agrees with UTC during the rest of the day', () => {
    expect(householdToday(BEFORE_MIDNIGHT_DUBAI)).toBe('2026-09-15');
    expect(naiveUtcToday(BEFORE_MIDNIGHT_DUBAI)).toBe('2026-09-15');
  });

  it('rolls the month over on Dubai time, not UTC time', () => {
    // 00:30 on 1 October in Dubai; 20:30 on 30 September in UTC.
    const justIntoOctober = new Date('2026-09-30T20:30:00Z');
    expect(householdToday(justIntoOctober)).toBe('2026-10-01');
    expect(householdYearMonth(justIntoOctober)).toEqual({ year: 2026, month: 10 });
    expect(naiveUtcToday(justIntoOctober)).toBe('2026-09-30');
  });

  it('rolls the year over on Dubai time', () => {
    const justInto2027 = new Date('2026-12-31T20:30:00Z');
    expect(householdToday(justInto2027)).toBe('2027-01-01');
    expect(householdYearMonth(justInto2027)).toEqual({ year: 2027, month: 1 });
  });

  it('is the same offset in January and July, because Dubai has no DST', () => {
    // The reason this app can name one zone and stop worrying: +04 year round.
    // A zone that observed DST would need the offset resolved per instant, and
    // these two would disagree.
    expect(householdToday(new Date('2026-01-15T20:30:00Z'))).toBe('2026-01-16');
    expect(householdToday(new Date('2026-07-15T20:30:00Z'))).toBe('2026-07-16');
  });

  it('does not depend on the zone the process runs in', () => {
    // The whole point: two runtimes, one answer. Passing the instant and the
    // zone explicitly is what makes the browser and a UTC Edge Function agree.
    for (const zone of ['UTC', 'America/New_York', 'Asia/Tokyo', 'Asia/Dubai']) {
      expect(householdToday(AFTER_MIDNIGHT_DUBAI, HOUSEHOLD_TIME_ZONE)).toBe('2026-09-16');
      expect(householdToday(AFTER_MIDNIGHT_DUBAI, zone)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('always produces a storable YYYY-MM-DD', () => {
    expect(householdToday(new Date('2026-03-05T08:00:00Z'))).toBe('2026-03-05');
    expect(householdToday(new Date('2026-11-09T00:00:00Z'))).toBe('2026-11-09');
  });
});
