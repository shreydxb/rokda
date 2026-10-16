import { describe, it, expect } from 'vitest';
import { orderPair, transferCandidates, transferCounterpart, transferDirectionLabel, transferLinkOf } from './transfers';

const CURRENT = 'current';
const CARD = 'card';
const accounts = new Map([
  [CURRENT, { id: CURRENT, name: 'Current account' }],
  [CARD, { id: CARD, name: 'Bank card' }],
]);
const payment = { id: 'p', account_id: CURRENT, amount: -1200, kind: 'expense', occurred_at: '2026-10-10' };
const arrival = { id: 'a', account_id: CARD, amount: 1200, kind: 'income', occurred_at: '2026-10-11' };

describe('transferCandidates', () => {
  it('finds the same amount the other way on another account, within a few days', () => {
    const others = [
      arrival,
      { id: 'far', account_id: CARD, amount: 1200, kind: 'income', occurred_at: '2026-10-20' },
      { id: 'same-account', account_id: CURRENT, amount: 1200, kind: 'income', occurred_at: '2026-10-10' },
      { id: 'fee-off', account_id: CARD, amount: 1199, kind: 'income', occurred_at: '2026-10-10' },
      { id: 'same-way', account_id: CARD, amount: -1200, kind: 'expense', occurred_at: '2026-10-10' },
      { id: 'already', account_id: CARD, amount: 1200, kind: 'transfer', occurred_at: '2026-10-10' },
      { id: 'refund', account_id: CARD, amount: 1200, kind: 'refund', occurred_at: '2026-10-10' },
    ];
    expect(transferCandidates(payment, [payment, ...others]).map((t) => t.id)).toEqual(['a']);
  });

  it('puts the closest in time first', () => {
    const later = { ...arrival, id: 'later', occurred_at: '2026-10-13' };
    expect(transferCandidates(payment, [later, arrival]).map((t) => t.id)).toEqual(['a', 'later']);
  });

  it('suggests nothing for a record that is already a transfer', () => {
    expect(transferCandidates({ ...payment, kind: 'transfer' }, [arrival])).toEqual([]);
  });
});

describe('a transfer’s two sides', () => {
  const links = [{ id: 'l', kind: 'transfer', from_transaction_id: 'p', to_transaction_id: 'a' }];
  const p = { ...payment, kind: 'transfer' };
  const a = { ...arrival, kind: 'transfer' };

  it('finds the link and the other side from either side', () => {
    expect(transferLinkOf('a', links).id).toBe('l');
    expect(transferCounterpart(p, links, [p, a]).id).toBe('a');
    expect(transferCounterpart(a, links, [p, a]).id).toBe('p');
    expect(transferCounterpart({ id: 'x' }, links, [p, a])).toBeNull();
  });

  it('says which way the money went', () => {
    expect(transferDirectionLabel(p, a, accounts)).toBe('To Bank card');
    expect(transferDirectionLabel(a, p, accounts)).toBe('From Current account');
    expect(transferDirectionLabel(p, null, accounts)).toBe('Transfer');
  });

  it('orders a pair money-out first', () => {
    expect(orderPair(arrival, payment)).toEqual({ out: payment, in: arrival });
  });
});
