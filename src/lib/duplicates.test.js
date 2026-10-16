import { describe, it, expect } from 'vitest';
import { confirmedPairRow, duplicatePairs, findDuplicate, isConfirmedPair } from './duplicates';

const rec = (id, extra = {}) => ({ id, account_id: 'card', merchant: 'Cafe', amount: -25, kind: 'expense', occurred_at: '2026-09-10', created_at: `2026-09-10T0${id.length}:00:00Z`, ...extra });

describe('findDuplicate', () => {
  it('finds a record on the same account and merchant for the same amount within a few days', () => {
    const form = { merchant: 'cafe ', amount: '25', account_id: 'card', occurred_at: '2026-09-12' };
    expect(findDuplicate(form, [rec('a')])?.id).toBe('a');
    expect(findDuplicate({ ...form, occurred_at: '2026-09-20' }, [rec('a')])).toBeNull();
  });
});

describe('duplicatePairs', () => {
  it('pairs records that look like one recorded twice, the earlier recorded first', () => {
    const a = rec('a');
    const b = rec('bb', { occurred_at: '2026-09-11' });
    expect(duplicatePairs([b, a], [a, b]).map((p) => [p.first.id, p.second.id])).toEqual([['a', 'bb']]);
  });

  it('leaves out different accounts, merchants, amounts, directions, far dates and transfers', () => {
    const a = rec('a');
    const others = [
      rec('other-account', { account_id: 'current' }),
      rec('other-shop', { merchant: 'Shop' }),
      rec('other-amount', { amount: -25.01 }),
      rec('refund', { amount: 25, kind: 'refund' }),
      rec('later', { occurred_at: '2026-09-14' }),
      rec('transfer', { kind: 'transfer' }),
      rec('blank', { merchant: '' }),
    ];
    expect(duplicatePairs([a], [a, ...others])).toEqual([]);
  });

  it('never asks again about a pair confirmed as two real records', () => {
    const a = rec('a');
    const b = rec('bb');
    const links = [{ kind: 'duplicate_confirmed', from_transaction_id: 'bb', to_transaction_id: 'a' }];
    expect(isConfirmedPair('a', 'bb', links)).toBe(true);
    expect(duplicatePairs([a, b], [a, b], links)).toEqual([]);
  });

  it('puts each record in one pair at most', () => {
    const rows = [rec('a'), rec('bb'), rec('ccc')];
    expect(duplicatePairs(rows, rows)).toHaveLength(1);
  });
});

describe('confirmedPairRow', () => {
  it('makes the same row whichever way round the pair is given', () => {
    expect(confirmedPairRow('hh', rec('bb'), rec('a'))).toEqual({ household_id: 'hh', kind: 'duplicate_confirmed', from_transaction_id: 'a', to_transaction_id: 'bb' });
  });
});
