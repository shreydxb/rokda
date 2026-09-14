import { describe, it, expect } from 'vitest';
import { balanceLabel, balanceStatus, daysSinceBalanceConfirmed, isBalanceConfirmed, isDerivedBalance, netWorthProvisional, unconfirmedAccounts } from './balance';
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

// QA pass 3, O4: a computed FD balance is a derived fact, not a manual
// snapshot, so it must not sit in the "nobody has confirmed this" bucket.
describe('O4: fixed deposits are valued without a manual confirmation', () => {
  const fd = (extra = {}) => ({
    type: 'fd',
    principal: 10000,
    interest_rate_pct: 6,
    balance: 10600,
    balance_as_of: null,
    ...extra,
  });

  it('treats a computed FD as valued even with no balance_as_of', () => {
    expect(isDerivedBalance(fd())).toBe(true);
    expect(isBalanceConfirmed(fd())).toBe(true);
    expect(balanceStatus(fd())).toBe('confirmed');
  });

  it('never calls a derived balance stale, because it is recomputed daily', () => {
    // A year on from any stamp it might have carried, it is still current:
    // fd-accrual touches every active FD and the trigger recalculates.
    expect(balanceStatus(fd(), new Date('2027-09-14'))).toBe('confirmed');
    expect(balanceLabel(fd(), new Date('2027-09-14'))).toBe(null);
  });

  it('reports no confirmation age rather than 1970', () => {
    // daysSinceBalanceConfirmed keys off the stamp, not off "is it valued":
    // new Date(null) is the epoch, which would read as ~20,000 days stale.
    expect(daysSinceBalanceConfirmed(fd())).toBe(null);
  });

  it('keeps an FD out of the unconfirmed list, so net worth is not provisional for it', () => {
    // The list drives both the attention item and the "provisional" label.
    // An FD in it asked for something nobody can do.
    expect(unconfirmedAccounts([fd()])).toEqual([]);
    expect(netWorthProvisional([fd()])).toBe(false);
  });

  it('still waits for a confirmation on an FD with nothing to compute from', () => {
    // Not every row typed as 'fd' is derivable; without principal and rate
    // the balance really is just a number somebody has not vouched for.
    expect(isDerivedBalance(fd({ principal: null }))).toBe(false);
    expect(balanceStatus(fd({ principal: null }))).toBe('unset');
    expect(isDerivedBalance(fd({ interest_rate_pct: null }))).toBe(false);
  });

  it('leaves ordinary accounts exactly as they were', () => {
    const checking = { type: 'checking', balance: 100, balance_as_of: null };
    expect(isDerivedBalance(checking)).toBe(false);
    expect(balanceStatus(checking)).toBe('unset');
    expect(balanceStatus({ ...checking, balance_as_of: '2026-09-14' }, new Date('2026-09-14'))).toBe('confirmed');
  });
});

describe('O4: the attention list stops asking for the impossible', () => {
  const args = { transactions: [], recurring: [], holdings: [], categories: [], scopeMemberId: null, now: NOW };
  const FD = {
    id: 'fd1',
    name: 'Term deposit',
    type: 'fd',
    principal: 10000,
    interest_rate_pct: 6,
    balance: 10600,
    balance_as_of: null,
    archived_at: null,
    is_shared: true,
    owner_member_id: null,
  };

  it('raises no balance item for a computed FD', () => {
    // It used to raise one saying "net worth treats it as zero until someone
    // confirms what it actually is" -- false, since netWorthSummary was
    // already counting it, and unactionable, since the figure is derived.
    const items = buildAttentionItems({ ...args, accounts: [FD] });
    expect(items.find((i) => i.kind === 'balance_unset')).toBeFalsy();
  });

  it('still raises one for an ordinary account with no confirmed balance', () => {
    const items = buildAttentionItems({ ...args, accounts: [CARD] });
    expect(items.find((i) => i.kind === 'balance_unset')).toBeTruthy();
  });

  it('still raises one for an FD that has nothing to compute from', () => {
    const items = buildAttentionItems({ ...args, accounts: [{ ...FD, principal: null }] });
    expect(items.find((i) => i.kind === 'balance_unset')).toBeTruthy();
  });
});
