import { describe, it, expect } from 'vitest';
import { billStatus, occurrenceAt, occurrencesInWindow, rollForward, upcomingItems } from './recurring';
import { billingCycle, daysUntilDue, nextDueDate } from './creditCard';

const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// QA-07 / SHR-248. The first three are the published reproductions.
describe('QA-07: month-end schedules', () => {
  it('clamps a 31st bill to 28 February', () => {
    expect(day(rollForward('2026-01-31', 'monthly', new Date(2026, 1, 1)))).toBe('2026-02-28');
  });

  it('returns to the 31st the following month rather than staying short', () => {
    // The anchor day is remembered, so February does not permanently shift the
    // schedule to the 28th.
    expect(day(occurrenceAt('2026-01-31', 'monthly', 2))).toBe('2026-03-31');
    expect(day(occurrenceAt('2026-01-31', 'monthly', 3))).toBe('2026-04-30');
  });

  it('clamps every short month for a 29th, 30th and 31st anchor', () => {
    expect(day(occurrenceAt('2026-01-29', 'monthly', 1))).toBe('2026-02-28');
    expect(day(occurrenceAt('2026-01-30', 'monthly', 1))).toBe('2026-02-28');
    expect(day(occurrenceAt('2026-01-31', 'monthly', 1))).toBe('2026-02-28');
    expect(day(occurrenceAt('2026-03-31', 'monthly', 1))).toBe('2026-04-30');
  });

  it('handles a leap day yearly schedule', () => {
    // 2028 is a leap year; 2027 is not.
    expect(day(occurrenceAt('2028-02-29', 'yearly', 1))).toBe('2029-02-28');
    expect(day(occurrenceAt('2028-02-29', 'yearly', 4))).toBe('2032-02-29');
  });

  it('handles quarterly and yearly schedules from a month end', () => {
    expect(day(occurrenceAt('2026-08-31', 'quarterly', 1))).toBe('2026-11-30');
    expect(day(occurrenceAt('2026-08-31', 'quarterly', 2))).toBe('2027-02-28');
    expect(day(occurrenceAt('2026-12-31', 'yearly', 1))).toBe('2027-12-31');
  });
});

