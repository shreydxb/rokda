import { describe, expect, it } from 'vitest';
import { cashReserve, savingCheck } from './monthlyCheck';

// Planning audit, 2.11: Plan's monthly check, on synthetic figures.
const NOW = new Date(2026, 9, 20, 12);
const SEPT = { year: 2026, month: 9 };
const categories = [
  { id: 'food', name: 'Groceries', kind: 'expense' },
  { id: 'save', name: 'Savings', kind: 'expense', is_savings: true },
];
const tx = (id, amount, day, extra = {}) => ({ id, amount, occurred_at: day, is_shared: true, kind: amount < 0 ? 'expense' : 'income', ...extra });
const september = [tx('pay', 10000, '2026-09-25'), tx('food', -4000, '2026-09-10', { category_id: 'food' })];

describe('savingCheck', () => {
  it('gives the month\'s saving against its savings target in the budget', () => {
    const budgets = [{ year: 2026, month: 9, category_id: 'save', amount: '5000' }, { year: 2026, month: 9, category_id: 'food', amount: '4500' }];
    expect(savingCheck(SEPT, { transactions: september, budgets, categories }, NOW)).toEqual({ target: 5000, saved: 6000, short: 0 });
    const higher = [{ year: 2026, month: 9, category_id: 'save', amount: '7500' }];
    expect(savingCheck(SEPT, { transactions: september, budgets: higher, categories }, NOW)).toEqual({ target: 7500, saved: 6000, short: 1500 });
  });

  it('has nothing to check without a target for that month', () => {
    expect(savingCheck(SEPT, { transactions: september, budgets: [{ year: 2026, month: 10, category_id: 'save', amount: '5000' }], categories }, NOW)).toBeNull();
    expect(savingCheck(SEPT, { transactions: september, budgets: [], categories }, NOW)).toBeNull();
  });
});

describe('cashReserve', () => {
  const account = (id, type, aed, extra = {}) => ({ id, type, currency: 'AED', balance: aed, balance_aed: aed, archived_at: null, ...extra });
  const accounts = [
    account('c', 'checking', 10000),
    account('s', 'savings', 20000),
    // Not cash to hand: a deposit, investments, a card, a closed account.
    account('f', 'fd', 50000),
    account('i', 'investment', 90000),
    account('k', 'credit_card', 3000),
    account('x', 'savings', 7000, { archived_at: '2026-01-01T00:00:00Z' }),
  ];

  it('counts the open current, savings and cash accounts, as months of the plan\'s spending', () => {
    expect(cashReserve({ accounts, monthlySpend: 6000, keptCost: 36000 })).toEqual({ liquid: 30000, unvalued: 0, months: 5, target: 36000, targetMonths: 6 });
  });

  it('has no months without spending to divide by, and no target without a kept goal', () => {
    expect(cashReserve({ accounts, monthlySpend: null })).toMatchObject({ liquid: 30000, months: null, target: null, targetMonths: null });
    expect(cashReserve({ accounts, monthlySpend: 6000, keptCost: 0 })).toMatchObject({ months: 5, target: null });
  });

  it('counts an account with no AED value as nothing, and says how many there are', () => {
    const rupees = { id: 'r', type: 'savings', currency: 'INR', balance: 100000, balance_aed: null, archived_at: null };
    expect(cashReserve({ accounts: [...accounts, rupees], monthlySpend: 6000 })).toMatchObject({ liquid: 30000, unvalued: 1 });
  });
});
