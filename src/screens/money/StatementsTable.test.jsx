import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, fireEvent } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderScreen } from '../../test/renderScreen';
import { statementRows } from '../../lib/statements';

// The table's writes: marking statements done, one or several, resolving a
// mismatch and reopening one. The client is mocked so the test sees exactly
// what is sent; `updated` is the rows an update reports it changed, and
// `insertError` what an insert answers.
const calls = [];
let updated = [{ id: 'r' }];
let insertError = null;
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from(table) {
      return {
        insert: (row) => {
          calls.push({ op: 'insert', table, row });
          return Promise.resolve({ error: insertError });
        },
        update: (payload) => ({
          eq: (col, value) => {
            const call = { op: 'update', table, col, value, payload };
            calls.push(call);
            const select = () => Promise.resolve({ data: updated, error: null });
            return {
              eq: (guardCol, guardValue) => {
                call.guard = [guardCol, guardValue];
                return { select };
              },
              select,
            };
          },
        }),
      };
    },
  },
}));

const { default: StatementsTable, MarkTicked } = await import('./StatementsTable');
const { useStatementActions } = await import('./useStatementActions');

const ME = { id: 'm1', display_name: 'Alex' };
const CARD = { id: 'card-1', name: 'Bank card', type: 'credit_card', statement_day: 28, due_day: 22, archived_at: null, is_shared: true };
const OTHER = { id: 'card-2', name: 'Travel card', type: 'credit_card', statement_day: 28, archived_at: null, is_shared: false, owner_member_id: 'm1' };

function Host({ accounts, rows, reload }) {
  const actions = useStatementActions({ household: { id: 'h1' }, me: ME, reload });
  return (
    <>
      <MarkTicked rows={rows} actions={actions} />
      <StatementsTable rows={rows} accounts={accounts} members={[ME]} actions={actions} />
    </>
  );
}

function renderTable({ reconciliations = [], transactions = [], accounts = [CARD] } = {}) {
  const reload = vi.fn().mockResolvedValue(undefined);
  const rows = statementRows({ accounts, reconciliations, transactions, perCard: 2 });
  renderScreen(
    <MemoryRouter>
      <Host accounts={accounts} rows={rows} reload={reload} />
    </MemoryRouter>,
  );
  return { reload };
}

const rowOf = (period) => screen.getByText(period).closest('tr');
async function click(el) {
  await act(async () => {
    fireEvent.click(el);
  });
}

