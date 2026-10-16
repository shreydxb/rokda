import { describe, it, expect } from 'vitest';
import { activitySummary, dayTotals, incomeAndSpend, matchesDateBasis, rowDateLabel, shareOf, sortRows } from './activity';

const ME = 'm1';
const PARTNER = 'm2';
const NOW = new Date(2026, 9, 15);

// The reviewer's case: a shared expense of 100 and a shared refund of 20.
const SHARED_EXPENSE = { id: 't1', amount: -100, kind: 'expense', occurred_at: '2026-10-10', is_shared: true };
const SHARED_REFUND = { id: 't2', amount: 20, kind: 'refund', occurred_at: '2026-10-10', is_shared: true };

describe('incomeAndSpend', () => {
  it('nets a refund against spend instead of counting it as income', () => {
    expect(incomeAndSpend([SHARED_EXPENSE, SHARED_REFUND], null)).toEqual({ income: 0, spend: 80 });
  });

  it('gives each person half of a shared record, so Me and Partner add up to Both', () => {
    const rows = [SHARED_EXPENSE, SHARED_REFUND, { id: 't3', amount: -30, kind: 'expense', occurred_at: '2026-10-11', is_shared: false, owner_member_id: ME }];
    const both = incomeAndSpend(rows, null);
    const me = incomeAndSpend(rows, ME);
    const partner = incomeAndSpend(rows, PARTNER);
    expect(me).toEqual({ income: 0, spend: 70 });
    expect(partner).toEqual({ income: 0, spend: 40 });
    expect(me.spend + partner.spend).toBe(both.spend);
  });
});

describe('dayTotals', () => {
  it('works a day out exactly as the summary line works out the list', () => {
    const day = dayTotals([SHARED_EXPENSE, SHARED_REFUND], ME).get('2026-10-10');
    expect(day.spend).toBe(40);
    expect(day.income).toBe(0);
    expect(day.items).toHaveLength(2);
  });

  it('leaves a refund-only day with negative net spend rather than income', () => {
    const day = dayTotals([{ ...SHARED_REFUND, occurred_at: '2026-10-12' }], null).get('2026-10-12');
    expect(day).toMatchObject({ income: 0, spend: -20 });
  });

  it('reads a stored date as the local calendar day', () => {
    expect([...dayTotals([{ ...SHARED_EXPENSE, occurred_at: '2026-10-01' }], null).keys()]).toEqual(['2026-10-01']);
  });
});

describe('matchesDateBasis', () => {
  const today = { occurred_at: '2026-10-15' };
  const tomorrow = { occurred_at: '2026-10-16' };
  it('counts today as posted and tomorrow as scheduled', () => {
    expect(matchesDateBasis(today, 'posted', NOW)).toBe(true);
    expect(matchesDateBasis(tomorrow, 'posted', NOW)).toBe(false);
    expect(matchesDateBasis(tomorrow, 'scheduled', NOW)).toBe(true);
    expect(matchesDateBasis(today, 'scheduled', NOW)).toBe(false);
    expect(matchesDateBasis(tomorrow, 'all', NOW)).toBe(true);
  });
});

describe('shareOf', () => {
  it('is the full amount for the household and half of a shared record for one person', () => {
    expect(shareOf(SHARED_EXPENSE, null)).toBe(-100);
    expect(shareOf(SHARED_EXPENSE, ME)).toBe(-50);
    expect(shareOf({ amount: -30, owner_member_id: PARTNER }, ME)).toBe(0);
  });
});

describe('activitySummary', () => {
  it('splits net spend into purchases less refunds, matching incomeAndSpend', () => {
    const rows = [
      SHARED_EXPENSE,
      SHARED_REFUND,
      { id: 'i', amount: 500, kind: 'income', occurred_at: '2026-10-01', is_shared: true },
      // A card payment: out of one account, into the card. Neither total.
      { id: 'to', amount: -300, kind: 'transfer', occurred_at: '2026-10-02', is_shared: true },
      { id: 'ti', amount: 300, kind: 'transfer', occurred_at: '2026-10-02', is_shared: true },
    ];
    const summary = activitySummary(rows, ME);
    expect(summary).toEqual({ income: 250, purchases: 50, refunds: 10, spend: 40, transfers: 2 });
    expect(summary.spend).toBe(incomeAndSpend(rows, ME).spend);
  });
});

describe('sortRows', () => {
  const rows = [
    { id: 'a', amount: -10, occurred_at: '2026-10-02' },
    { id: 'b', amount: 900, occurred_at: '2026-10-01' },
    { id: 'c', amount: -300, occurred_at: '2026-10-03' },
  ];
  it('orders newest first by default, or oldest first, or by size either way', () => {
    expect(sortRows(rows, 'newest').map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(sortRows(rows, 'oldest').map((r) => r.id)).toEqual(['b', 'a', 'c']);
    expect(sortRows(rows, 'largest').map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('rowDateLabel', () => {
  it('adds the year only when it is not this year', () => {
    expect(rowDateLabel('2026-10-02', NOW)).toBe('2 Oct');
    expect(rowDateLabel('2025-12-31', NOW)).toBe('31 Dec 2025');
  });
});
