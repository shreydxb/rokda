import { describe, it, expect } from 'vitest';
import { balanceLabel, balanceStatus, isBalanceConfirmed, netWorthProvisional, unconfirmedAccounts } from './balance';
import { buildAttentionItems } from './attention';

const NOW = new Date(2026, 8, 5, 12);
const CARD = { id: 'c1', name: 'ENBD Noon', type: 'credit_card', balance: 0, is_shared: true, archived_at: null };

// QA-02 / SHR-243: `balance` defaults to 0, so an account nobody had valued
// read as a confirmed zero — "Nothing owed" on a card with recorded spending.
describe('QA-02: unknown balances are not confirmed zeros', () => {
  it('treats an unconfirmed balance as unset, whatever the number is', () => {
    expect(isBalanceConfirmed(CARD)).toBe(false);
    expect(balanceStatus(CARD, NOW)).toBe('unset');
    expect(balanceLabel(CARD, NOW)).toBe('Balance not set');
  });

  it('accepts an explicitly confirmed zero as a real fact', () => {
    const confirmed = { ...CARD, balance_as_of: '2026-09-04T00:00:00Z' };
    expect(balanceStatus(confirmed, NOW)).toBe('confirmed');
    expect(balanceLabel(confirmed, NOW)).toBeNull();
  });

  it('flags a confirmation that has gone stale without pretending it is unset', () => {
    const old = { ...CARD, balance: 1200, balance_as_of: '2026-06-01T00:00:00Z' };
    expect(balanceStatus(old, NOW)).toBe('stale');
    expect(balanceLabel(old, NOW)).toMatch(/Balance checked \d+d ago/);
  });

  it('marks net worth provisional while any account is unconfirmed', () => {
    const confirmed = { ...CARD, id: 'c2', balance_as_of: '2026-09-04T00:00:00Z' };
    expect(netWorthProvisional([CARD, confirmed])).toBe(true);
    expect(unconfirmedAccounts([CARD, confirmed]).map((a) => a.id)).toEqual(['c1']);
    expect(netWorthProvisional([confirmed])).toBe(false);
  });
});

describe('QA-02: setup gaps reach the attention list', () => {
  const args = { transactions: [], recurring: [], holdings: [], categories: [], scopeMemberId: null, now: NOW };

  it('raises an item for an account with no confirmed balance', () => {
    const items = buildAttentionItems({ ...args, accounts: [CARD] });
    const item = items.find((i) => i.kind === 'balance_unset');
    expect(item).toBeTruthy();
    expect(item.title).toContain('no confirmed balance');
    // So Overview cannot say "All caught up" while setup is incomplete.
    expect(items.length).toBeGreaterThan(0);
  });

  it('says nothing once the balance is confirmed', () => {
    const confirmed = { ...CARD, balance_as_of: '2026-09-04T00:00:00Z' };
    const items = buildAttentionItems({ ...args, accounts: [confirmed] });
    expect(items.some((i) => i.kind === 'balance_unset')).toBe(false);
  });

  it('ignores a closed account', () => {
    const closed = { ...CARD, archived_at: '2026-09-01T00:00:00Z' };
    const items = buildAttentionItems({ ...args, accounts: [closed] });
    expect(items.some((i) => i.kind === 'balance_unset')).toBe(false);
  });
});
