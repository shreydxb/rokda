import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

// Importing a statement from a CSV file (SHR-302), on synthetic data: the
// columns are checked, every line is reviewed, the kept lines are sent
// together, and an earlier import can be undone.
const rpcs = [];
let batches = [];
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: batches }) }) }),
    }),
    rpc: (name, args) => {
      rpcs.push({ name, args });
      return Promise.resolve({ data: name === 'commit_import' ? { batch_id: 'b1', imported: 3, already: 0 } : { removed: 2, kept: 1 }, error: null });
    },
  },
}));

const { default: Import } = await import('./Import');

const ACCOUNTS = [
  { id: 'bank', name: 'Current account', type: 'checking', currency: 'AED', archived_at: null },
  { id: 'savings', name: 'Savings', type: 'savings', currency: 'AED', archived_at: null },
];
// Day 05 and 09 read either way round, so the order has to be confirmed.
const STATEMENT = ['Bank statement export', 'Date,Details,Money out,Money in', '05/09/2026,Grocer,120.50,', '09/09/2026,Fuel,60.00,', '09/09/2026,Transfer to savings,2000.00,', '05/09/2026,SALARY,,10000.00'].join('\n');

function render(data = {}) {
  const reload = vi.fn();
  renderScreen(
    <Import
      household={{ id: 'hh' }}
      data={{ accounts: ACCOUNTS, transactions: [], categories: [{ id: 'cat-food', name: 'Groceries', kind: 'expense' }], categoryRules: [], reload, ...data }}
      loading={false}
    />,
  );
  return { reload };
}

async function chooseFile(text = STATEMENT) {
  fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'bank' } });
  const file = new File([text], 'september.csv', { type: 'text/csv' });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Statement file'), { target: { files: [file] } });
  });
  await waitFor(() => expect(screen.getByText('How the columns are read')).toBeTruthy());
}

beforeEach(() => {
  rpcs.length = 0;
  batches = [];
});

describe('Importing a statement', () => {
  it('reads the columns, and asks before trusting dates that read either way round', async () => {
    render();
    await chooseFile();
    expect(screen.getByLabelText('Date column').value).toBe('0');
    expect(screen.getByLabelText('Amounts').value).toBe('split');
    const next = screen.getByRole('button', { name: 'Read the lines' });
    expect(next.disabled).toBe(true);
    expect(screen.getByText(/These dates read correctly either way round/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(next.disabled).toBe(false);
  });

  it('reviews every line, needs a choice for a transfer, and sends the kept lines together', async () => {
    const { reload } = render({
      transactions: [{ id: 'old', account_id: 'bank', amount: -60, occurred_at: '2026-09-08', merchant: 'Petrol', kind: 'expense' }],
    });
    await chooseFile();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Read the lines' }));

    // The fuel line looks already recorded, the transfer needs its other account.
    expect(screen.getByText('Looks already recorded: Petrol on 8 Sept.')).toBeTruthy();
    expect(screen.getByText('Choose the other account.')).toBeTruthy();
    const importButton = screen.getByRole('button', { name: 'Import 3 records' });
    expect(importButton.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Line 5 other account'), { target: { value: 'savings' } });
    fireEvent.change(screen.getByLabelText('Line 3 category'), { target: { value: 'cat-food' } });
    expect(importButton.disabled).toBe(false);

    await act(async () => fireEvent.click(importButton));
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0].name).toBe('commit_import');
    expect(rpcs[0].args).toMatchObject({ p_household_id: 'hh', p_account_id: 'bank', p_file_name: 'september.csv', p_row_count: 4, p_period_start: '2026-09-05', p_period_end: '2026-09-09' });
    expect(rpcs[0].args.p_rows).toEqual([
      { occurred_at: '2026-09-05', kind: 'expense', merchant: 'Grocer', import_key: '2026-09-05|-120.50|grocer', category_id: 'cat-food', amount: -120.5 },
      { occurred_at: '2026-09-09', kind: 'transfer', merchant: 'Transfer to savings', import_key: '2026-09-09|-2000.00|transfer to savings', other_account_id: 'savings', amount: -2000 },
      { occurred_at: '2026-09-05', kind: 'income', merchant: 'SALARY', import_key: '2026-09-05|10000.00|salary', amount: 10000 },
    ]);
    expect(screen.getByRole('status').textContent).toBe('Imported 3 records into Current account.');
    expect(reload).toHaveBeenCalled();
  });

  it('compares the file with the statement\'s balances', async () => {
    render();
    await chooseFile();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Opening balance'), { target: { value: '5,000.00' } });
    fireEvent.change(screen.getByLabelText('Closing balance'), { target: { value: '12,800.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Read the lines' }));
    expect(document.querySelector('.im-note').textContent).toMatch(/add up to \+7,819\.50; the statement’s balance moved \+7,800\.00\. −19\.50 is not explained/);
  });

  it('undoes an earlier import after a second press', async () => {
    batches = [{ id: 'b0', file_name: 'august.csv', account_id: 'bank', created_at: '2026-10-01T10:00:00Z', imported_count: 3, skipped_count: 1, status: 'committed' }];
    render();
    await waitFor(() => expect(screen.getByText(/august\.csv · Current account/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(rpcs).toHaveLength(0);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Remove its records?' })));
    expect(rpcs).toEqual([{ name: 'undo_import', args: { p_batch_id: 'b0' } }]);
    expect(screen.getByRole('status').textContent).toBe('Removed 2 records; kept 1 that was changed or joined to other records since.');
  });
});
