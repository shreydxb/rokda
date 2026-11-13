import { describe, it, expect } from 'vitest';
import { readsCleanly, undatedBatches } from './inboxBatches';

const entry = (id, over = {}) => ({
  id, status: 'pending', source: 'telegram', source_ref: '500', parsed_merchant: 'Shop', parsed_amount: 10, parsed_date: '2026-10-04', date_guessed: true,
  parsed_category_id: 'c1', parsed_account_id: 'a1', parsed_currency: 'AED', confidence: 1, ...over,
});

describe('readsCleanly', () => {
  it('needs every field an approval takes, read with confidence, in AED', () => {
    expect(readsCleanly(entry('a'))).toBe(true);
    for (const gap of [{ parsed_merchant: null }, { parsed_amount: 0 }, { parsed_category_id: null }, { parsed_account_id: null }, { parsed_currency: 'INR' }, { confidence: 0.8 }]) {
      expect(readsCleanly(entry('a', gap)), JSON.stringify(gap)).toBe(false);
    }
  });
});

describe('undatedBatches', () => {
  it('groups the undated entries of one message that read cleanly otherwise', () => {
    const batches = undatedBatches([entry('a'), entry('b', { source_ref: '500#1' }), entry('c', { source_ref: '500#2' })]);
    expect(batches).toEqual([{ key: '500', sentOn: '2026-10-04', items: [expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' }), expect.objectContaining({ id: 'c' })] }]);
  });

  it('leaves out a dated entry, one missing a field, one alone in its message, and one added by hand', () => {
    const batches = undatedBatches([
      entry('a'), entry('b', { source_ref: '500#1' }),
      entry('dated', { source_ref: '500#2', date_guessed: false }),
      entry('gap', { source_ref: '500#3', parsed_account_id: null }),
      entry('alone', { source_ref: '501' }),
      entry('manual1', { source: 'manual', source_ref: null }), entry('manual2', { source: 'manual', source_ref: null }),
    ]);
    expect(batches.map((b) => [b.key, b.items.map((i) => i.id)])).toEqual([['500', ['a', 'b']]]);
  });
});
