import { describe, expect, it } from 'vitest';
import { planStart, planningModel } from './planningModel';
import { forecastInputs, budgetPlan } from './forecast';
import { lifePlanStop, loansInSpending } from './lifePlan';

// Planning audit, 3.12: one place every Planning tab's figures come from.
describe('planningModel', () => {
  const now = new Date(2026, 9, 20);
  const accounts = [{ id: 'a1', type: 'savings', currency: 'AED', balance: 200000, balance_aed: 200000, is_shared: true, archived_at: null }];
  // June to September ended, spending 4,000 on 10,000 of income.
  const transactions = [6, 7, 8, 9].flatMap((m) => [
    { id: `i${m}`, amount: 10000, kind: 'income', occurred_at: `2026-0${m}-05`, is_shared: true },
    { id: `s${m}`, amount: -4000, kind: 'expense', occurred_at: `2026-0${m}-06`, is_shared: true },
  ]);
  const categories = [
    { id: 'food', kind: 'expense' },
    { id: 'save', kind: 'expense', is_savings: true },
  ];
  const budgets = [10, 11, 12].flatMap((month) => [
    { year: 2026, month, category_id: 'food', amount: '3000' },
    { year: 2026, month, category_id: 'save', amount: '7000' },
  ]);
  const members = [{ id: 'm1', display_name: 'Alex' }];
  const data = {
    assumptions: null,
    goals: [],
    debts: [{ id: 'd1', name: 'Car loan', balance: 12000, apr_pct: 0, minimum_payment: 1000, account_id: null }],
    memberLife: [{ member_id: 'm1', birth_year: 1990, life_expectancy: 90 }],
    independenceIncome: [],
  };
  const model = planningModel({ accounts, transactions, budgets, categories, data, members, now });

  it('builds what every tab used to build for itself, the same way', () => {
    expect(model.startNetWorth).toBe(200000);
    // A savings account is cash, kept at the cash rate (4.19).
    expect(model.start).toEqual({ cash: 200000, rupees: 0 });
    expect(model.plan).toEqual(budgetPlan(budgets, categories, now));
    expect(model.inputs).toEqual(forecastInputs(transactions, 200000, now, model.plan, []));
    expect(model.inputs).toMatchObject({ source: 'actual', monthlySaving: 6000 });
    expect(model.loans).toEqual(loansInSpending({ debts: data.debts, accounts, transactions, now }));
    expect(model.people.map((p) => p.name)).toEqual(['Alex']);
  });

  it('gives the Life plan\'s answer as lifePlanStop does, with the range', () => {
    const stop = model.stop();
    const direct = lifePlanStop({
      members,
      memberLife: data.memberLife,
      assumptions: null,
      inputs: model.inputs,
      stopping: model.stopping,
      startNetWorth: 200000,
      start: model.start,
      goals: [],
      incomes: [],
      household: null,
      loans: model.loans,
      startYear: 2026,
      now,
    });
    expect(stop.earliest).toBe(direct.earliest);
    expect(stop.range.map((r) => r.key)).toEqual(['baseline', 'conservative']);
    expect(stop.stopYear).toBe(2050);
  });

  it('gives the budget\'s figures beside the records, and nothing on them without a budget', () => {
    expect(model.budgetBasis).toMatchObject({ source: 'budget', monthlySaving: 7000 });
    expect(model.basis({ budget: true }).args.annualSaving).toBe(84000);
    expect(model.basis().args.annualSaving).toBe(72000);
    expect(planningModel({ accounts, transactions, data, members, now }).stop({ budget: true })).toBeNull();
  });

  it('follows the chosen basis', () => {
    const chosen = planningModel({ accounts, transactions, budgets, categories, data: { ...data, assumptions: { planning_basis: 'budget' } }, members, now });
    expect(chosen.inputs).toMatchObject({ source: 'budget', why: 'chosen' });
    expect(chosen.budgetBasis).toBeNull();
  });

  it('counts the costs that start when work stops (3.13)', () => {
    const costs = [{ id: 'c1', name: 'Health cover', amount: '8000', currency: 'AED', per_person: true, rise_pct: '0', starts_after_years: 0, lasts_years: null }];
    const withCosts = planningModel({ accounts, transactions, budgets, categories, data: { ...data, afterWorkCosts: costs }, members, now });
    expect(withCosts.stop().costsAtStop).toBe(8000);
    expect(withCosts.basis().args.costs).toHaveLength(1);
    expect(model.stop().costsAtStop).toBe(0);
  });

  // Planning audit, 4.19: cash and rupees in what the plan starts from.
  it('counts cash accounts, deposits and cash holdings as cash, and rupee accounts and holdings as rupees', () => {
    const start = planningModel({
      accounts: [
        { id: 'c', type: 'checking', currency: 'AED', balance: 1000, is_shared: true, archived_at: null },
        { id: 'f', type: 'fd', currency: 'INR', balance: 50000, balance_aed: 2000, is_shared: true, archived_at: null },
        { id: 'i', type: 'investment', currency: 'AED', balance: 9000, is_shared: true, archived_at: null },
        { id: 'k', type: 'credit_card', currency: 'INR', balance: 500, balance_aed: 20, is_shared: true, archived_at: null },
        { id: 'x', type: 'savings', currency: 'AED', balance: 7000, is_shared: true, archived_at: '2026-01-01T00:00:00Z' },
      ],
      holdings: [
        { id: 'h1', asset_class: 'cash', currency: 'AED', value_aed: 300, priced_at: '2026-10-01T00:00:00Z' },
        { id: 'h2', asset_class: 'india_mf', currency: 'INR', value_aed: 4000, priced_at: '2026-10-01T00:00:00Z' },
        { id: 'h3', asset_class: 'us_equity', currency: 'USD', value_aed: 0, priced_at: null },
      ],
      data,
      members,
      now,
    }).start;
    expect(start).toEqual({ cash: 1000 + 2000 + 300, rupees: 2000 + 4000 });
  });

  it('earns less on cash than the plan once did, so the same household stops later or no sooner', () => {
    const withoutCash = lifePlanStop({ members, memberLife: data.memberLife, assumptions: null, inputs: model.inputs, startNetWorth: 200000, loans: model.loans, startYear: 2026, now });
    expect(model.stop().earliest).toBeGreaterThanOrEqual(withoutCash.earliest);
  });
});

// A broker's uninvested cash is cash the Life plan starts from, like a bank
// balance, not money invested (SHR-367).
describe('planStart', () => {
  it('counts broker funds as cash', () => {
    const funds = { id: 'f', type: 'broker_funds', currency: 'USD', balance: 100, balance_aed: 367.25, archived_at: null };
    const bank = { id: 'b', type: 'checking', currency: 'AED', balance: 1000, balance_aed: null, archived_at: null };
    expect(planStart([funds, bank], []).cash).toBe(1367.25);
  });
});

