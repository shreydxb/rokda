import { describe, it, expect } from 'vitest';
import { monthlyReview } from './monthlyReview';
import { biggestChanges, closedMonthFigures, monthEndMonth, monthEndPage, monthEndSteps, runningMonthStrip } from './monthEnd';

// 16 November 2026: November is running, October is the month just ended.
const NOW = new Date(2026, 10, 16, 12);
const NOV = { year: 2026, month: 11 };
const OCT = { year: 2026, month: 10 };
const AUG = { year: 2026, month: 8 };

const CURRENT = 'current';
const CARD = 'card';
const account = (id, extra = {}) => ({ id, name: id, type: 'checking', created_at: '2026-01-01T00:00:00Z', archived_at: null, balance_as_of: '2026-11-02T09:00:00Z', ...extra });
const card = account(CARD, { name: 'Bank card', type: 'credit_card', statement_day: 20 });
const tx = (id, extra = {}) => ({ id, account_id: CURRENT, amount: -100, kind: 'expense', category_id: 'groceries', is_split: false, needs_review: false, occurred_at: '2026-10-10', ...extra });
const categories = [
  { id: 'groceries', name: 'Groceries', kind: 'expense', parent_id: null },
  { id: 'dining', name: 'Dining out', kind: 'expense', parent_id: null },
  { id: 'travel', name: 'Travel', kind: 'expense', parent_id: null },
  { id: 'fuel', name: 'Fuel', kind: 'expense', parent_id: null },
  { id: 'gifts', name: 'Gifts', kind: 'expense', parent_id: null },
  { id: 'salary', name: 'Salary', kind: 'income', parent_id: null },
];

// October with nothing left to do but the close.
const settled = {
  transactions: [tx('a')],
  accounts: [account(CURRENT), card],
  statementReconciliations: [{ account_id: CARD, statement_date: '2026-10-20', status: 'confirmed' }],
  netWorthSnapshots: [],
};
const stepsFor = (month, data = {}) => monthEndSteps(monthlyReview(month, { ...settled, ...data }, NOW));

describe('monthEndMonth', () => {
  it('opens on the running month, as every Money tab does', () => {
    expect(monthEndMonth(null, NOW)).toEqual(NOV);
  });

  it('opens an earlier month from the address, never one still to come', () => {
    expect(monthEndMonth('2026-10', NOW)).toEqual(OCT);
    expect(monthEndMonth('2025-03', NOW)).toEqual({ year: 2025, month: 3 });
    expect(monthEndMonth('2026-12', NOW)).toEqual(NOV);
    expect(monthEndMonth('2027-01', NOW)).toEqual(NOV);
    expect(monthEndMonth('2026-13', NOW)).toEqual(NOV);
    expect(monthEndMonth('soon', NOW)).toEqual(NOV);
  });
});

describe('monthEndPage', () => {
  const closedOct = [{ snapshot_date: '2026-10-01', assets: 100, liabilities: 0 }];

  it('shows the running month as running', () => {
    expect(monthEndPage(NOV, [], NOW)).toBe('running');
    expect(monthEndPage(NOV, [{ snapshot_date: '2026-11-01' }], NOW)).toBe('running');
  });

  it('asks to close the month just ended until it is closed, then shows it on a page', () => {
    expect(monthEndPage(OCT, [], NOW)).toBe('close');
    expect(monthEndPage(OCT, closedOct, NOW)).toBe('closed');
  });

  it('shows an earlier month never closed as one that can no longer be', () => {
    expect(monthEndPage(AUG, closedOct, NOW)).toBe('earlier');
    expect(monthEndPage(AUG, [{ snapshot_date: '2026-08-01' }], NOW)).toBe('closed');
  });
});

