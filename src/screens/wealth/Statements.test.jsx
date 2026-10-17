import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/dom';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderScreen as renderBare } from '../../test/renderScreen';

// The screen reads its month from the address, so it renders inside a router.
const renderScreen = (ui) => renderBare(<MemoryRouter>{ui}</MemoryRouter>);

// The screen's writes: marking a statement done, resolving a mismatch and
// reopening one. The client is mocked so the test can see exactly what it
// sends; `updated` is the rows an update reports it changed.
const calls = [];
let updated = [{ id: 'r' }];
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from(table) {
      return {
        insert: (row) => {
          calls.push({ op: 'insert', table, row });
          return Promise.resolve({ error: null });
        },
        update: (payload) => ({
          eq: (col, value) => {
            calls.push({ op: 'update', table, col, value, payload });
            return { select: () => Promise.resolve({ data: updated, error: null }) };
          },
        }),
      };
    },
  },
}));

const { default: Statements } = await import('./Statements');

const ME = { id: 'm1', display_name: 'Alex' };
const CARD = { id: 'card-1', name: 'Bank card', type: 'credit_card', statement_day: 28, due_day: 22, archived_at: null, is_shared: true };

function renderStatements({ reconciliations = [], transactions = [], accounts = [CARD] } = {}) {
  const reload = vi.fn().mockResolvedValue(undefined);
  renderScreen(
    <Statements household={{ id: 'h1' }} me={ME} members={[ME]} loading={false} data={{ accounts, transactions, statementReconciliations: reconciliations, reload }} />,
  );
  return { reload };
}

async function click(el) {
  await act(async () => {
    el.click();
  });
}

