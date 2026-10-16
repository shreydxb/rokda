import { describe, it, expect } from 'vitest';
import { refundCandidates, refundedAmount, refundedPurchase, refundLinkOf, refundsOf, sameMerchant } from './refunds';

const CARD = 'card';
const CURRENT = 'current';
const purchase = { id: 'p', account_id: CARD, amount: -200, kind: 'expense', merchant: 'Shop', occurred_at: '2026-09-20' };
const refund = { id: 'r', account_id: CARD, amount: 50, kind: 'refund', merchant: 'SHOP DUBAI', occurred_at: '2026-10-02' };

describe('sameMerchant', () => {
  it('sets case and punctuation aside, and matches one name inside the other', () => {
    expect(sameMerchant('Shop', 'SHOP DUBAI')).toBe(true);
    expect(sameMerchant('shop.com', 'Shop Com')).toBe(true);
    expect(sameMerchant('Shop', 'Cafe')).toBe(false);
    expect(sameMerchant('', 'Shop')).toBe(false);
  });
});

describe('refundCandidates', () => {
  it('offers earlier purchases from the same shop or card, the same shop first', () => {
    const others = [
      { ...purchase, id: 'card-only', merchant: 'Elsewhere', occurred_at: '2026-10-01' },
      purchase,
      { ...purchase, id: 'other-card', account_id: CURRENT, occurred_at: '2026-09-25' },
      { ...purchase, id: 'neither', account_id: CURRENT, merchant: 'Elsewhere' },
      { ...purchase, id: 'later', occurred_at: '2026-10-05' },
      { ...purchase, id: 'too-old', occurred_at: '2026-05-01' },
      { ...purchase, id: 'too-small', amount: -40 },
      { ...purchase, id: 'income', amount: 200, kind: 'income' },
      { ...purchase, id: 'transfer', kind: 'transfer' },
    ];
    expect(refundCandidates(refund, [refund, ...others]).map((t) => t.id)).toEqual(['p', 'other-card', 'card-only']);
  });

  it('leaves out a purchase already refunded in full, allowing a little over for exchange rates', () => {
    const earlier = { id: 'e', account_id: CARD, amount: 160, kind: 'refund', occurred_at: '2026-09-28' };
    const links = [{ id: 'l', kind: 'refund', from_transaction_id: 'p', to_transaction_id: 'e' }];
    expect(refundCandidates(refund, [purchase, earlier], links).map((t) => t.id)).toEqual(['p']);
    expect(refundCandidates({ ...refund, amount: 51 }, [purchase, earlier], links)).toEqual([]);
  });

  it('suggests nothing for a refund with no amount', () => {
    expect(refundCandidates({ ...refund, amount: 0 }, [purchase])).toEqual([]);
  });
});

describe('a purchase and its refunds', () => {
  const second = { ...refund, id: 'r2', amount: 25.5, occurred_at: '2026-09-30' };
  const links = [
    { id: 'l1', kind: 'refund', from_transaction_id: 'p', to_transaction_id: 'r' },
    { id: 'l2', kind: 'refund', from_transaction_id: 'p', to_transaction_id: 'r2' },
    { id: 't', kind: 'transfer', from_transaction_id: 'x', to_transaction_id: 'r3' },
  ];
  const all = [purchase, refund, second];

  it('finds each from the other', () => {
    expect(refundLinkOf('r', links).id).toBe('l1');
    expect(refundLinkOf('r3', links)).toBeNull();
    expect(refundedPurchase(refund, links, all)).toBe(purchase);
    expect(refundsOf('p', links, all).map((t) => t.id)).toEqual(['r2', 'r']);
    expect(refundedAmount('p', links, all)).toBe(75.5);
  });
});
