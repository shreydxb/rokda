import { describe, it, expect } from 'vitest';
import { buildAttentionItems } from './attention';

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
    expect(item).toMatchObject({ id: 'month-close-2026-09', severity: 'warn', title: "September 2026 hasn't been closed", month: '2026-09' });
    expect(item.detail).toContain('Money → Month end');
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

describe('a backup that is late or failed', () => {
  const base = { transactions: [], recurring: [], holdings: [], categories: [], scopeMemberId: null, now: new Date('2026-10-15T10:00:00') };
  const account = { id: 'a1', name: 'Bank', archived_at: null, is_shared: true, balance: 100, balance_as_of: '2026-10-14T00:00:00Z' };
  const backupItems = (backupRecords, accounts = [account]) => buildAttentionItems({ ...base, accounts, backupRecords }).filter((i) => i.kind === 'backup');
  const rec = (result, done_on) => ({ kind: 'export', result, done_on, created_at: `${done_on}T12:00:00Z` });

  it('asks for one when none is recorded', () => {
    expect(backupItems([])).toEqual([expect.objectContaining({ id: 'backup-due', severity: 'warn', title: 'No backup has been recorded' })]);
  });

  it('says nothing while the last export is recent', () => {
    expect(backupItems([rec('passed', '2026-10-01')])).toEqual([]);
  });

  it('says how old the last one is once it is late', () => {
    const [item] = backupItems([rec('passed', '2026-08-01')]);
    expect(item.title).toBe('The last backup is 75 days old');
    expect(item.detail).toContain('1 Aug 2026');
  });

  it('says when the newest export failed, even with a recent pass before it', () => {
    const [item] = backupItems([rec('passed', '2026-10-01'), rec('failed', '2026-10-10')]);
    expect(item).toMatchObject({ id: 'backup-failed', title: 'The last backup export failed' });
    expect(item.detail).toContain('The last one that passed was on 1 Oct 2026.');
  });

  it('says nothing to a household with no open accounts', () => {
    expect(backupItems([], [])).toEqual([]);
  });
});

// A holding sold down to nothing keeps its last price, which the feed no
// longer refreshes: asking to update it would never stop (the fresh review of
// 5b, now that the item opens the holding itself).
describe('stale holdings', () => {
  const now = new Date('2026-10-15T10:00:00');
  const old = '2026-08-01T00:00:00Z';
  const base = { transactions: [], recurring: [], accounts: [], categories: [], scopeMemberId: null, now };
  const staleNames = (holdings) => buildAttentionItems({ ...base, holdings }).filter((i) => i.kind === 'stale_holding').map((i) => i.name);

  it('asks for a price on a holding still held, never on one sold out', () => {
    const held = { id: 'h1', name: 'Held fund', value_aed: 1000, is_shared: true, priced_at: old, trades_version: 2, quantity: 5 };
    const sold = { ...held, id: 'h2', name: 'Sold fund', quantity: 0, value_aed: 0 };
    expect(staleNames([held, sold])).toEqual(['Held fund']);
  });
});

// A note checked once a year asks here when it is due (Planning audit, 4.18).
describe('a yearly check that is due', () => {
  it('is listed with the rest, after anything more pressing', () => {
    const items = buildAttentionItems({
      transactions: [],
      recurring: [],
      accounts: [],
      holdings: [],
      categories: [],
      yearlyChecks: [{ id: 'n1', title: 'Protection', check_yearly: true, checked_on: null }],
      scopeMemberId: null,
      now: new Date('2026-10-15T10:00:00'),
    });
    expect(items).toEqual([expect.objectContaining({ id: 'yearly-check-n1', kind: 'yearly_check', severity: 'info', title: 'Yearly check: Protection' })]);
  });
});

