import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/dom';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

// The screen's only write: marking a statement done. The client is mocked so
// the test can see exactly what it sends.
const calls = [];
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
            return Promise.resolve({ error: null });
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
    <Statements household={{ id: 'h1' }} me={ME} loading={false} data={{ accounts, transactions, statementReconciliations: reconciliations, reload }} />,
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
    expect(within(august).getByText('matches the statement')).toBeTruthy();
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

  it('says how to start when no card has a statement day', () => {
    renderStatements({ accounts: [{ ...CARD, statement_day: null }] });
    expect(screen.getByText('No statements yet')).toBeTruthy();
  });
});
