import { describe, expect, it } from 'vitest';
import { historyEvents, relatedRecords, transferEdits } from './editHistory';

const MEMBERS = [
  { id: 'm1', display_name: 'Partner A' },
  { id: 'm2', display_name: 'Partner B' },
];
const purchase = { id: 'p', kind: 'expense', amount: -200, merchant: 'Corner Shop', occurred_at: '2026-10-03' };
const refund = { id: 'r', kind: 'refund', amount: 50, merchant: 'Corner Shop', occurred_at: '2026-10-12' };
const links = [{ kind: 'refund', from_transaction_id: 'p', to_transaction_id: 'r' }];
const edit = (id, transaction_id, field, old_value, new_value, edited_at, edited_by = 'm1') => ({ id, transaction_id, field, old_value, new_value, edited_at, edited_by });

describe('relatedRecords: a record and the ones linked to it', () => {
  it('gives a purchase its refunds', () => {
    expect(relatedRecords(purchase, links, [purchase, refund])).toEqual([
      { id: 'p', label: 'This purchase' },
      { id: 'r', label: 'Refund · +50 · 12 Oct' },
    ]);
  });

  it('gives a refund its purchase', () => {
    expect(relatedRecords(refund, links, [purchase, refund])).toEqual([
      { id: 'r', label: 'This refund' },
      { id: 'p', label: 'The purchase · Corner Shop · 3 Oct' },
    ]);
  });

  it('is the record alone when nothing is linked', () => {
    expect(relatedRecords(purchase, [], [purchase])).toEqual([{ id: 'p', label: 'This purchase' }]);
    expect(relatedRecords(null)).toEqual([]);
  });
});

describe('historyEvents: one timeline, grouped by save', () => {
  const records = relatedRecords(purchase, links, [purchase, refund]);

  it('puts a purchase\'s change and the refund that followed it in one save, the record\'s own line first', () => {
    const edits = [
      edit('e2', 'r', 'category', 'Groceries', 'Dining out (follows the purchase it refunds)', '2026-10-15T10:00:01Z'),
      edit('e1', 'p', 'category', 'Groceries', 'Dining out', '2026-10-15T10:00:00Z'),
    ];
    const [save] = historyEvents(edits, records, MEMBERS);
    expect(save.who).toBe('Partner A');
    expect(save.lines.map((l) => `${l.record}: ${l.field} ${l.from} → ${l.to}`)).toEqual([
      'This purchase: Category Groceries → Dining out',
      'Refund · +50 · 12 Oct: Category Groceries → Dining out (follows the purchase it refunds)',
    ]);
  });

  it('keeps separate saves apart, newest first: a later save, or another person', () => {
    const edits = [
      edit('e1', 'p', 'amount', '−200', '−210', '2026-10-15T10:00:00Z'),
      edit('e2', 'p', 'merchant', 'Corner Shop', 'Corner Shop Ltd', '2026-10-15T10:05:00Z'),
      edit('e3', 'p', 'scope', 'Shared', 'Partner B', '2026-10-15T10:05:10Z', 'm2'),
    ];
    expect(historyEvents(edits, records, MEMBERS).map((e) => `${e.who}: ${e.lines.map((l) => l.field).join(', ')}`)).toEqual([
      'Partner B: Scope',
      'Partner A: Merchant',
      'Partner A: Amount',
    ]);
  });

  it('says who made each change, or that it was automatic', () => {
    const edits = [edit('e1', 'p', 'native_amount', 'AED only', 'USD 54.45', '2026-10-15T10:00:00Z', null), edit('e2', 'p', 'category', 'A', 'B', '2026-10-16T10:00:00Z', 'gone')];
    expect(historyEvents(edits, records, MEMBERS).map((e) => e.who)).toEqual(['A former member', 'Automatic']);
  });

  it('leaves the record unnamed when there is only the one', () => {
    const [save] = historyEvents([edit('e1', 'p', 'date', '3 Oct 2026', '4 Oct 2026', '2026-10-15T10:00:00Z')], [{ id: 'p', label: 'This purchase' }], MEMBERS);
    expect(save.lines[0]).toMatchObject({ record: null, field: 'Date', from: '3 Oct 2026', to: '4 Oct 2026' });
  });
});

describe('transferEdits: both sides of a changed transfer', () => {
  const transfer = { out: { id: 'o', amount: -300, occurred_at: '2026-10-10' }, in: { id: 'i', amount: 300, occurred_at: '2026-10-10' } };

  it('records the amount on both sides, money out negative', () => {
    expect(transferEdits(transfer, 320, '2026-10-10')).toEqual([
      { transaction_id: 'o', field: 'amount', old_value: '−300', new_value: '−320' },
      { transaction_id: 'i', field: 'amount', old_value: '+300', new_value: '+320' },
    ]);
  });

  it('records a new date on both sides, and nothing when nothing changed', () => {
    expect(transferEdits(transfer, 300, '2026-10-11').map((r) => `${r.transaction_id} ${r.field} ${r.old_value} → ${r.new_value}`)).toEqual([
      'o date 10 Oct 2026 → 11 Oct 2026',
      'i date 10 Oct 2026 → 11 Oct 2026',
    ]);
    expect(transferEdits(transfer, 300, '2026-10-10')).toEqual([]);
  });
});