describe('monthEndSteps', () => {
  it('has three steps for the month just ended, with only the close left once the rest is clear', () => {
    const result = stepsFor(OCT);
    expect(result.steps.map((s) => [s.n, s.title, s.done])).toEqual([
      [1, 'Tidy transactions', true],
      [2, 'Check statements and balances', true],
      [3, 'Close', false],
    ]);
    expect(result.steps.map((s) => s.status)).toEqual(['All clear', 'All clear', 'Puts October into history']);
    expect(result).toMatchObject({ done: 2, total: 3, current: 3, open: [] });
  });

  it('says what holds the records up, and lists the checks that are clear', () => {
    const transactions = [
      tx('u1', { category_id: null }),
      tx('u2', { category_id: null, occurred_at: '2026-10-12' }),
      tx('f', { needs_review: true }),
      tx('d1', { merchant: 'Cafe', occurred_at: '2026-10-05', created_at: '2026-10-05T08:00:00Z' }),
      tx('d2', { merchant: 'Cafe', occurred_at: '2026-10-06', created_at: '2026-10-06T08:00:00Z' }),
    ];
    const result = stepsFor(OCT, { transactions });
    const tidy = result.steps[0];
    expect(tidy.done).toBe(false);
    expect(tidy.status).toBe('2 uncategorised · 1 possible duplicate · 1 flagged');
    expect(tidy.checks.map((c) => c.id)).toEqual(['review', 'categorise', 'duplicates', 'transfers', 'refunds']);
    expect(tidy.clear).toEqual(['Transfers', 'Refunds']);
    expect(result).toMatchObject({ done: 1, current: 1, open: [1] });
  });

  it('counts an AED estimate as holding the records up, and a refund to link as only worth a look', () => {
    const transactions = [tx('fx', { native_amount: -30, currency: 'USD', aed_estimated: true }), tx('r', { kind: 'refund', amount: 40 })];
    const tidy = stepsFor(OCT, { transactions }).steps[0];
    expect(tidy.status).toBe('1 AED estimate');
    expect(tidy.checks.find((c) => c.id === 'refunds').status).toBe('note');
    const noteOnly = stepsFor(OCT, { transactions: [tx('r', { kind: 'refund', amount: 40 })] }).steps[0];
    expect(noteOnly).toMatchObject({ done: true, status: 'All clear' });
  });

  it('says how many statements and balances are left in step 2', () => {
    const result = stepsFor(OCT, {
      accounts: [account(CURRENT, { balance_as_of: '2026-10-02T09:00:00Z' }), card],
      statementReconciliations: [],
    });
    expect(result.steps[1]).toMatchObject({ done: false, status: '1 statement to check · 1 balance not confirmed' });
    expect(result.steps[1].checks.map((c) => c.id)).toEqual(['statements', 'balances']);
    expect(result).toMatchObject({ current: 2, open: [2] });
  });

  it('gives an earlier month never closed only the first two steps', () => {
    const transactions = [tx('a', { occurred_at: '2026-08-10' })];
    const result = stepsFor(AUG, { transactions, statementReconciliations: [{ account_id: CARD, statement_date: '2026-08-20', status: 'confirmed' }] });
    expect(result.steps.map((s) => s.n)).toEqual([1, 2]);
    expect(result).toMatchObject({ done: 2, total: 2, current: null, closable: false });
  });
});

describe('closedMonthFigures', () => {
  const income = (id, amount, occurred_at) => tx(id, { kind: 'income', amount, category_id: 'salary', occurred_at });
  const spend = (id, amount, occurred_at) => tx(id, { amount: -amount, occurred_at });
  const transactions = [income('i10', 10000, '2026-10-01'), spend('s10', 6000, '2026-10-05'), income('i9', 9000, '2026-09-01'), spend('s9', 7000, '2026-09-05')];
  const netWorthSnapshots = [
    { snapshot_date: '2026-10-01', assets: 100000, liabilities: 20000 },
    { snapshot_date: '2026-08-01', assets: 80000, liabilities: 5000 },
  ];

  it('gives the month’s figures with the change on the month before and on the previous close', () => {
    const figures = closedMonthFigures(OCT, { transactions, netWorthSnapshots }, NOW);
    expect(figures).toMatchObject({ income: 10000, spend: 6000, saved: 4000, rate: 0.4, netWorth: 80000, netWorthChange: 5000 });
    expect(figures.previous).toEqual({ label: 'Sep', income: 9000, spend: 7000 });
    expect(figures.previousClose).toBe('Aug');
  });

  it('has nothing to compare with in the first month with records, or before any earlier close', () => {
    const figures = closedMonthFigures(OCT, { transactions: transactions.slice(0, 2), netWorthSnapshots: netWorthSnapshots.slice(0, 1) }, NOW);
    expect(figures.previous).toBeNull();
    expect(figures.netWorthChange).toBeNull();
    expect(figures.previousClose).toBeNull();
  });
});

