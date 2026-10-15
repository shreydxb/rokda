import { describe, it, expect } from 'vitest';
import { ATTENTION_PREVIEW_COUNT, attentionPreview, buildAttentionItems, sortAttention } from './attention';

const item = (id, severity) => ({ id, severity });

describe('sortAttention', () => {
  it('puts urgent before warn before info, keeping the built order among equals', () => {
    const items = [item('i1', 'info'), item('w1', 'warn'), item('u1', 'urgent'), item('i2', 'info'), item('w2', 'warn')];
    expect(sortAttention(items).map((i) => i.id)).toEqual(['u1', 'w1', 'w2', 'i1', 'i2']);
  });

  it('puts an unknown severity last and leaves the input alone', () => {
    const items = [item('x', undefined), item('i', 'info')];
    expect(sortAttention(items).map((i) => i.id)).toEqual(['i', 'x']);
    expect(items.map((i) => i.id)).toEqual(['x', 'i']);
  });
});

describe('attentionPreview', () => {
  const items = Array.from({ length: 7 }, (_, n) => item(`i${n}`, n === 6 ? 'urgent' : 'info'));

  it('shows the first few, most pressing first, and counts the rest', () => {
    const { shown, hidden } = attentionPreview(items);
    expect(shown).toHaveLength(ATTENTION_PREVIEW_COUNT);
    expect(shown[0].id).toBe('i6');
    expect(hidden).toBe(7 - ATTENTION_PREVIEW_COUNT);
  });

  it('shows everything when expanded, or when there are only a few', () => {
    expect(attentionPreview(items, true)).toMatchObject({ hidden: 0 });
    expect(attentionPreview(items, true).shown).toHaveLength(7);
    expect(attentionPreview(items.slice(0, 3))).toMatchObject({ hidden: 0 });
    expect(attentionPreview([])).toEqual({ shown: [], hidden: 0 });
  });
});

describe('an autopay bill not yet confirmed', () => {
  const now = new Date(2026, 9, 8, 12);
  const base = { id: 'r1', name: 'Car EMI', amount: -2000, cadence: 'monthly', interval_count: 1, next_due_date: '2026-10-03', active: true, is_shared: true, account_id: 'a1' };

  it('asks for the confirmation rather than calling the bill missing', () => {
    const [autopay] = buildAttentionItems({ transactions: [], recurring: [{ ...base, autopay: true }], accounts: [], holdings: [], categories: [], scopeMemberId: null, now });
    expect(autopay.title).toBe('Car EMI: debit not confirmed yet');
    expect(autopay.detail).toMatch(/Telegram/);
    const [manual] = buildAttentionItems({ transactions: [], recurring: [{ ...base, autopay: false }], accounts: [], holdings: [], categories: [], scopeMemberId: null, now });
    expect(manual.title).toBe("Car EMI hasn't posted");
  });
});

describe('a month that has not been closed', () => {
  const base = { transactions: [], recurring: [], holdings: [], categories: [], scopeMemberId: null, now: new Date('2026-10-15T10:00:00') };
  const account = { id: 'a1', name: 'Bank', archived_at: null, is_shared: true, balance: 100, balance_as_of: '2026-10-14T00:00:00Z' };
  const closeItems = (over) => buildAttentionItems({ ...base, accounts: [account], ...over }).filter((i) => i.kind === 'month_close');

  it('asks for the month that just ended until it is closed', () => {
    const [item] = closeItems({ snapshots: [] });
    expect(item).toMatchObject({ id: 'month-close-2026-09', severity: 'warn', title: "September 2026 hasn't been closed" });
    expect(item.detail).toContain('Wealth → Net Worth');
  });

  it('says nothing once that month has a snapshot, whatever came before', () => {
    expect(closeItems({ snapshots: [{ snapshot_date: '2026-09-01' }] })).toEqual([]);
  });

  it('asks again for the newest month even when older ones are closed', () => {
    expect(closeItems({ snapshots: [{ snapshot_date: '2026-08-01' }] })).toHaveLength(1);
  });

  it('says nothing to a household with no open accounts', () => {
    expect(buildAttentionItems({ ...base, accounts: [{ ...account, archived_at: '2026-01-01' }], snapshots: [] }).filter((i) => i.kind === 'month_close')).toEqual([]);
  });
});