// The revamp (Overview's To do, phase 3): each item also carries a short
// name and status, and what it is about, so To do can show it in one line
// with a button that does the job. The sentences above are unchanged.
describe('attention items: short forms for To do', () => {
  const now = new Date('2026-10-15T10:00:00');
  const base = { transactions: [], recurring: [], holdings: [], categories: [], scopeMemberId: null, now };
  const bill = { id: 'r1', name: 'Car loan', amount: -2000, cadence: 'monthly', interval_count: 1, next_due_date: '2026-10-08', active: true, is_shared: true, account_id: 'a1' };

  it('names a bill and says whether it is late or only not confirmed', () => {
    const [manual] = buildAttentionItems({ ...base, accounts: [], recurring: [{ ...bill, autopay: false }] });
    expect(manual).toMatchObject({ name: 'Car loan', status: 'Late · was due 8 Oct', recurringId: 'r1', late: true });
    const [autopay] = buildAttentionItems({ ...base, accounts: [], recurring: [{ ...bill, autopay: true }] });
    expect(autopay).toMatchObject({ name: 'Car loan', status: 'Autopay not confirmed · due 8 Oct', recurringId: 'r1', late: false });
  });

  it('names an account with no confirmed balance', () => {
    const [item] = buildAttentionItems({ ...base, accounts: [{ id: 'a9', name: 'Cash wallet', type: 'cash', archived_at: null, is_shared: true, balance: null, balance_as_of: null }] }).filter((i) => i.kind === 'balance_unset');
    expect(item).toMatchObject({ name: 'Cash wallet', status: 'Balance not confirmed', accountId: 'a9' });
  });

  it('names a backup that is due', () => {
    const [item] = buildAttentionItems({ ...base, accounts: [{ id: 'a1', name: 'Bank', archived_at: null, is_shared: true, balance: 1, balance_as_of: '2026-10-14T00:00:00Z' }], backupRecords: [] }).filter((i) => i.kind === 'backup');
    expect(item).toMatchObject({ name: 'Backup', status: 'None recorded' });
  });

  it('names a month not closed', () => {
    const [item] = buildAttentionItems({ ...base, accounts: [{ id: 'a1', name: 'Bank', archived_at: null, is_shared: true, balance: 1, balance_as_of: '2026-10-14T00:00:00Z' }], snapshots: [] }).filter((i) => i.kind === 'month_close');
    expect(item).toMatchObject({ name: 'September', status: 'Not closed' });
  });
});

// The fresh review of the cockpit: Mark paid was dated today, but a payment
// settles a bill only near its due date, so a bill more than a few days late
// stayed "Late" after it was marked paid. The item carries the date it was
// due, and a payment on that date clears it.
describe('a late bill carries the date it was due', () => {
  const now = new Date('2026-10-20T10:00:00');
  const account = { id: 'a1', name: 'Bank', type: 'checking', archived_at: null, is_shared: true, balance: 100, balance_as_of: '2026-10-19T00:00:00Z' };
  const bill = { id: 'r1', name: 'Gym', amount: -250, cadence: 'monthly', interval_count: 1, next_due_date: '2026-10-05', active: true, autopay: false, is_shared: true, account_id: 'a1', category_id: 'c1' };
  const build = (transactions) => buildAttentionItems({ transactions, recurring: [bill], accounts: [account], holdings: [], categories: [], scopeMemberId: null, now }).filter((i) => i.kind === 'missing_recurring');

  it('says when it was due, and whether it is pay', () => {
    const [item] = build([]);
    expect(item).toMatchObject({ dueOn: '2026-10-05', income: false });
  });

  it('is cleared by a payment filled from the bill on that date', async () => {
    const { billPaymentInitial } = await import('./transactionForm');
    const [item] = build([]);
    const init = billPaymentInitial(bill, [account], item.dueOn);
    const paid = { id: 'p1', kind: init.type, amount: -Number(init.amount), occurred_at: init.occurred_at, account_id: init.account_id, category_id: init.category_id, is_shared: true };
    expect(build([paid])).toEqual([]);
  });
});

// The fresh review of the cockpit: a category running high is shown under
// What changed, so the item carries its figures, not only its sentence.
describe('a category running high carries its figures', () => {
  it('says what was spent so far and what the usual month would have reached by now', () => {
    const now = new Date('2026-10-15T10:00:00');
    const tx = (id, occurred_at, amount) => ({ id, occurred_at, amount, kind: 'expense', category_id: 'g', is_shared: true });
    const transactions = [tx('a', '2026-07-10', -300), tx('b', '2026-08-10', -300), tx('c', '2026-09-10', -300), tx('d', '2026-10-05', -400)];
    const [item] = buildAttentionItems({ transactions, recurring: [], accounts: [], holdings: [], categories: [{ id: 'g', name: 'Groceries' }], scopeMemberId: null, now }).filter((i) => i.kind === 'category_anomaly');
    expect(item).toMatchObject({ categoryId: 'g', name: 'Groceries', actual: 400, average: 300 });
    expect(item.expectedSoFar).toBeCloseTo(300 * (15 / 31), 0);
  });
});
