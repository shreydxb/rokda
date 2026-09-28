import { describe, it, expect } from 'vitest';
import { categoryOwner, householdShare, monthlyIncomeByMember, shareSplit } from './share';

const NOW = new Date(2026, 9, 20, 12); // 20 October 2026
const HIM = { id: 'him', display_name: 'Shreyash' };
const HER = { id: 'her', display_name: 'Tarika' };
const MEMBERS = [HIM, HER];

const CATEGORIES = [
  { id: 'housing', name: 'Housing' },
  { id: 'rent', name: 'Rent', parent_id: 'housing' },
  { id: 'transport', name: 'Transport', owner_member_id: 'him' },
  { id: 'emi', name: 'Car EMI', parent_id: 'transport' },
  { id: 'family', name: 'Family Support' },
  { id: 'raipur', name: 'Raipur Remittance', parent_id: 'family', owner_member_id: 'her' },
  { id: 'savings', name: 'Savings', is_savings: true },
  { id: 'her-goals', name: "Tarika's Goals", parent_id: 'savings', is_savings: true, owner_member_id: 'her' },
];
const RECURRING = [
  { id: 's1', amount: 24000, cadence: 'monthly', next_due_date: '2026-10-30', owner_member_id: 'him', is_shared: false },
  { id: 's2', amount: 8500, cadence: 'monthly', next_due_date: '2026-10-25', owner_member_id: 'her', is_shared: false },
  { id: 'bill', amount: -5833, cadence: 'monthly', next_due_date: '2026-10-01', owner_member_id: 'him', is_shared: false },
];
const ACCOUNTS = [
  { id: 'his-card', owner_member_id: 'him', is_shared: false },
  { id: 'her-bank', owner_member_id: 'her', is_shared: false },
  { id: 'joint', owner_member_id: null, is_shared: true },
];

describe('categoryOwner', () => {
  const byId = new Map(CATEGORIES.map((c) => [c.id, c]));
  it('reads a category’s own owner, else its parent’s, else shared', () => {
    expect(categoryOwner('raipur', byId)).toBe('her');
    expect(categoryOwner('emi', byId)).toBe('him');
    expect(categoryOwner('rent', byId)).toBeNull();
    expect(categoryOwner('missing', byId)).toBeNull();
  });
});

describe('shareSplit', () => {
  it('splits by usual monthly income, ignoring bills', () => {
    const { basis, pct, income } = shareSplit(RECURRING, MEMBERS, NOW);
    expect(basis).toBe('income');
    expect(income.get('him')).toBe(24000);
    expect(pct.get('him')).toBeCloseTo(24000 / 32500);
    expect(pct.get('her')).toBeCloseTo(8500 / 32500);
  });

  it('falls back to an even split with no income to go on', () => {
    const { basis, pct } = shareSplit([], MEMBERS, NOW);
    expect(basis).toBe('even');
    expect(pct.get('her')).toBe(0.5);
  });

  it('turns other cadences into a month and leaves out ended or paused income', () => {
    const income = monthlyIncomeByMember(
      [
        { amount: 12000, cadence: 'yearly', next_due_date: '2027-01-01', owner_member_id: 'her' },
        { amount: 900, cadence: 'monthly', next_due_date: '2026-10-01', owner_member_id: 'her', active: false },
        { amount: 900, cadence: 'monthly', next_due_date: '2026-01-01', ends_on: '2026-03-01', owner_member_id: 'her' },
        { amount: 1000, cadence: 'monthly', next_due_date: '2026-10-01', is_shared: true },
      ],
      MEMBERS,
      NOW,
    );
    expect(income.get('her')).toBe(1500);
    expect(income.get('him')).toBe(500);
  });
});

describe('householdShare', () => {
  const BUDGETS = [
    { year: 2026, month: 10, category_id: 'rent', amount: 6500 },
    { year: 2026, month: 10, category_id: 'emi', amount: 2194 },
    { year: 2026, month: 10, category_id: 'raipur', amount: 417 },
    { year: 2026, month: 10, category_id: 'her-goals', amount: 2000 },
    { year: 2026, month: 11, category_id: 'rent', amount: 99999 },
  ];

  it('plans each person’s own lines plus their split of the shared ones, savings apart', () => {
    const share = householdShare({ members: MEMBERS, categories: CATEGORIES, budgets: BUDGETS, recurring: RECURRING, year: 2026, month: 10, now: NOW });
    expect(share.planned.shared).toBe(6500);
    const [him, her] = share.people;
    expect(him.ownPlanned).toBe(2194);
    expect(her.ownPlanned).toBe(417);
    expect(him.planned + her.planned).toBeCloseTo(6500 + 2194 + 417);
    expect(her.sharedPlanned).toBeCloseTo(6500 * (8500 / 32500));
    expect(her.savingPlanned).toBe(2000);
    expect(him.savingPlanned).toBe(0);
  });

  it('settles what was paid against what each is responsible for', () => {
    const transactions = [
      // He pays the whole rent: the household's, so she owes her part.
      { occurred_at: '2026-10-01', amount: -6500, category_id: 'rent', account_id: 'his-card' },
      // His own EMI from his card: nothing between them.
      { occurred_at: '2026-10-03', amount: -2194, category_id: 'emi', account_id: 'his-card' },
      // Her remittance from his card: she owes it all back.
      { occurred_at: '2026-10-05', amount: -417, category_id: 'raipur', account_id: 'his-card' },
      // Groceries from the joint account are already split.
      { occurred_at: '2026-10-06', amount: -300, category_id: null, account_id: 'joint' },
      // Income, a later month, and a future date are not spending this month.
      { occurred_at: '2026-10-25', amount: 8500, category_id: null, account_id: 'her-bank' },
      { occurred_at: '2026-11-01', amount: -6500, category_id: 'rent', account_id: 'his-card' },
      { occurred_at: '2026-10-28', amount: -50, category_id: 'rent', account_id: 'her-bank' },
    ];
    const share = householdShare({ members: MEMBERS, categories: CATEGORIES, budgets: BUDGETS, transactions, accounts: ACCOUNTS, recurring: RECURRING, year: 2026, month: 10, now: NOW });
    const herPct = 8500 / 32500;
    expect(share.spent).toBe(6500 + 2194 + 417 + 300);
    expect(share.sharedSpent).toBe(6800);
    expect(share.settle.from).toBe(HER);
    expect(share.settle.to).toBe(HIM);
    expect(share.settle.amount).toBeCloseTo(6500 * herPct + 417);
    const [him, her] = share.people;
    expect(him.net + her.net).toBeCloseTo(0);
  });

  it('refunds reduce what was spent and nothing owed reads as even', () => {
    const transactions = [
      { occurred_at: '2026-10-02', amount: -100, category_id: 'emi', account_id: 'his-card' },
      { occurred_at: '2026-10-03', amount: 40, kind: 'refund', category_id: 'emi', account_id: 'his-card' },
    ];
    const share = householdShare({ members: MEMBERS, categories: CATEGORIES, transactions, accounts: ACCOUNTS, recurring: RECURRING, year: 2026, month: 10, now: NOW });
    expect(share.spent).toBe(60);
    expect(share.settle).toBeNull();
  });
});
