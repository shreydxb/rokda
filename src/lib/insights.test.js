import { describe, it, expect } from 'vitest';
import { notableMoves } from './insights';

const NOW = new Date(2026, 8, 30, 12); // 30 September 2026
const catById = new Map([
  ['groceries', { name: 'Groceries' }],
  ['fuel', { name: 'Fuel' }],
  ['coffee', { name: 'Coffee' }],
]);

// Three prior months averaging 400 for groceries, then a genuinely bigger
// September.
function priorMonths(categoryId, amounts) {
  return amounts.map((amount, i) => ({
    id: `${categoryId}-prior-${i}`,
    occurred_at: `2026-0${6 + i}-10`,
    amount: -amount,
    category_id: categoryId,
    is_shared: true,
  }));
}

describe('notableMoves', () => {
  it('flags a category that moved well past its trailing average, with evidence', () => {
    const transactions = [
      ...priorMonths('groceries', [400, 400, 400]),
      { id: 'g1', occurred_at: '2026-09-05', amount: -500, merchant: 'Carrefour', category_id: 'groceries', is_shared: true },
      { id: 'g2', occurred_at: '2026-09-15', amount: -300, merchant: 'Lulu', category_id: 'groceries', is_shared: true },
    ];
    const moves = notableMoves(transactions, 2026, 9, null, catById, NOW);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ categoryId: 'groceries', categoryName: 'Groceries', actual: 800, avg: 400, delta: 400 });
    expect(moves[0].evidence[0]).toMatchObject({ merchant: 'Carrefour', amount: 500 });
  });

  it('ignores a move that is a large percentage but too small in absolute money', () => {
    const transactions = [
      ...priorMonths('coffee', [10, 10, 10]),
      { id: 'c1', occurred_at: '2026-09-05', amount: -20, merchant: 'Cafe', category_id: 'coffee', is_shared: true },
    ];
    // +100% but only AED 10 of real money -- below minAbsolute.
    expect(notableMoves(transactions, 2026, 9, null, catById, NOW)).toEqual([]);
  });

  it('ignores a move that is a lot of money but a small percentage of a big average', () => {
    const transactions = [
      ...priorMonths('fuel', [1000, 1000, 1000]),
      { id: 'f1', occurred_at: '2026-09-05', amount: -1050, merchant: 'ADNOC', category_id: 'fuel', is_shared: true },
    ];
    // +50 AED but only 5% -- below minPct.
    expect(notableMoves(transactions, 2026, 9, null, catById, NOW)).toEqual([]);
  });

  it('returns nothing when there is no trailing history to compare against', () => {
    const transactions = [{ id: 'g1', occurred_at: '2026-09-05', amount: -500, merchant: 'Carrefour', category_id: 'groceries', is_shared: true }];
    expect(notableMoves(transactions, 2026, 9, null, catById, NOW)).toEqual([]);
  });

  it('sorts the biggest move first and respects the limit', () => {
    const transactions = [
      ...priorMonths('groceries', [400, 400, 400]),
      ...priorMonths('fuel', [200, 200, 200]),
      { id: 'g1', occurred_at: '2026-09-05', amount: -900, merchant: 'Carrefour', category_id: 'groceries', is_shared: true },
      { id: 'f1', occurred_at: '2026-09-05', amount: -350, merchant: 'ADNOC', category_id: 'fuel', is_shared: true },
    ];
    const moves = notableMoves(transactions, 2026, 9, null, catById, NOW, { limit: 1 });
    expect(moves).toHaveLength(1);
    expect(moves[0].categoryId).toBe('groceries');
  });
});
