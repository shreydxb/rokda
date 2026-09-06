import { describe, it, expect } from 'vitest';
import { monthActualsByCategory, monthIncome, monthNetSaved, monthSpendBreakdown } from './budget';

const NOW = new Date(2026, 8, 30, 12); // 30 September 2026

// QA-09 / SHR-250 acceptance, verbatim: "income 1,000, budgeted spending 100,
// unbudgeted spending 200, uncategorized spending 50 yields net saved 650."
const BUDGETED_CATEGORY = 'cat-groceries';
const UNBUDGETED_CATEGORY = 'cat-holiday';
const TRANSACTIONS = [
  { id: 'i', occurred_at: '2026-09-01', amount: 1000, is_shared: true, category_id: null },
  { id: 'b', occurred_at: '2026-09-02', amount: -100, is_shared: true, category_id: BUDGETED_CATEGORY },
  { id: 'u', occurred_at: '2026-09-03', amount: -200, is_shared: true, category_id: UNBUDGETED_CATEGORY },
  { id: 'n', occurred_at: '2026-09-04', amount: -50, is_shared: true, category_id: null },
];

describe('QA-09: net saved counts all spending', () => {
  it('yields 650 for the published acceptance case', () => {
    expect(monthNetSaved(TRANSACTIONS, [BUDGETED_CATEGORY], 2026, 9, null, NOW)).toBe(650);
  });

  it('splits spending into budgeted, unbudgeted and uncategorised', () => {
    const breakdown = monthSpendBreakdown(TRANSACTIONS, [BUDGETED_CATEGORY], 2026, 9, null, NOW);
    expect(breakdown).toEqual({ budgeted: 100, unbudgeted: 200, uncategorised: 50, total: 350 });
  });

  it('keeps the budgeted subtotal distinct from the total', () => {
    const breakdown = monthSpendBreakdown(TRANSACTIONS, [BUDGETED_CATEGORY], 2026, 9, null, NOW);
    const budgetedSubtotal = [...monthActualsByCategory(TRANSACTIONS, 2026, 9, null, NOW).values()].reduce((a, b) => a + b, 0);
    expect(breakdown.budgeted).toBe(100);
    expect(budgetedSubtotal).toBe(300); // both categories, but only one is budgeted
    expect(breakdown.total).toBe(350);
  });

  it('counts everything as unbudgeted when nothing is budgeted', () => {
    const breakdown = monthSpendBreakdown(TRANSACTIONS, [], 2026, 9, null, NOW);
    expect(breakdown.budgeted).toBe(0);
    expect(breakdown.total).toBe(350);
    expect(monthNetSaved(TRANSACTIONS, [], 2026, 9, null, NOW)).toBe(650);
  });

  it('halves shared rows consistently for an individual scope', () => {
    const scoped = monthSpendBreakdown(TRANSACTIONS, [BUDGETED_CATEGORY], 2026, 9, 'm1', NOW);
    expect(scoped.total).toBe(175);
    expect(monthIncome(TRANSACTIONS, 2026, 9, 'm1', NOW)).toBe(500);
    expect(monthNetSaved(TRANSACTIONS, [BUDGETED_CATEGORY], 2026, 9, 'm1', NOW)).toBe(325);
  });

  it('ignores a record dated later in the month', () => {
    const withPlanned = [...TRANSACTIONS, { id: 'p', occurred_at: '2026-09-30', amount: -9000, is_shared: true, category_id: null }];
    const early = new Date(2026, 8, 5, 12);
    expect(monthSpendBreakdown(withPlanned, [BUDGETED_CATEGORY], 2026, 9, null, early).total).toBe(350);
  });

  it('ignores another month entirely', () => {
    expect(monthSpendBreakdown(TRANSACTIONS, [BUDGETED_CATEGORY], 2026, 8, null, NOW).total).toBe(0);
  });
});