describe('Wealth -> Statements', () => {
  beforeEach(() => {
    calls.length = 0;
    updated = [{ id: 'r' }];
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T10:00:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists a statement nobody has checked first, with what Rokda recorded for its period', () => {
    renderStatements({
      reconciliations: [{ id: 'r1', account_id: 'card-1', statement_date: '2026-08-28', period_start: '2026-07-29', due_date: '2026-09-22', status: 'reconciled', statement_spend: 100 }],
      transactions: [
        { id: 't1', account_id: 'card-1', amount: -40, kind: 'expense', occurred_at: '2026-09-10', is_shared: true },
        { id: 't2', account_id: 'card-1', amount: -100, kind: 'expense', occurred_at: '2026-08-10', is_shared: true },
      ],
    });
    const rows = screen.getAllByTestId('statement-row');
    expect(within(rows[0]).getByText('Not checked')).toBeTruthy();
    expect(within(rows[0]).getByText(/Closed 28 Sept · 29 Aug to 28 Sept · due 22 Oct/)).toBeTruthy();
    expect(within(rows[0]).getByText(/40/)).toBeTruthy();
    // The August statement was reconciled, and Rokda agrees with it.
    const august = rows.find((r) => within(r).queryByText(/Closed 28 Aug/));
    expect(within(august).getByText('Reconciled')).toBeTruthy();
    expect(within(august).getByText("matches the statement's AED 100.00")).toBeTruthy();
    expect(within(august).queryByRole('button', { name: 'Mark done' })).toBeNull();
    expect(screen.getByText(/statements? still to check/)).toBeTruthy();
  });

  it('marks an unchecked statement done by recording it', async () => {
    const { reload } = renderStatements();
    const first = screen.getAllByTestId('statement-row')[0];
    await click(within(first).getByRole('button', { name: 'Mark done' }));
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
    renderStatements({
      reconciliations: [{ id: 'r9', account_id: 'card-1', statement_date: '2026-09-28', period_start: '2026-08-29', due_date: '2026-10-22', status: 'waiting' }],
    });
    const first = screen.getAllByTestId('statement-row')[0];
    expect(within(first).getByText('Waiting')).toBeTruthy();
    await click(within(first).getByRole('button', { name: 'Mark done' }));
    expect(calls).toEqual([expect.objectContaining({ op: 'update', table: 'statement_reconciliations', col: 'id', value: 'r9' })]);
    expect(calls[0].payload.status).toBe('confirmed');
  });

  it("keeps the sign and the cents: a net refund is negative, and a cent's difference shows", () => {
    renderStatements({
      reconciliations: [{ id: 'r2', account_id: 'card-1', statement_date: '2026-08-28', period_start: '2026-07-29', status: 'mismatch', statement_spend: 100.02 }],
      transactions: [
        { id: 't1', account_id: 'card-1', amount: 50.49, kind: 'refund', occurred_at: '2026-09-10', is_shared: true },
        { id: 't2', account_id: 'card-1', amount: -100.01, kind: 'expense', occurred_at: '2026-08-10', is_shared: true },
      ],
    });
    const rows = screen.getAllByTestId('statement-row');
    const september = rows.find((r) => within(r).queryByText(/Closed 28 Sept/));
    expect(within(september).getByText('AED −50.49')).toBeTruthy();
    const august = rows.find((r) => within(r).queryByText(/Closed 28 Aug/));
    expect(within(august).getByText('AED 100.01')).toBeTruthy();
    expect(within(august).getByText('statement AED 100.02; Rokda is AED 0.01 lower')).toBeTruthy();
  });

  it('shows the closing balance a statement recorded', () => {
    renderStatements({
      reconciliations: [{ id: 'r3', account_id: 'card-1', statement_date: '2026-09-28', period_start: '2026-08-29', status: 'waiting', statement_balance: 1234.5 }],
    });
    expect(screen.getByText('Closing balance on the statement: AED 1,234.50')).toBeTruthy();
  });

  it('lists the transactions in a statement\'s period', async () => {
    renderStatements({
      transactions: [
        { id: 't1', account_id: 'card-1', amount: -40, kind: 'expense', occurred_at: '2026-09-10', is_shared: true, merchant: 'Shop' },
        { id: 't2', account_id: 'card-1', amount: 15, kind: 'refund', occurred_at: '2026-09-12', is_shared: true, merchant: 'Shop' },
      ],
    });
    const first = screen.getAllByTestId('statement-row')[0];
    await click(within(first).getByRole('button', { name: 'Show 2 transactions' }));
    const list = within(first).getByRole('list');
    expect(within(list).getByText('10 Sept · Shop')).toBeTruthy();
    expect(within(list).getByText('AED 40.00')).toBeTruthy();
    expect(within(list).getByText('12 Sept · Shop (refund)')).toBeTruthy();
    expect(within(list).getByText('AED −15.00')).toBeTruthy();
  });

  it('resolves a mismatch with who did it and why', async () => {
    const { reload } = renderStatements({
      reconciliations: [{ id: 'r4', account_id: 'card-1', statement_date: '2026-09-28', period_start: '2026-08-29', status: 'mismatch', statement_spend: 10, closed_at: '2026-10-01T00:00:00Z' }],
    });
    const first = screen.getAllByTestId('statement-row')[0];
    expect(within(first).queryByRole('button', { name: 'Mark done' })).toBeNull();
    await click(within(first).getByRole('button', { name: 'Resolve…' }));
    const input = within(first).getByRole('textbox', { name: 'What was done about the difference' });
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(input, 'Added a missing fuel charge');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(within(first).getByRole('button', { name: 'Mark resolved' }));
    expect(calls).toEqual([expect.objectContaining({ op: 'update', col: 'id', value: 'r4' })]);
    expect(calls[0].payload).toMatchObject({ status: 'confirmed', closed_by_member_id: 'm1', note: 'Added a missing fuel charge' });
    expect(reload).toHaveBeenCalled();
  });

  it('reopens a statement marked done by mistake', async () => {
    renderStatements({
      reconciliations: [{ id: 'r5', account_id: 'card-1', statement_date: '2026-09-28', period_start: '2026-08-29', status: 'confirmed', closed_at: '2026-10-01T09:00:00Z', closed_by_member_id: 'm1' }],
    });
    // Settled, so listed after the statements still to check.
    const first = screen.getAllByTestId('statement-row').find((r) => within(r).queryByText(/Closed 28 Sept/));
    expect(within(first).getByText('Done by Alex on 1 Oct')).toBeTruthy();
    await click(within(first).getByRole('button', { name: 'Reopen…' }));
    await click(within(first).getByRole('button', { name: 'Reopen' }));
    expect(calls[0].payload).toMatchObject({ status: 'waiting', closed_at: null, closed_by_member_id: null });
  });

  it('says so when a write changed nothing, rather than reloading as if it had', async () => {
    updated = [];
    const { reload } = renderStatements({
      reconciliations: [{ id: 'r6', account_id: 'card-1', statement_date: '2026-09-28', period_start: '2026-08-29', status: 'waiting' }],
    });
    await click(within(screen.getAllByTestId('statement-row')[0]).getByRole('button', { name: 'Mark done' }));
    expect(screen.getByRole('alert').textContent).toMatch(/Nothing was saved/);
    expect(reload).not.toHaveBeenCalled();
  });

  it('says how to start when no card has a statement day', () => {
    renderStatements({ accounts: [{ ...CARD, statement_day: null }] });
    expect(screen.getByText('No statements yet')).toBeTruthy();
  });
});
