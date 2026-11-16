import { describe, it, expect } from 'vitest';
import { assetGroups, cardCycle, liabilityRows, paymentDue } from './netWorthLedger';

// 16 November 2026, midday.
const NOW = new Date(2026, 10, 16, 12);
const RECENT = '2026-11-02T09:00:00Z';
const OLD = '2026-09-20T09:00:00Z';
const members = [
  { id: 'm1', display_name: 'Alex' },
  { id: 'm2', display_name: 'Sam' },
];
const account = (id, type, extra = {}) => ({ id, name: id, type, currency: 'AED', balance: 1000, is_shared: true, owner_member_id: null, archived_at: null, balance_as_of: RECENT, ...extra });
const tx = (id, account_id, amount, occurred_at, extra = {}) => ({ id, account_id, amount, occurred_at, kind: amount < 0 ? 'expense' : 'refund', is_shared: true, ...extra });

describe('assetGroups', () => {
  const accounts = [
    account('Current', 'checking', { balance: 5000 }),
    account('Savings', 'savings', { balance: 20000, is_shared: false, owner_member_id: 'm1' }),
    account('Wallet', 'cash', { balance: 300, is_shared: false, owner_member_id: 'm2' }),
    account('Deposit', 'fd', { balance: 10000, maturity_date: '2027-03-12', interest_rate_pct: 4.5, fd_status: 'active' }),
    account('Broker cash', 'broker_funds', { balance: 700 }),
    account('Card', 'credit_card', { balance: 900 }),
    account('Old', 'checking', { archived_at: '2026-06-01T00:00:00Z' }),
  ];

  it('groups the open assets by type, in the prototype’s order, with each group’s total', () => {
    const groups = assetGroups(accounts, { by: 'type', members, scopeMemberId: null, now: NOW });
    expect(groups.map((g) => [g.label, g.total, g.rows.map((r) => r.account.id)])).toEqual([
      ['Current accounts', 5000, ['Current']],
      ['Savings', 20000, ['Savings']],
      ['Cash', 300, ['Wallet']],
      ['Deposits and broker funds', 10700, ['Deposit', 'Broker cash']],
    ]);
  });

  it('names the type only where a group mixes them, with a deposit’s maturity and rate', () => {
    const groups = assetGroups(accounts, { by: 'type', members, scopeMemberId: null, now: NOW });
    const deposits = groups.find((g) => g.label === 'Deposits and broker funds');
    expect(deposits.rows.map((r) => r.sub)).toEqual(['Fixed deposit · matures 12 Mar 2027 · 4.5%', 'Broker funds']);
    expect(groups.find((g) => g.label === 'Savings').rows[0].sub).toBeNull();
  });

  it('groups by owner, shared first, then each person in turn, each row with its type', () => {
    const groups = assetGroups(accounts, { by: 'owner', members, scopeMemberId: null, now: NOW });
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.account.id)])).toEqual([
      ['Shared', ['Current', 'Deposit', 'Broker cash']],
      ['Alex', ['Savings']],
      ['Sam', ['Wallet']],
    ]);
    expect(groups[1].rows[0].sub).toBe('Savings');
  });

  it('counts nothing for a balance nobody confirmed, and names one confirmed long ago', () => {
    const groups = assetGroups([account('Unset', 'checking', { balance_as_of: null }), account('Stale', 'checking', { balance: 200, balance_as_of: OLD })], { by: 'type', members, scopeMemberId: null, now: NOW });
    const [unset, stale] = groups[0].rows;
    expect(unset).toMatchObject({ value: null, status: { kind: 'unset' } });
    expect(stale).toMatchObject({ value: 200, status: { kind: 'stale', days: 57 } });
    expect(groups[0].total).toBe(200);
  });

  it('gives a balance in another currency in that currency, and leaves one not converted out of the total', () => {
    const groups = assetGroups(
      [account('Dollars', 'savings', { currency: 'USD', balance: 1000, balance_aed: 3672.5 }), account('Rupees', 'savings', { currency: 'INR', balance: 50000, balance_aed: null })],
      { by: 'type', members, scopeMemberId: null, now: NOW },
    );
    const [dollars, rupees] = groups[0].rows;
    expect(dollars).toMatchObject({ value: 3672.5, sub: 'USD 1,000' });
    expect(rupees).toMatchObject({ value: null, native: 'INR 50,000' });
    expect(groups[0].total).toBe(3672.5);
  });

  it('shows one person their own accounts and their half of the shared ones', () => {
    const groups = assetGroups(accounts, { by: 'type', members, scopeMemberId: 'm1', now: NOW });
    expect(groups.map((g) => [g.label, g.total])).toEqual([
      ['Current accounts', 2500],
      ['Savings', 20000],
      ['Deposits and broker funds', 5350],
    ]);
  });
});