describe('Card statements table', () => {
  beforeEach(() => {
    calls.length = 0;
    updated = [{ id: 'r' }];
    insertError = null;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T10:00:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists the statements still to check under their card, with what Rokda recorded, and folds the done ones', () => {
    renderTable({
      reconciliations: [{ id: 'r1', account_id: 'card-1', statement_date: '2026-08-28', period_start: '2026-07-29', due_date: '2026-09-22', status: 'reconciled', statement_spend: 100 }],
      transactions: [
        { id: 't1', account_id: 'card-1', amount: -40, kind: 'expense', occurred_at: '2026-09-10', is_shared: true },
        { id: 't2', account_id: 'card-1', amount: -100, kind: 'expense', occurred_at: '2026-08-10', is_shared: true },
      ],
    });
    // The card heads both the statements to check and the ones done, and
    // opens Accounts for the household, whoever is selected.
    const cardLinks = screen.getAllByRole('link', { name: 'Bank card →' });
    expect(cardLinks).toHaveLength(2);
    expect(cardLinks[0].getAttribute('href')).toBe('/wealth?tab=accounts&who=both');
    expect(screen.getAllByText('· closes 28th · due 22nd')).toHaveLength(2);
    const september = rowOf('29 Aug – 28 Sep');
    expect(within(september).getByText('22 Oct')).toBeTruthy();
    expect(within(september).getByText('AED 40.00')).toBeTruthy();
    // No statement total is typed in the app (the design note's decision 2).
    expect(within(september).getByText('—')).toBeTruthy();
    expect(within(september).queryByRole('textbox')).toBeNull();
    expect(within(september).getByText('To check')).toBeTruthy();
    const fold = screen.getByText('Done (1)').closest('details');
    const august = rowOf('29 Jul – 28 Aug');
    expect(fold.contains(august)).toBe(true);
    expect(fold.contains(september)).toBe(false);
    expect(within(august).getByText('Reconciled')).toBeTruthy();
    expect(within(august).getByText('Matches')).toBeTruthy();
    expect(within(august).queryByRole('button', { name: 'Mark done' })).toBeNull();
  });

  it('marks a statement nobody has checked done by recording it', async () => {
    const { reload } = renderTable();
    await click(within(rowOf('29 Aug – 28 Sep')).getByRole('button', { name: 'Mark done' }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      op: 'insert',
      table: 'statement_reconciliations',
      row: { household_id: 'h1', account_id: 'card-1', statement_date: '2026-09-28', period_start: '2026-08-29', due_date: '2026-10-22', status: 'confirmed', closed_by_member_id: 'm1' },
    });
    expect(calls[0].row.closed_at).toBeTruthy();
    expect(reload).toHaveBeenCalled();
  });

  it('marks a statement the bot is asking about done by updating its record', async () => {
    renderTable({ reconciliations: [{ id: 'r9', account_id: 'card-1', statement_date: '2026-09-28', period_start: '2026-08-29', due_date: '2026-10-22', status: 'waiting' }] });
    const row = rowOf('29 Aug – 28 Sep');
    expect(within(row).getByText('Waiting')).toBeTruthy();
    await click(within(row).getByRole('button', { name: 'Mark done' }));
    expect(calls).toEqual([expect.objectContaining({ op: 'update', table: 'statement_reconciliations', col: 'id', value: 'r9' })]);
    expect(calls[0].payload.status).toBe('confirmed');
    // Only while it is still waiting: the bot may have recorded a mismatch
    // since the page was read (the fresh review of 4d).
    expect(calls[0].guard).toEqual(['status', 'waiting']);
  });

  it("keeps the sign and the cents: a net refund is negative, and a cent's difference shows", () => {
    renderTable({
      reconciliations: [{ id: 'r2', account_id: 'card-1', statement_date: '2026-08-28', period_start: '2026-07-29', status: 'mismatch', statement_spend: 100.02 }],
      transactions: [
        { id: 't1', account_id: 'card-1', amount: 50.49, kind: 'refund', occurred_at: '2026-09-10', is_shared: true },
        { id: 't2', account_id: 'card-1', amount: -100.01, kind: 'expense', occurred_at: '2026-08-10', is_shared: true },
      ],
    });
    expect(within(rowOf('29 Aug – 28 Sep')).getByText('AED −50.49')).toBeTruthy();
    const august = rowOf('29 Jul – 28 Aug');
    expect(within(august).getByText('AED 100.01')).toBeTruthy();
    expect(within(august).getByText('AED 100.02')).toBeTruthy();
    expect(within(august).getByText('AED 0.01 lower in Rokda')).toBeTruthy();
    expect(within(august).getByText('Doesn’t match')).toBeTruthy();
  });

  it('resolves a mismatch with who did it and what was done', async () => {
    const { reload } = renderTable({
      reconciliations: [{ id: 'r4', account_id: 'card-1', statement_date: '2026-09-28', period_start: '2026-08-29', status: 'mismatch', statement_spend: 10 }],
    });
    const row = rowOf('29 Aug – 28 Sep');
    expect(within(row).queryByRole('button', { name: 'Mark done' })).toBeNull();
    await click(within(row).getByRole('button', { name: 'Resolve…' }));
    const input = screen.getByRole('textbox', { name: 'What was done about the difference' });
    fireEvent.change(input, { target: { value: 'Added a missing fuel charge' } });
    await click(screen.getByRole('button', { name: 'Mark resolved' }));
    expect(calls).toEqual([expect.objectContaining({ op: 'update', col: 'id', value: 'r4' })]);
    expect(calls[0].payload).toMatchObject({ status: 'confirmed', closed_by_member_id: 'm1', note: 'Added a missing fuel charge' });
    expect(calls[0].guard).toEqual(['status', 'mismatch']);
    expect(reload).toHaveBeenCalled();
  });

  it('reopens a statement marked done by mistake', async () => {
    renderTable({
      reconciliations: [{ id: 'r5', account_id: 'card-1', statement_date: '2026-09-28', period_start: '2026-08-29', status: 'confirmed', closed_at: '2026-10-01T09:00:00Z', closed_by_member_id: 'm1' }],
    });
    await click(within(rowOf('29 Aug – 28 Sep')).getByRole('button', { name: 'Reopen…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Why it is being reopened' }), { target: { value: 'A charge came later' } });
    await click(screen.getByRole('button', { name: 'Reopen' }));
    expect(calls[0].payload).toMatchObject({ status: 'waiting', closed_at: null, closed_by_member_id: null, note: 'A charge came later' });
    expect(calls[0].guard).toEqual(['status', 'confirmed']);
  });

  it('says so when a write changed nothing, rather than reloading as if it had', async () => {
    updated = [];
    const { reload } = renderTable({ reconciliations: [{ id: 'r6', account_id: 'card-1', statement_date: '2026-09-28', period_start: '2026-08-29', status: 'waiting' }] });
    await click(within(rowOf('29 Aug – 28 Sep')).getByRole('button', { name: 'Mark done' }));
    expect(screen.getByRole('alert').textContent).toMatch(/Nothing was saved/);
    expect(reload).not.toHaveBeenCalled();
  });

  it('opens a statement to its transactions, its closing balance and who checked it', async () => {
    renderTable({
      reconciliations: [
        { id: 'r3', account_id: 'card-1', statement_date: '2026-09-28', period_start: '2026-08-29', status: 'waiting', statement_balance: 1234.5 },
        { id: 'r7', account_id: 'card-1', statement_date: '2026-08-28', period_start: '2026-07-29', status: 'confirmed', closed_at: '2026-09-01T09:00:00Z', closed_by_member_id: 'm1', note: 'Checked against the paper copy' },
      ],
      transactions: [
        { id: 't1', account_id: 'card-1', amount: -40, kind: 'expense', occurred_at: '2026-09-10', is_shared: true, merchant: 'Shop' },
        { id: 't2', account_id: 'card-1', amount: 15, kind: 'refund', occurred_at: '2026-09-12', is_shared: true, merchant: 'Shop' },
      ],
    });
    const open = within(rowOf('29 Aug – 28 Sep')).getByRole('button', { name: '29 Aug – 28 Sep' });
    expect(open.getAttribute('aria-expanded')).toBe('false');
    await click(open);
    expect(open.getAttribute('aria-expanded')).toBe('true');
    const detail = screen.getByRole('region', { name: 'Bank card, 29 Aug to 28 Sep' });
    expect(within(detail).getByText('10 Sep · Shop')).toBeTruthy();
    expect(within(detail).getByText('AED 40.00')).toBeTruthy();
    expect(within(detail).getByText('12 Sep · Shop (refund)')).toBeTruthy();
    expect(within(detail).getByText('AED −15.00')).toBeTruthy();
    expect(within(detail).getByText('Closing balance on the statement: AED 1,234.50')).toBeTruthy();
    await click(within(rowOf('29 Jul – 28 Aug')).getByRole('button', { name: '29 Jul – 28 Aug' }));
    const done = screen.getByRole('region', { name: 'Bank card, 29 Jul to 28 Aug' });
    expect(within(done).getByText('Done by Alex on 1 Sep')).toBeTruthy();
    expect(within(done).getByText('Checked against the paper copy')).toBeTruthy();
    expect(within(done).getByText('No transactions on the card in this period.')).toBeTruthy();
  });

  it('ticks several statements and marks them done at once, but not one that doesn’t match', async () => {
    const { reload } = renderTable({
      accounts: [CARD, OTHER],
      reconciliations: [{ id: 'r8', account_id: 'card-1', statement_date: '2026-08-28', period_start: '2026-07-29', status: 'mismatch', statement_spend: 5 }],
    });
    expect(screen.queryByRole('button', { name: /^Mark \d+ done$/ })).toBeNull();
    // A mismatch is resolved with what was done, one at a time.
    expect(within(screen.getByText('Doesn’t match').closest('tr')).queryByRole('checkbox')).toBeNull();
    const ticks = screen.getAllByRole('checkbox', { name: /^Select / });
    expect(ticks.map((t) => t.getAttribute('aria-label'))).toEqual(['Select Bank card, 29 Aug to 28 Sep', 'Select Travel card, 29 Aug to 28 Sep', 'Select Travel card, 29 Jul to 28 Aug']);
    await click(ticks[0]);
    await click(ticks[1]);
    await click(screen.getByRole('button', { name: 'Mark 2 done' }));
    expect(calls.map((c) => [c.op, c.row.account_id, c.row.statement_date, c.row.status])).toEqual([
      ['insert', 'card-1', '2026-09-28', 'confirmed'],
      ['insert', 'card-2', '2026-09-28', 'confirmed'],
    ]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /^Mark \d+ done$/ })).toBeNull();
  });

  it('says which statements could not be marked, and still shows the ones that were', async () => {
    insertError = { message: 'permission denied' };
    const { reload } = renderTable({ accounts: [CARD, OTHER], reconciliations: [{ id: 'r10', account_id: 'card-2', statement_date: '2026-09-28', period_start: '2026-08-29', status: 'waiting' }] });
    const ticks = screen.getAllByRole('checkbox', { name: /^Select .*28 Sep$/ });
    await click(ticks[0]);
    await click(ticks[1]);
    await click(screen.getByRole('button', { name: 'Mark 2 done' }));
    expect(screen.getByRole('alert').textContent).toBe('Bank card, 29 Aug to 28 Sep: permission denied');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Mark 1 done' })).toBeTruthy();
  });

  it('says when every statement here has been checked', () => {
    renderTable({
      reconciliations: [
        { id: 'a', account_id: 'card-1', statement_date: '2026-09-28', period_start: '2026-08-29', status: 'confirmed' },
        { id: 'b', account_id: 'card-1', statement_date: '2026-08-28', period_start: '2026-07-29', status: 'confirmed' },
      ],
    });
    expect(screen.getByText('Every statement here has been checked.')).toBeTruthy();
    expect(screen.getByText('Done (2)')).toBeTruthy();
  });
});
