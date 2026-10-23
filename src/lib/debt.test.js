import { describe, it, expect } from 'vitest';
import { amortizeMinimumOnly, debtsWithAccounts, simulatePayoffPlan } from './debt';

// QA / SHR-228: simulatePayoffPlan lost the unused part of a minimum payment
// in the very month it went unused, instead of carrying it into the same
// month's allocation. AED 200 available against AED 200 of total debt should
// clear both in one month, not two.
describe('SHR-228: unused minimum payment is not lost in the payoff month', () => {
  it('published reproduction: two debts totalling the available minimums clear in one month', () => {
    const plan = simulatePayoffPlan(
      [
        { balance: 50, apr_pct: 0, minimum_payment: 100 },
        { balance: 150, apr_pct: 0, minimum_payment: 100 },
      ],
      0,
    );
    expect(plan.months).toBe(1);
  });

  it('includes an already-paid debt without extending the payoff', () => {
    const plan = simulatePayoffPlan(
      [
        { balance: 0, apr_pct: 0, minimum_payment: 100 },
        { balance: 100, apr_pct: 0, minimum_payment: 100 },
      ],
      0,
    );
    expect(plan.months).toBe(1);
  });

  it('reports zero months when every debt is already paid off', () => {
    const plan = simulatePayoffPlan([{ balance: 0, apr_pct: 0, minimum_payment: 100 }], 0);
    expect(plan.months).toBe(0);
  });

  it('detects a payoff that lands exactly on maxMonths', () => {
    // A single debt with a fixed monthly payment and no interest clears in
    // exactly balance / payment months — here, exactly at the cap.
    const plan = simulatePayoffPlan([{ balance: 500, apr_pct: 0, minimum_payment: 100 }], 0, 5);
    expect(plan).not.toBeNull();
    expect(plan.months).toBe(5);
  });

  it('returns null when the debt cannot clear within maxMonths', () => {
    const plan = simulatePayoffPlan([{ balance: 1000, apr_pct: 0, minimum_payment: 100 }], 0, 5);
    expect(plan).toBeNull();
  });
});

describe('debtsWithAccounts', () => {
  const debt = { id: 'd', name: 'Car loan', balance: '40000', apr_pct: 3.5, minimum_payment: 2193, account_id: 'a' };
  const loan = { id: 'a', type: 'loan', currency: 'AED', balance: 38000, balance_aed: 38000, archived_at: null };

  it('owes what the linked account says, and net worth counts it', () => {
    expect(debtsWithAccounts([debt], [loan])[0]).toMatchObject({ balance: 38000, inNetWorth: true, account: loan });
  });

  it('reads a loan entered as a negative balance as the amount owed', () => {
    expect(debtsWithAccounts([debt], [{ ...loan, balance: -38000, balance_aed: -38000 }])[0]).toMatchObject({ balance: 38000, inCredit: false });
  });

  // A card in credit read as owed here while net worth and the bot read it as
  // money held (Planning audit, 0b-D).
  it('reads a card stored below zero as in credit, owing nothing', () => {
    const card = { id: 'a', type: 'credit_card', currency: 'AED', balance: -1500, balance_aed: -1500, archived_at: null };
    expect(debtsWithAccounts([debt], [card])[0]).toMatchObject({ balance: 0, inCredit: true, inNetWorth: true });
    expect(debtsWithAccounts([debt], [{ ...card, balance: 1500, balance_aed: 1500 }])[0]).toMatchObject({ balance: 1500, inCredit: false });
  });

  // Debt payoff gave a linked loan to one partner while net worth gave it to
  // the other (Planning audit, 0b-D).
  it('belongs to whoever its account does', () => {
    const own = { ...debt, is_shared: false, owner_member_id: 'm2' };
    expect(debtsWithAccounts([own], [{ ...loan, is_shared: false, owner_member_id: 'm1' }])[0]).toMatchObject({ is_shared: false, owner_member_id: 'm1' });
    expect(debtsWithAccounts([own], [{ ...loan, is_shared: true, owner_member_id: null }])[0]).toMatchObject({ is_shared: true, owner_member_id: null });
    // With no account, the debt's own owner stands.
    expect(debtsWithAccounts([{ ...own, account_id: null }], [loan])[0]).toMatchObject({ is_shared: false, owner_member_id: 'm2' });
  });

  it('keeps its own balance, outside net worth, with no account or one it cannot value', () => {
    expect(debtsWithAccounts([{ ...debt, account_id: null }], [loan])[0]).toMatchObject({ balance: 40000, inNetWorth: false, account: null });
    expect(debtsWithAccounts([debt], [{ ...loan, archived_at: '2026-09-01T00:00:00Z' }])[0]).toMatchObject({ balance: 40000, inNetWorth: false });
    expect(debtsWithAccounts([debt], [{ ...loan, currency: 'INR', balance_aed: null }])[0]).toMatchObject({ balance: 40000, inNetWorth: false });
  });
});

// A paid-off debt read as clearing in a month, and one clearing after 50
// years as never clearing (Planning audit, 0b-D).
describe('amortizeMinimumOnly', () => {
  it('counts the months paying only the minimum takes', () => {
    expect(amortizeMinimumOnly(1200, 0, 100)).toBe(12);
  });

  it('owes nothing for a balance of 0 or a card in credit', () => {
    expect(amortizeMinimumOnly(0, 30, 500)).toBe(0);
    expect(amortizeMinimumOnly(-200, 30, 500)).toBe(0);
  });

  it('never clears when the minimum does not cover the interest', () => {
    expect(amortizeMinimumOnly(100000, 24, 1000)).toBeNull();
  });

  it('tells a very long debt from one that never clears', () => {
    expect(amortizeMinimumOnly(100000, 6, 520)).toBe(Infinity);
    expect(amortizeMinimumOnly(100000, 6, 520, 1200)).toBe(654);
  });
});
