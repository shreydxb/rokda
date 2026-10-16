import { describe, it, expect } from 'vitest';
import { adjacentReviewMonths, balancesToConfirm, budgetSummary, monthStatements, monthlyReview, possibleTransfers, reviewMonth } from './monthlyReview';

// 16 October 2026: September is the month just ended.
const NOW = new Date(2026, 9, 16, 12);
const SEPT = { year: 2026, month: 9 };

const CURRENT = 'current';
const CARD = 'card';
const account = (id, extra = {}) => ({ id, name: id, type: 'checking', created_at: '2026-01-01T00:00:00Z', archived_at: null, balance_as_of: '2026-10-02T09:00:00Z', ...extra });
const card = account(CARD, { name: 'Bank card', type: 'credit_card', statement_day: 20 });
const tx = (id, extra = {}) => ({ id, account_id: CURRENT, amount: -100, kind: 'expense', category_id: 'groceries', is_split: false, needs_review: false, occurred_at: '2026-09-10', ...extra });

const byId = (review) => Object.fromEntries(review.checks.map((c) => [c.id, c]));

describe('reviewMonth', () => {
  it('opens on the month just ended', () => {
    expect(reviewMonth(null, NOW)).toEqual(SEPT);
  });

  it('opens an earlier month from the address, but never the running one', () => {
    expect(reviewMonth('2026-07', NOW)).toEqual({ year: 2026, month: 7 });
    expect(reviewMonth('2026-10', NOW)).toEqual(SEPT);
    expect(reviewMonth('2026-13', NOW)).toEqual(SEPT);
    expect(reviewMonth('soon', NOW)).toEqual(SEPT);
  });

  it('steps back freely and forward only to the month just ended', () => {
    expect(adjacentReviewMonths(SEPT, NOW)).toEqual({ prev: { year: 2026, month: 8 }, next: null });
    expect(adjacentReviewMonths({ year: 2026, month: 1 }, NOW).prev).toEqual({ year: 2025, month: 12 });
    expect(adjacentReviewMonths({ year: 2026, month: 8 }, NOW).next).toEqual(SEPT);
  });
});

describe('monthlyReview', () => {
  const settled = {
    transactions: [tx('a')],
    accounts: [account(CURRENT), card],
    statementReconciliations: [{ account_id: CARD, statement_date: '2026-09-20', status: 'confirmed' }],
    netWorthSnapshots: [],
  };

  it('counts only what holds the month up, and is complete once it is closed', () => {
    const open = monthlyReview(SEPT, settled, NOW);
    expect(open.label).toBe('September 2026');
    expect(byId(open).close.status).toBe('todo');
    expect(open).toMatchObject({ done: 4, total: 5, complete: false });

    const closed = monthlyReview(SEPT, { ...settled, netWorthSnapshots: [{ snapshot_date: '2026-09-01' }] }, NOW);
    // Balances feed the close, so a closed month no longer asks for them.
    expect(byId(closed).balances).toBeUndefined();
    expect(closed).toMatchObject({ done: 4, total: 4, complete: true, closed: true });
  });

  it('lists flagged and uncategorised records in the month only, linking to them', () => {
    const transactions = [
      tx('flagged', { needs_review: true }),
      tx('bare', { category_id: null }),
      tx('split', { category_id: null, is_split: true }),
      tx('moved', { category_id: null, kind: 'transfer' }),
      tx('august', { category_id: null, needs_review: true, occurred_at: '2026-08-31' }),
      tx('october', { category_id: null, needs_review: true, occurred_at: '2026-10-01' }),
    ];
    const checks = byId(monthlyReview(SEPT, { ...settled, transactions }, NOW));
    expect(checks.review).toMatchObject({ status: 'todo', count: 1, href: '/money?tab=activity&review=1&from=2026-09-01&to=2026-09-30' });
    expect(checks.categorise).toMatchObject({ status: 'todo', count: 1, href: '/money?tab=activity&cat=none&from=2026-09-01&to=2026-09-30' });
  });

  it('suggests transfers without letting them hold the month up', () => {
    const transactions = [tx('out', { amount: -500, category_id: null }), tx('in', { account_id: CARD, amount: 500, kind: 'income', category_id: null, occurred_at: '2026-09-11' })];
    const review = monthlyReview(SEPT, { ...settled, transactions }, NOW);
    const check = byId(review).transfers;
    expect(check.status).toBe('note');
    expect(check.pairs.map((p) => [p.out.id, p.in.id])).toEqual([['out', 'in']]);
    expect(review.total).toBe(5);
  });

  it('notes refunds not yet linked to their purchase, without holding the month up', () => {
    const transactions = [tx('p'), tx('linked', { amount: 20, kind: 'refund', occurred_at: '2026-09-12' }), tx('loose', { amount: 10, kind: 'refund', occurred_at: '2026-09-13' })];
    const transactionLinks = [{ id: 'l', kind: 'refund', from_transaction_id: 'p', to_transaction_id: 'linked' }];
    const review = monthlyReview(SEPT, { ...settled, transactions, transactionLinks }, NOW);
    expect(byId(review).refunds).toMatchObject({ status: 'note', count: 1, required: false, href: '/money?tab=activity&kind=refund&from=2026-09-01&to=2026-09-30' });
    expect(review.total).toBe(5);
  });

  it("notes an earlier month that was never closed, since it can't be closed now", () => {
    const review = monthlyReview({ year: 2026, month: 7 }, { ...settled, transactions: [] }, NOW);
    expect(byId(review).close).toMatchObject({ status: 'note', required: false, href: null });
  });
});

