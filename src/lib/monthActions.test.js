import { describe, expect, it } from 'vitest';
import { historyPreview } from './monthActions';

// Closing September from 20 October, on synthetic figures.
const NOW = new Date(2026, 9, 20, 12);
const SEPT = { year: 2026, month: 9 };
const CURRENT = { id: 'cur', name: 'Current account', type: 'checking', currency: 'AED', balance: 1000, balance_aed: 1000, is_shared: true, archived_at: null };
const tx = (id, amount, day, extra = {}) => ({ id, amount, occurred_at: day, is_shared: true, kind: amount < 0 ? 'expense' : 'income', ...extra });
const september = [tx('pay', 5000, '2026-09-25'), tx('g1', -700, '2026-09-10', { category_id: 'food' }), tx('rent', -3000, '2026-09-01')];

describe('historyPreview', () => {
  it('gives the month\'s totals and the net worth a close records, against the last close', () => {
    const snapshots = [
      { snapshot_date: '2026-07-01', assets: 500, liabilities: 0 },
      { snapshot_date: '2026-08-01', assets: 900, liabilities: 100 },
    ];
    expect(historyPreview(SEPT, { accounts: [CURRENT], transactions: september, netWorthSnapshots: snapshots }, NOW)).toEqual({
      income: 5000,
      spend: 3700,
      saved: 1300,
      rate: 0.26,
      closed: false,
      netWorth: 1000,
      incomplete: 0,
      previous: { date: '2026-08-01', value: 800 },
      change: 200,
    });
  });

  it('gives the net worth a closed month recorded, not today\'s', () => {
    const snapshots = [
      { snapshot_date: '2026-08-01', assets: 900, liabilities: 100 },
      { snapshot_date: '2026-09-01', assets: 1500, liabilities: 300 },
    ];
    const preview = historyPreview(SEPT, { accounts: [CURRENT], transactions: september, netWorthSnapshots: snapshots }, NOW);
    expect(preview).toMatchObject({ closed: true, netWorth: 1200, previous: { date: '2026-08-01', value: 800 }, change: 400 });
  });
});
