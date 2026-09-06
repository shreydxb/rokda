import { describe, it, expect } from 'vitest';
import { simulatePayoffPlan } from './debt';

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
