import { describe, expect, it } from 'vitest';
import { historyPreview, monthActions } from './monthActions';

// Reviewing September from 20 October, on synthetic figures.
const NOW = new Date(2026, 9, 20, 12);
const SEPT = { year: 2026, month: 9 };
const CURRENT = { id: 'cur', name: 'Current account', type: 'checking', currency: 'AED', balance: 1000, balance_aed: 1000, is_shared: true, archived_at: null };
const categories = [
  { id: 'food', name: 'Groceries', kind: 'expense' },
  { id: 'save', name: 'Savings', kind: 'expense', is_savings: true },
];
const tx = (id, amount, day, extra = {}) => ({ id, amount, occurred_at: day, is_shared: true, kind: amount < 0 ? 'expense' : 'income', ...extra });
const september = [tx('pay', 5000, '2026-09-25'), tx('g1', -700, '2026-09-10', { category_id: 'food' }), tx('rent', -3000, '2026-09-01')];

describe('monthActions', () => {
  it('asks to cover bills the money to hand won\'t, counting pay expected', () => {
    const recurring = [
      { id: 'r1', name: 'Rent', amount: -3000, cadence: 'monthly', next_due_date: '2026-10-25', is_shared: true, active: true },
      { id: 'r2', name: 'Salary', amount: 1500, cadence: 'monthly', next_due_date: '2026-10-30', is_shared: true, active: true },
    ];
    const [first] = monthActions(SEPT, { accounts: [CURRENT], recurring }, {}, NOW);
    expect(first).toMatchObject({ id: 'liquidity', title: 'Cover the bills due in the next 30 days' });
    expect(first.detail).toBe('AED 3,000 of bills fall due by 25 Oct, with AED 1,500 of pay expected, and current and savings accounts hold AED 1,000. That is AED 500 short.');
    expect(monthActions(SEPT, { accounts: [{ ...CURRENT, balance: 5000, balance_aed: 5000 }], recurring }, {}, NOW)).toEqual([]);
  });

  // Planning audit, 1.5: Goals' own rule, a goal due within 3 years paid from
  // cash, not what was logged to it in the last 90 days.
  it('asks to set aside cash for a goal due within 3 years, and only those', () => {
    const goal = (id, extra) => ({ id, name: id, is_shared: true, created_at: '2026-06-01T00:00:00Z', ...extra });
    const goals = [goal('Car', { target_amount: 12000, target_date: '2027-10-01' }), goal('Villa', { target_amount: 500000, target_date: '2035-01-01' }), goal('House', { target_amount: 900000, target_date: null })];
    const actions = monthActions(SEPT, { accounts: [CURRENT] }, { goals, goalContributions: [], goalAllocations: [] }, NOW);
    expect(actions.map((a) => a.id)).toEqual(['goal-Car']);
    expect(actions[0].title).toBe('Set aside for Car');
    expect(actions[0].detail).toBe('AED 1,000 a month in cash to reach it by Oct 2027: AED 12,000 still to set aside, with AED 0 set aside now.');
  });

  it('names the spending over budget, and saving short of its target, in that order', () => {
    const budgets = [
      { year: 2026, month: 9, category_id: 'food', amount: 500 },
      { year: 2026, month: 9, category_id: 'save', amount: 2000 },
    ];
    const actions = monthActions(SEPT, { accounts: [CURRENT], transactions: september, budgets, categories }, {}, NOW);
    expect(actions.map((a) => a.id)).toEqual(['budget', 'saving']);
    expect(actions[0].detail).toBe('Over budget: Groceries by AED 200. Raise the budget where it was too low, or plan to spend less.');
    expect(actions[1].detail).toBe('Saved AED 1,300 against a target of AED 2,000: AED 700 short.');
  });

  it('has nothing to say about a month that went to plan', () => {
    expect(monthActions(SEPT, { accounts: [CURRENT], transactions: september, categories }, {}, NOW)).toEqual([]);
  });
});

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