describe('QA-07: every occurrence in the window', () => {
  it('includes every weekly occurrence in the next 30 days', () => {
    const rows = [{ id: 'weekly', next_due_date: '2026-09-05', cadence: 'weekly', amount: -100 }];
    expect(upcomingItems(rows, 30, new Date(2026, 8, 5))).toHaveLength(5);
  });

  it('totals the real committed amount rather than one occurrence', () => {
    const rows = [{ id: 'weekly', next_due_date: '2026-09-05', cadence: 'weekly', amount: -100 }];
    const committed = upcomingItems(rows, 30, new Date(2026, 8, 5)).reduce((s, r) => s + -Number(r.amount), 0);
    expect(committed).toBe(500);
  });

  it('gives each occurrence a distinct key', () => {
    const rows = [{ id: 'weekly', next_due_date: '2026-09-05', cadence: 'weekly', amount: -100 }];
    const keys = upcomingItems(rows, 30, new Date(2026, 8, 5)).map((r) => r.occurrenceKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('includes one monthly occurrence in a 30-day window', () => {
    expect(occurrencesInWindow('2026-09-10', 'monthly', 30, new Date(2026, 8, 5))).toHaveLength(1);
  });

  it('sorts occurrences from several schedules by date', () => {
    const rows = [
      { id: 'rent', next_due_date: '2026-09-28', cadence: 'monthly', amount: -5000 },
      { id: 'weekly', next_due_date: '2026-09-05', cadence: 'weekly', amount: -100 },
    ];
    const dates = upcomingItems(rows, 30, new Date(2026, 8, 5)).map((r) => r.dueDate.getTime());
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
  });

  it('skips an inactive schedule', () => {
    const rows = [{ id: 'x', next_due_date: '2026-09-05', cadence: 'weekly', amount: -100, active: false }];
    expect(upcomingItems(rows, 30, new Date(2026, 8, 5))).toHaveLength(0);
  });
});

describe('QA-07: credit-card statement and due dates', () => {
  it('clamps a statement day of 31 to the February close', () => {
    expect(day(billingCycle(31, new Date(2026, 1, 15)).nextClose)).toBe('2026-02-28');
  });

  it('keeps the cycle ordered around today', () => {
    const cycle = billingCycle(31, new Date(2026, 1, 15));
    expect(day(cycle.lastClose)).toBe('2026-01-31');
    expect(day(cycle.cycleStart)).toBe('2025-12-31');
    expect(cycle.cycleStart < cycle.lastClose).toBe(true);
    expect(cycle.lastClose < cycle.nextClose).toBe(true);
  });

  it('treats a card due today as due today, whatever the time of day', () => {
    // The cards panel compared midnight against the current *time*, so at any
    // point after 00:00 a card due today rolled into next month.
    const midMorning = new Date(2026, 8, 5, 10, 30);
    expect(daysUntilDue(5, midMorning)).toBe(0);
    expect(day(nextDueDate(5, midMorning))).toBe('2026-09-05');
  });

  it('rolls to next month only once the due day has passed', () => {
    expect(day(nextDueDate(4, new Date(2026, 8, 5, 10, 30)))).toBe('2026-10-04');
  });

  it('clamps a due day of 31 to the end of a short month', () => {
    expect(day(nextDueDate(31, new Date(2026, 1, 15)))).toBe('2026-02-28');
  });
});

describe('billStatus', () => {
  const bill = { next_due_date: '2026-09-15', cadence: 'monthly', amount: -500 };
  const now = new Date(2026, 8, 10);

  it('reads Posted when a matching transaction landed within the tolerance window', () => {
    const transactions = [{ occurred_at: '2026-09-14', amount: -510 }];
    expect(billStatus(bill, transactions, now)).toMatchObject({ label: 'Posted', needsAction: false, posted: true });
  });

  it('does not match a transaction outside the 5-day window even at the right amount', () => {
    const transactions = [{ occurred_at: '2026-09-02', amount: -500 }];
    expect(billStatus(bill, transactions, now).posted).toBe(false);
  });

  it('does not match a transaction inside the window but outside the 20% tolerance', () => {
    const transactions = [{ occurred_at: '2026-09-15', amount: -700 }];
    expect(billStatus(bill, transactions, now).posted).toBe(false);
  });

  it('reads Due soon inside 3 days with nothing posted', () => {
    const soon = { ...bill, next_due_date: '2026-09-12' };
    expect(billStatus(soon, [], now)).toMatchObject({ label: 'Due soon', needsAction: true });
  });

  it('reads Late once the due date has passed with nothing posted', () => {
    const late = { ...bill, next_due_date: '2026-09-05' };
    expect(billStatus(late, [], now)).toMatchObject({ label: 'Late', needsAction: true });
  });

  it('reads Upcoming when due date is more than 3 days out', () => {
    expect(billStatus(bill, [], now)).toMatchObject({ label: 'Upcoming', needsAction: false });
  });
});

describe('intervalCount: bills that repeat every N units, not just 1', () => {
  it('a genuinely bi-monthly bill (rent, paid every 2 months) lands two months apart, not one', () => {
    expect(day(occurrenceAt('2026-09-06', 'monthly', 1, 2))).toBe('2026-11-06');
    expect(day(occurrenceAt('2026-09-06', 'monthly', 2, 2))).toBe('2027-01-06');
  });

  it('defaults to every-1 (the old fixed behaviour) when intervalCount is omitted', () => {
    expect(day(occurrenceAt('2026-09-06', 'monthly', 1))).toBe('2026-10-06');
  });

  it('rollForward respects intervalCount when finding the next occurrence', () => {
    // Last paid 6 Sept, due every 2 months -- 6 Sept itself is already past,
    // so the next occurrence is 6 Nov, not 6 Oct.
    expect(day(rollForward('2026-09-06', 'monthly', new Date(2026, 8, 10), 2))).toBe('2026-11-06');
  });

  it('billStatus finds the right due cycle for an every-2-months bill', () => {
    const rent = { next_due_date: '2026-09-06', cadence: 'monthly', interval_count: 2, amount: -11700 };
    const now = new Date(2026, 10, 8); // 8 Nov -- just past the 6 Nov cycle
    expect(billStatus(rent, [], now)).toMatchObject({ label: 'Late' });
    expect(day(billStatus(rent, [], now).due)).toBe('2026-11-06');
  });

  it('occurrencesInWindow spaces bi-weekly-style occurrences 2 units apart', () => {
    const occs = occurrencesInWindow('2026-09-01', 'weekly', 30, new Date(2026, 8, 1), 2);
    expect(occs.map(day)).toEqual(['2026-09-01', '2026-09-15', '2026-09-29']);
  });
});