describe('cardCycle', () => {
  const card = account('Card', 'credit_card', { statement_day: 10, due_day: 25 });

  it('runs from the day after the last statement to the next, counted as a statement counts', () => {
    const transactions = [
      tx('closing-day', 'Card', -50, '2026-11-10'),
      tx('in', 'Card', -120, '2026-11-11'),
      tx('refund', 'Card', 20, '2026-11-12'),
      tx('later', 'Card', -30, '2026-11-14'),
      tx('scheduled', 'Card', -999, '2026-11-20'),
      tx('elsewhere', 'Current', -400, '2026-11-12'),
    ];
    const cycle = cardCycle(card, transactions, NOW);
    expect(cycle).toMatchObject({ from: '2026-11-11', to: '2026-12-10', closesIn: 24, spent: 130 });
    expect(cycle.transactions.map((t) => t.id)).toEqual(['later', 'refund', 'in']);
  });

  it('closes today on the statement day itself, and has no cycle without a statement day', () => {
    expect(cardCycle(card, [], new Date(2026, 11, 10, 9))).toMatchObject({ from: '2026-11-11', to: '2026-12-10', closesIn: 0 });
    expect(cardCycle({ ...card, statement_day: null }, [], NOW)).toBeNull();
  });
});

describe('liabilityRows', () => {
  it('gives a card its cycle and the share of its limit the cycle has used', () => {
    const card = account('Card', 'credit_card', { statement_day: 10, due_day: 25, credit_limit: 1000, balance: 400 });
    const [row] = liabilityRows([card, account('Current', 'checking')], [tx('a', 'Card', -250, '2026-11-12')], { scopeMemberId: null, now: NOW });
    expect(row).toMatchObject({ value: 400, cycle: { spent: 250, closesIn: 24 }, limitUsed: { share: 0.25, limit: 1000 } });
  });

  it('measures a card with no statement day by its balance, and gives no share against a limit in another currency', () => {
    const plain = account('Plain', 'credit_card', { credit_limit: 2000, balance: 500 });
    const dollars = account('Dollars', 'credit_card', { currency: 'USD', statement_day: 10, credit_limit: 1000, balance: 100, balance_aed: 367 });
    const rows = liabilityRows([plain, dollars], [tx('a', 'Dollars', -50, '2026-11-12')], { scopeMemberId: null, now: NOW });
    expect(rows.find((r) => r.account.id === 'Plain').limitUsed).toEqual({ share: 0.25, limit: 2000, currency: 'AED' });
    expect(rows.find((r) => r.account.id === 'Dollars').limitUsed).toBeNull();
  });

  it('names a loan’s type and leaves a closed liability out', () => {
    const rows = liabilityRows([account('Car loan', 'loan', { balance: 30000 }), account('Old card', 'credit_card', { archived_at: '2026-01-01T00:00:00Z' })], [], { scopeMemberId: null, now: NOW });
    expect(rows.map((r) => [r.account.id, r.sub, r.cycle])).toEqual([['Car loan', 'Loan', null]]);
  });
});

describe('paymentDue', () => {
  const card = account('Card', 'credit_card', { statement_day: 10, due_day: 25 });
  const row = (statementDate, dueDate, extra = {}) => ({ account: card, statementDate, dueDate, recordedSpend: 640.5, statementBalance: null, ...extra });

  it('is the latest statement’s while it is still ahead, with what the statement holds', () => {
    const due = paymentDue(card, [row('2026-11-10', '2026-11-25', { statementBalance: 700 }), row('2026-10-10', '2026-10-25')], NOW);
    expect(due).toEqual({ date: '2026-11-25', amount: 700, statementTo: '2026-11-10' });
    expect(paymentDue(card, [row('2026-11-10', '2026-11-25')], NOW).amount).toBe(640.5);
  });

  it('is the running cycle’s once the latest is past, and nothing without a due day', () => {
    expect(paymentDue(card, [row('2026-10-10', '2026-10-25')], NOW)).toEqual({ date: '2026-12-25', cycleTo: '2026-12-10' });
    expect(paymentDue({ ...card, due_day: null }, [], NOW)).toBeNull();
    // A card with a due day and no statement day is due on the next one.
    expect(paymentDue({ ...card, statement_day: null }, [], NOW)).toEqual({ date: '2026-11-25' });
  });
});
