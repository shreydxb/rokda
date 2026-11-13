import { describe, it, expect } from 'vitest';
import { alreadyRecordedAll } from './alreadyRecorded';

// An undated bank SMS is dated the day it was pasted. Pasted again a week
// later, a copy of one already recorded used to pass the 3-day duplicate check
// unseen (the feature review, November 2026).
const entry = (over = {}) => ({ id: 'e1', source_ref: '500', parsed_account_id: 'card', parsed_amount: 20, parsed_merchant: 'CITY TAXI', parsed_kind: 'expense', parsed_date: '2026-10-04', date_guessed: true, ...over });
const tx = (over = {}) => ({ id: 't1', account_id: 'card', amount: -20, kind: 'expense', merchant: 'CITY TAXI, DUBAI', occurred_at: '2026-09-27', ...over });
const one = (item, transactions, intake = []) => alreadyRecordedAll([item], transactions, intake).get(item.id) ?? null;

describe('alreadyRecordedAll', () => {
  it('finds a record on the same card, for the same amount, in the two weeks up to the paste, by the same merchant', () => {
    expect(one(entry(), [tx()])).toEqual(tx());
  });

  it('reads the merchant past what banks add to it', () => {
    expect(one(entry({ parsed_merchant: 'FUEL STATION NO.12' }), [tx({ merchant: 'FUEL STATION NO.12, DUBAI' })])).not.toBeNull();
    expect(one(entry({ parsed_merchant: 'PHONE CO ONE-TIME PAY' }), [tx({ merchant: 'PHONE CO Wifi ONE-TIME PAY' })])).not.toBeNull();
    expect(one(entry({ parsed_merchant: 'Shop' }), [tx({ merchant: 'SHOP DUBAI ARE' })])).not.toBeNull();
  });

  it('takes the latest when more than one fits', () => {
    expect(one(entry(), [tx(), tx({ id: 't2', occurred_at: '2026-10-01' })]).id).toBe('t2');
  });

  // The fresh review of this change: each could reject a real purchase.
  it('lets one record answer for one entry only', () => {
    const found = alreadyRecordedAll([entry({ id: 'a' }), entry({ id: 'b', source_ref: '501' })], [tx()]);
    expect([...found.keys()]).toEqual(['a']);
    const two = alreadyRecordedAll([entry({ id: 'a' }), entry({ id: 'b', source_ref: '501' })], [tx(), tx({ id: 't2', occurred_at: '2026-09-30' })]);
    expect([two.get('a').id, two.get('b').id].sort()).toEqual(['t1', 't2']);
  });

  it('never matches a record made from another entry of the same message', () => {
    const sibling = { id: 'e0', source_ref: '500#1', status: 'approved', transaction_id: 't1' };
    expect(one(entry(), [tx()], [sibling])).toBeNull();
    expect(one(entry(), [tx()], [{ ...sibling, source_ref: '499' }])).not.toBeNull();
  });

  it('matches an expense only with an expense, and a refund only with a refund', () => {
    expect(one(entry({ parsed_kind: 'refund' }), [tx()])).toBeNull();
    expect(one(entry(), [tx({ amount: 20, kind: 'refund' })])).toBeNull();
    expect(one(entry({ parsed_kind: 'refund' }), [tx({ amount: 20, kind: 'refund' })])).not.toBeNull();
  });

  it('needs the same card, the same amount to the fils, and the same merchant', () => {
    expect(one(entry(), [tx({ account_id: 'other' })])).toBeNull();
    expect(one(entry(), [tx({ amount: -20.01 })])).toBeNull();
    expect(one(entry(), [tx({ merchant: 'METRO CAB' })])).toBeNull();
  });

  it('does not take two shops for one by a word they share at the start', () => {
    expect(one(entry({ parsed_merchant: 'AL NOOR STORES' }), [tx({ merchant: 'AL BADR BAKERY' })])).toBeNull();
    expect(one(entry({ parsed_merchant: 'DUBAI TAXI' }), [tx({ merchant: 'DUBAI DUTY FREE' })])).toBeNull();
    expect(one(entry({ parsed_merchant: 'SUMUP *CORNER CAFE' }), [tx({ merchant: 'SUMUP *BOOK SHOP' })])).toBeNull();
    expect(one(entry({ parsed_merchant: 'AL NOOR STORES' }), [tx({ merchant: 'AL NOOR STORES LLC' })])).not.toBeNull();
  });

  it('looks only in the 14 days up to the day it was pasted', () => {
    expect(one(entry(), [tx({ occurred_at: '2026-09-20' })])).not.toBeNull();
    expect(one(entry(), [tx({ occurred_at: '2026-09-19' })])).toBeNull();
    expect(one(entry(), [tx({ occurred_at: '2026-10-05' })])).toBeNull();
  });

  it('asks nothing of an entry whose date was in its message', () => {
    expect(one(entry({ date_guessed: false }), [tx()])).toBeNull();
    expect(one(entry({ parsed_account_id: null }), [tx()])).toBeNull();
  });
});
