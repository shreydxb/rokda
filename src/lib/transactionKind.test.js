import { describe, it, expect } from 'vitest';
import { applyToIncomeSpend, incomeSpendOf, isIncomeRow, isSpendRow, isTransfer, spendDelta } from './transactionKind';

describe('what a transaction does to income and spending', () => {
  const expense = { kind: 'expense', amount: -100 };
  const income = { kind: 'income', amount: 500 };
  const refund = { kind: 'refund', amount: 20 };
  const transferOut = { kind: 'transfer', amount: -300 };
  const transferIn = { kind: 'transfer', amount: 300 };

  it('counts an expense as spending and income as income', () => {
    expect(incomeSpendOf(expense, -100)).toEqual({ income: 0, spend: 100 });
    expect(incomeSpendOf(income, 500)).toEqual({ income: 500, spend: 0 });
  });

  it('nets a refund against spending', () => {
    expect(incomeSpendOf(refund, 20)).toEqual({ income: 0, spend: -20 });
  });

  it('counts neither side of a transfer as income or spending', () => {
    expect(isTransfer(transferOut)).toBe(true);
    for (const t of [transferOut, transferIn]) {
      const v = t.amount;
      expect(isSpendRow(t, v)).toBe(false);
      expect(isIncomeRow(t, v)).toBe(false);
      expect(spendDelta(t, v)).toBe(0);
      expect(incomeSpendOf(t, v)).toEqual({ income: 0, spend: 0 });
    }
  });

  it('leaves a month with a card payment counting only its purchases', () => {
    const totals = { income: 0, spend: 0 };
    for (const t of [expense, income, refund, transferOut, transferIn]) applyToIncomeSpend(t, t.amount, totals);
    expect(totals).toEqual({ income: 500, spend: 80 });
  });
});
