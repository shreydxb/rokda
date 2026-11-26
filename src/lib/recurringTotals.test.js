import { describe, it, expect } from 'vitest';
import { everyLabel, monthlyEquivalent, recurringStrip, statusWords } from './recurringTotals';

const NOW = new Date('2026-10-21T09:00:00');
const bill = (over) => ({ id: over.name, amount: -100, currency: 'AED', cadence: 'monthly', interval_count: 1, is_shared: true, active: true, autopay: false, is_fixed: true, next_due_date: '2026-10-28', ...over });

// The design note's decision 1 (revamp phase 4): a schedule counts what it
// costs a month on average, so a yearly bill is a twelfth of itself rather
// than its whole amount every month.
describe('monthlyEquivalent', () => {
  it('spreads each cadence over the months', () => {
    expect(monthlyEquivalent(bill({ name: 'm', amount: -120 }))).toBe(-120);
    expect(monthlyEquivalent(bill({ name: 'q', amount: -120, cadence: 'quarterly' }))).toBe(-40);
    expect(monthlyEquivalent(bill({ name: 'y', amount: -1200, cadence: 'yearly' }))).toBe(-100);
    expect(monthlyEquivalent(bill({ name: 'w', amount: -12, cadence: 'weekly' }))).toBeCloseTo(-52);
  });

  it('takes the interval into account', () => {
    expect(monthlyEquivalent(bill({ name: 'r', amount: -8000, interval_count: 2 }))).toBe(-4000);
  });
});

describe('everyLabel', () => {
  it('names the cadence, with its interval when there is one', () => {
    expect(everyLabel(bill({ name: 'a' }))).toBe('Month');
    expect(everyLabel(bill({ name: 'b', cadence: 'yearly' }))).toBe('Year');
    expect(everyLabel(bill({ name: 'c', interval_count: 2 }))).toBe('2 months');
  });
});

// The design note's decision 3: an autopay bill past its date with nothing
// recorded is most likely paid and just not seen yet, so it reads Not
// confirmed in amber; a manual one stays Late in red.
describe('statusWords', () => {
  it('says Paid for a bill and Received for income', () => {
    expect(statusWords(bill({ name: 'a' }), { label: 'Posted', tone: 'pos' })).toEqual({ label: 'Paid', tone: 'pos' });
    expect(statusWords(bill({ name: 'a', amount: 500 }), { label: 'Posted', tone: 'pos' })).toEqual({ label: 'Received', tone: 'pos' });
  });

  it('says Not confirmed for an autopay bill that is late, and Late otherwise', () => {
    expect(statusWords(bill({ name: 'a', autopay: true }), { label: 'Late', tone: 'neg' })).toEqual({ label: 'Not confirmed', tone: 'warn' });
    expect(statusWords(bill({ name: 'a' }), { label: 'Late', tone: 'neg' })).toEqual({ label: 'Late', tone: 'neg' });
    expect(statusWords(bill({ name: 'a', amount: 500, autopay: true }), { label: 'Late', tone: 'neg' })).toEqual({ label: 'Late', tone: 'neg' });
  });

  it('keeps the other words, quiet ones grey', () => {
    expect(statusWords(bill({ name: 'a' }), { label: 'Upcoming', tone: 'mute' })).toEqual({ label: 'Upcoming', tone: 'neutral' });
    expect(statusWords(bill({ name: 'a' }), { label: 'Due soon', tone: 'warn' })).toEqual({ label: 'Due soon', tone: 'warn' });
  });
});

describe('recurringStrip', () => {
  const rows = [
    bill({ name: 'Rent', amount: -6000 }),
    bill({ name: 'Insurance', amount: -1200, cadence: 'yearly' }),
    bill({ name: 'Power', amount: -300, is_fixed: false }),
    bill({ name: 'Paused gym', amount: -200, active: false }),
    bill({ name: 'Old phone', amount: -50, next_due_date: '2026-01-05', ends_on: '2026-03-05' }),
    bill({ name: 'Salary', amount: 20000, is_fixed: true }),
    bill({ name: 'School fees', amount: -900, next_due_date: '2026-09-05' }),
    bill({ name: 'Cloud', amount: -10, next_due_date: '2026-09-10', autopay: true }),
  ];

  it('totals fixed and variable bills a month and expected income, leaving out ended and paused ones', () => {
    const strip = recurringStrip(rows, [], null, NOW);
    expect(strip.fixed).toBe(6000 + 100 + 900 + 10);
    expect(strip.fixedCount).toBe(4);
    expect(strip.variable).toBe(300);
    expect(strip.variableCount).toBe(1);
    expect(strip.income).toBe(20000);
  });

  it('counts the bills to mark paid, and how many of them are late rather than unconfirmed', () => {
    const strip = recurringStrip(rows, [], null, NOW);
    expect(strip.toMarkPaid).toBe(2);
    expect(strip.late).toBe(1);
    expect(strip.unconfirmed).toBe(1);
  });

  // The review of the whole revamp: pay past its window read Late on its row
  // and in To do while the strip said "To mark paid 0 · All clear".
  it('counts pay that is late among those to mark paid, as its row and To do do', () => {
    const strip = recurringStrip([bill({ name: 'Salary', amount: 20000, next_due_date: '2026-10-01' })], [], null, NOW);
    expect([strip.toMarkPaid, strip.late]).toEqual([1, 1]);
    expect(strip.income).toBe(20000);
  });

  it("counts half of a shared schedule in one person's view, and none of the other's own", () => {
    const mine = bill({ name: 'Mine', amount: -100, is_shared: false, owner_member_id: 'me' });
    const theirs = bill({ name: 'Theirs', amount: -100, is_shared: false, owner_member_id: 'them' });
    const strip = recurringStrip([bill({ name: 'Shared', amount: -100 }), mine, theirs], [], 'me', NOW);
    expect(strip.fixed).toBe(150);
    expect(strip.fixedCount).toBe(2);
  });
});

// The fresh review of 4a: a schedule whose last payment is due but unpaid is
// not finished until it is marked, so it still counts to mark paid.
describe('recurringStrip: a schedule that has just ended', () => {
  it('still counts its last unpaid payment', () => {
    const strip = recurringStrip([bill({ name: 'Gym', next_due_date: '2026-09-05', ends_on: '2026-10-10' })], [], null, NOW);
    expect(strip.toMarkPaid).toBe(1);
    expect(strip.late).toBe(1);
  });
});

// A paused schedule asks nothing of anyone (the fresh review of 4a).
describe('statusWords: paused', () => {
  it('says Paused, whatever the date', () => {
    expect(statusWords(bill({ name: 'a', active: false }), { label: 'Late', tone: 'neg' })).toEqual({ label: 'Paused', tone: 'neutral' });
  });
});