describe('possibleTransfers', () => {
  it('pairs each record once, and never a split purchase', () => {
    const out = tx('out', { amount: -500 });
    const in1 = tx('in1', { account_id: CARD, amount: 500, kind: 'income' });
    const in2 = tx('in2', { account_id: CARD, amount: 500, kind: 'income', occurred_at: '2026-09-12' });
    const split = tx('split', { amount: -500, is_split: true, category_id: null, occurred_at: '2026-09-12' });
    const rows = [out, in1, in2, split];
    expect(possibleTransfers(rows, rows).map((p) => `${p.out.id}>${p.in.id}`)).toEqual(['out>in1']);
  });
});

describe('monthStatements', () => {
  it('takes the statement each open card closed in the month', () => {
    const later = account('later', { type: 'credit_card', statement_day: 5, created_at: '2026-09-10T00:00:00Z' });
    const closedCard = account('closed', { type: 'credit_card', statement_day: 5, archived_at: '2026-09-01' });
    const noDay = account('noday', { type: 'credit_card' });
    const rows = monthStatements(SEPT, [card, later, closedCard, noDay], [{ account_id: CARD, statement_date: '2026-09-20', status: 'mismatch' }]);
    expect(rows.map((r) => [r.account.id, r.statementDate, r.status, r.settled])).toEqual([[CARD, '2026-09-20', 'mismatch', false]]);
  });

  it('clamps a statement day to a short month', () => {
    const late = account('late', { type: 'credit_card', statement_day: 31 });
    expect(monthStatements({ year: 2026, month: 2 }, [late])[0].statementDate).toBe('2026-02-28');
  });
});

describe('balancesToConfirm', () => {
  it('asks for balances not confirmed since the month ended', () => {
    const accounts = [
      account('fresh'),
      account('old', { balance_as_of: '2026-09-15T00:00:00Z' }),
      account('never', { balance_as_of: null }),
      account('fd', { type: 'fd', principal: 1000, interest_rate_pct: 5, balance_as_of: null }),
      account('gone', { balance_as_of: null, archived_at: '2026-09-20' }),
      account('new', { balance_as_of: null, created_at: '2026-10-05T00:00:00Z' }),
    ];
    expect(balancesToConfirm(SEPT, accounts).map((a) => a.id)).toEqual(['old', 'never']);
  });
});

describe('budgetSummary', () => {
  it('compares the month with its budget by group, leaving savings targets out', () => {
    const categories = [
      { id: 'food', name: 'Food', parent_id: null },
      { id: 'groceries', name: 'Groceries', parent_id: 'food' },
      { id: 'fun', name: 'Fun', parent_id: null },
      { id: 'saving', name: 'Saving', parent_id: null, is_savings: true },
    ];
    const budgets = [
      { category_id: 'groceries', year: 2026, month: 9, amount: 300 },
      { category_id: 'fun', year: 2026, month: 9, amount: 200 },
      { category_id: 'saving', year: 2026, month: 9, amount: 1000 },
      { category_id: 'fun', year: 2026, month: 8, amount: 999 },
    ];
    const transactions = [
      tx('g', { amount: -400, category_id: 'groceries' }),
      tx('f', { amount: -150, category_id: 'fun' }),
      tx('x', { amount: -50, category_id: null }),
    ];
    const summary = budgetSummary(SEPT, { transactions, budgets, categories }, NOW);
    expect(summary).toMatchObject({ budgeted: 500, spentInBudget: 550, outside: 50, total: 600, hasBudget: true });
    expect(summary.over).toEqual([{ categoryId: 'food', name: 'Food', budget: 300, spent: 400 }]);
  });
});
