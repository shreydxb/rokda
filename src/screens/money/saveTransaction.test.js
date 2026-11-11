import { describe, it, expect, vi, beforeEach } from 'vitest';

// The database as the editor's save sees it: each call recorded, and a plain
// insert answered as PostgREST answers one with no select, with no data.
const calls = vi.hoisted(() => ({ list: [], fail: null }));
vi.mock('../../lib/supabaseClient', () => {
  const answer = (step, data) => Promise.resolve(calls.fail === step ? { data: null, error: { message: `${step} refused` } } : { data, error: null });
  return {
    supabase: {
      rpc: (name, args) => {
        calls.list.push([name, args]);
        return answer(name, null);
      },
      from: (table) => ({
        insert: (row) => {
          calls.list.push([`insert ${table}`, row]);
          const done = answer(`insert ${table}`, null);
          done.select = () => ({ single: () => answer(`insert ${table}`, { id: 'new-1' }) });
          return done;
        },
        update: (row) => ({
          eq: (_, id) => ({
            select: () => {
              calls.list.push([`update ${table}`, row, id]);
              return answer(`update ${table}`, [{ id }]);
            },
          }),
        }),
      }),
    },
  };
});

import { saveTransaction } from './saveTransaction';

const PAYLOAD = { household_id: 'h1', account_id: 'bank', category_id: 'food', amount: -100, kind: 'expense' };
const step = (over) => ({ tx: null, householdId: 'h1', payload: PAYLOAD, lines: null, amountAed: 100, unlinkId: null, unsplit: false, linkTo: null, keptAlongside: null, edits: [], ...over });
const memory = () => ({ savedNewId: null, stepsDone: new Set() });

beforeEach(() => {
  calls.list.length = 0;
  calls.fail = null;
});

describe('saveTransaction', () => {
  it('inserts a plain new record once, reading nothing back', async () => {
    expect(await saveTransaction(step(), memory())).toEqual({});
    expect(calls.list).toEqual([['insert transactions', PAYLOAD]]);
  });

  it('saves a new split record, then its lines', async () => {
    const lines = [{ category_id: 'food', amount: 60 }, { category_id: 'fun', amount: 40 }];
    expect(await saveTransaction(step({ lines }), memory())).toEqual({});
    expect(calls.list.map((c) => c[0])).toEqual(['insert transactions', 'split_transaction']);
    expect(calls.list[1][1]).toEqual({ p_transaction_id: 'new-1', p_lines: lines, p_amount: 100 });
  });

  it('writes a retried new record to the one already saved, and links a refund only once', async () => {
    const mem = memory();
    calls.fail = 'insert transaction_links';
    const refund = step({ payload: { ...PAYLOAD, kind: 'refund', amount: 100 }, linkTo: 'purchase-1', keptAlongside: { id: 'other' } });
    expect((await saveTransaction(refund, mem)).error).toMatch(/^Saved, but "both are real" wasn't remembered/);
    expect(mem).toEqual({ savedNewId: 'new-1', stepsDone: new Set(['link']) });
    calls.list.length = 0;
    calls.fail = null;
    expect(await saveTransaction(refund, mem)).toEqual({});
    expect(calls.list.map((c) => c[0])).toEqual(['update transactions', 'insert transaction_links']);
    expect(calls.list[0][2]).toBe('new-1');
  });

  it('unlinks and unsplits first, and records the history last', async () => {
    const tx = { id: 't1' };
    const edits = [{ field: 'kind', old_value: 'Refund', new_value: 'Income' }];
    expect(await saveTransaction(step({ tx, unlinkId: 'link-1', unsplit: true, edits }), memory())).toEqual({});
    expect(calls.list.map((c) => c[0])).toEqual(['unlink_refund', 'unsplit_transaction', 'update transactions', 'insert transaction_edits']);
    expect(calls.list[1][1]).toEqual({ p_transaction_id: 't1', p_category_id: 'food' });
  });

  it('says when only the history failed, and stops at the first step that did', async () => {
    const tx = { id: 't1' };
    calls.fail = 'insert transaction_edits';
    expect(await saveTransaction(step({ tx, edits: [{ field: 'note', old_value: 'a', new_value: 'b' }] }), memory())).toEqual({ historyError: 'insert transaction_edits refused' });
    calls.list.length = 0;
    calls.fail = 'unlink_refund';
    expect(await saveTransaction(step({ tx, unlinkId: 'link-1' }), memory())).toEqual({ error: 'unlink_refund refused' });
    expect(calls.list.map((c) => c[0])).toEqual(['unlink_refund']);
  });
});