describe('biggestChanges', () => {
  const spend = (id, category_id, amount, occurred_at) => tx(id, { category_id, amount: -amount, occurred_at });
  const history = [
    spend('g8', 'groceries', 1000, '2026-08-10'),
    spend('g9', 'groceries', 1000, '2026-09-10'),
    spend('d8', 'dining', 400, '2026-08-11'),
    spend('d9', 'dining', 400, '2026-09-11'),
    spend('t8', 'travel', 2000, '2026-08-12'),
    spend('f8', 'fuel', 200, '2026-08-13'),
    spend('f9', 'fuel', 200, '2026-09-13'),
  ];
  const october = [spend('g10', 'groceries', 1500, '2026-10-10'), spend('d10', 'dining', 100, '2026-10-11'), spend('f10', 'fuel', 210, '2026-10-13'), spend('x10', 'gifts', 800, '2026-10-14')];

  it('picks the three categories furthest from their usual, a category not spent on at all among them', () => {
    const result = biggestChanges([...history, ...october], categories, OCT, NOW);
    expect(result.moved).toBe(true);
    expect(result.rows).toEqual([
      { categoryId: 'travel', name: 'Travel', spent: 0, usual: 1000 },
      { categoryId: 'groceries', name: 'Groceries', spent: 1500, usual: 1000 },
      { categoryId: 'dining', name: 'Dining out', spent: 100, usual: 400 },
    ]);
  });

  it('shows the biggest categories instead while there is no usual month yet', () => {
    const result = biggestChanges([...october, spend('u', null, 5000, '2026-10-15')], categories, OCT, NOW);
    expect(result.moved).toBe(false);
    expect(result.rows).toEqual([
      { categoryId: 'groceries', name: 'Groceries', spent: 1500, usual: null },
      { categoryId: 'gifts', name: 'Gifts', spent: 800, usual: null },
      { categoryId: 'fuel', name: 'Fuel', spent: 210, usual: null },
    ]);
  });
});

describe('runningMonthStrip', () => {
  const row = (status) => ({ status });

  it('counts this month’s uncategorised records so far, not scheduled ones or transfers', () => {
    const transactions = [
      tx('a', { category_id: null, occurred_at: '2026-11-03' }),
      tx('b', { category_id: null, occurred_at: '2026-11-25' }),
      tx('c', { category_id: null, kind: 'transfer', occurred_at: '2026-11-04' }),
      tx('d', { category_id: null, occurred_at: '2026-10-30' }),
    ];
    expect(runningMonthStrip(NOV, { transactions, accounts: [], statements: [] }, NOW).uncategorised).toBe(1);
  });

  it('counts the statements still to check, and those that don’t match', () => {
    const statements = [row('unchecked'), row('mismatch'), row('waiting'), row('confirmed'), row('reconciled')];
    expect(runningMonthStrip(NOV, { transactions: [], accounts: [], statements }, NOW)).toMatchObject({ statements: 3, mismatched: 1 });
  });

  it('counts the open balances nobody has confirmed, or not for 45 days', () => {
    const accounts = [
      account('fresh'),
      account('unset', { balance_as_of: null }),
      account('old', { balance_as_of: '2026-09-20T09:00:00Z' }),
      account('closed', { balance_as_of: null, archived_at: '2026-06-01T00:00:00Z' }),
      account('deposit', { type: 'fd', principal: 1000, interest_rate_pct: 4, balance_as_of: null }),
    ];
    expect(runningMonthStrip(NOV, { transactions: [], accounts, statements: [] }, NOW).balances).toBe(2);
  });
});
