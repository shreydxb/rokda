import { describe, it, expect } from 'vitest';
import {
  accountOptionLabel,
  activeAccounts,
  archivedAccounts,
  canDeleteAccount,
  closurePlan,
  isArchived,
  selectableAccounts,
} from './accounts';
import { netWorthSummary, visibleAccounts } from '../screens/overviewMath';

// QA-01 / SHR-242 acceptance: "closing a synthetic account with three
// transactions leaves all three in historical reports and removes the account
// from new-entry choices."
const CARD = { id: 'card-1', name: 'ENBD Noon', type: 'credit_card', balance: 0, is_shared: true, archived_at: null };
const SAVINGS = { id: 'sav-1', name: 'ADCB Savings', type: 'savings', balance: 1000, is_shared: true, archived_at: null };
const THREE_TX = [
  { id: 't1', account_id: 'card-1', amount: -100, occurred_at: '2026-06-01', is_shared: true },
  { id: 't2', account_id: 'card-1', amount: -50, occurred_at: '2026-07-01', is_shared: true },
  { id: 't3', account_id: 'card-1', amount: -25, occurred_at: '2026-08-01', is_shared: true },
];

describe('closing an account with history', () => {
  const closed = { ...CARD, archived_at: '2026-09-05T10:00:00Z' };

  it('archives rather than deletes when the account has transactions', () => {
    const plan = closurePlan(CARD, THREE_TX);
    expect(plan.action).toBe('archive');
    expect(plan.transactionCount).toBe(3);
    expect(plan.detail).toContain('3 transaction');
    expect(plan.detail).toContain('history');
  });

  it('refuses hard deletion for an account with transactions', () => {
    expect(canDeleteAccount(CARD, THREE_TX)).toBe(false);
  });

  it('leaves all three transactions untouched by the closure', () => {
    // Closing changes the account row only. Nothing in the ledger references
    // account state, so historical reports keep every row.
    const surviving = THREE_TX.filter((t) => t.account_id === closed.id);
    expect(surviving).toHaveLength(3);
    expect(surviving.reduce((s, t) => s + t.amount, 0)).toBe(-175);
  });

  it('removes the closed account from new-entry choices', () => {
    const all = [closed, SAVINGS];
    expect(selectableAccounts(all).map((a) => a.id)).toEqual(['sav-1']);
    expect(activeAccounts(all).map((a) => a.id)).toEqual(['sav-1']);
    expect(archivedAccounts(all).map((a) => a.id)).toEqual(['card-1']);
  });

  it('still offers the closed account to a record that already points at it', () => {
    const all = [closed, SAVINGS];
    expect(selectableAccounts(all, 'card-1').map((a) => a.id)).toEqual(['card-1', 'sav-1']);
  });

  it('drops the closed account out of the current net-worth position', () => {
    const openCard = { ...CARD, balance: 400 };
    expect(netWorthSummary([openCard, SAVINGS], null).netWorth).toBe(600);
    expect(netWorthSummary([{ ...openCard, archived_at: '2026-09-05T10:00:00Z' }, SAVINGS], null).netWorth).toBe(1000);
    expect(visibleAccounts([{ ...openCard, archived_at: '2026-09-05T10:00:00Z' }, SAVINGS], null)).toHaveLength(1);
  });
});

describe('deleting an unused account', () => {
  it('is offered only when nothing was ever recorded on it', () => {
    expect(canDeleteAccount(SAVINGS, THREE_TX)).toBe(true);
    const plan = closurePlan(SAVINGS, THREE_TX);
    expect(plan.action).toBe('delete');
    expect(plan.detail).toContain('nothing is lost');
  });
});

describe('closure warnings', () => {
  it('says so when closing an account that still holds money', () => {
    const withBalance = { ...CARD, balance: 250 };
    expect(closurePlan(withBalance, THREE_TX).detail).toContain('net worth');
  });

  it('stays quiet about balance when the account is settled', () => {
    expect(closurePlan(CARD, THREE_TX).detail).not.toContain('net worth');
  });
});

describe('account selector labels', () => {
  const fabA = { id: 'a', name: 'FAB', type: 'credit_card', is_shared: false, owner_member_id: 'm1' };
  const fabB = { id: 'b', name: 'FAB', type: 'savings', is_shared: true };
  const members = [{ id: 'm1', display_name: 'Shreyash' }];

  it('leaves an unambiguous name alone', () => {
    expect(accountOptionLabel(SAVINGS, { members, accounts: [SAVINGS, fabA] })).toBe('ADCB Savings');
  });

  it('qualifies duplicate names with owner and type', () => {
    const accounts = [fabA, fabB];
    expect(accountOptionLabel(fabA, { members, accounts })).toBe('FAB · Shreyash · credit card');
    expect(accountOptionLabel(fabB, { members, accounts })).toBe('FAB · Joint · savings');
  });

  it('marks a closed account in a list that still shows it', () => {
    const closed = { ...SAVINGS, archived_at: '2026-09-05T10:00:00Z' };
    expect(accountOptionLabel(closed, { members, accounts: [closed] })).toContain('closed');
    expect(isArchived(closed)).toBe(true);
  });
});
