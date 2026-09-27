import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import DebtEditor from './DebtEditor';

// Every write the editor makes, in order.
const calls = vi.hoisted(() => ({ writes: [], failDebt: false }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      insert: (row) => {
        calls.writes.push({ table, op: 'insert', row });
        const result = table === 'debts' && calls.failDebt ? { error: { message: 'debt refused' } } : { error: null };
        return {
          select: () => ({ single: async () => ({ data: { id: 'new-account' }, error: null }) }),
          then: (resolve) => resolve(result),
        };
      },
      update: (row) => ({
        eq: async (column, value) => {
          calls.writes.push({ table, op: 'update', row, id: value });
          return { error: null };
        },
      }),
      delete: () => ({
        eq: async (column, value) => {
          calls.writes.push({ table, op: 'delete', id: value });
          return { error: null };
        },
      }),
    }),
  },
}));

const MEMBERS = [{ id: 'm1', display_name: 'Shreyash' }];
const LOAN = { id: 'loan', name: 'Car loan', type: 'loan', currency: 'AED', balance: 38000, balance_aed: 38000, is_shared: true, owner_member_id: null, archived_at: null };
const SAVINGS = { id: 'sav', name: 'FAB', type: 'checking', currency: 'AED', balance: 5000, is_shared: true, archived_at: null };

function renderEditor(props = {}) {
  const onSaved = vi.fn();
  renderScreen(<DebtEditor householdId="h" members={MEMBERS} accounts={[LOAN, SAVINGS]} debts={[]} onClose={vi.fn()} onSaved={onSaved} {...props} />);
  return { onSaved };
}

const type = (label, value) => fireEvent.change(label, { target: { value } });
const field = (text) => screen.getByText(text).parentElement.querySelector('input');
const options = () => [...screen.getByLabelText('Account').querySelectorAll('option')].map((o) => o.textContent);

beforeEach(() => {
  calls.writes.length = 0;
  calls.failDebt = false;
});

describe('DebtEditor: where the balance lives', () => {
  it('offers to create a loan account, the open loan and card accounts, or none', () => {
    renderEditor();
    expect(options()).toEqual(['Create a loan account', 'Car loan (loan)', 'Not linked: not in net worth']);
  });

  it('creates the loan account with the debt, so net worth counts it', async () => {
    const { onSaved } = renderEditor();
    type(screen.getByLabelText('Balance owed'), '40000');
    type(field('Name'), 'Car loan');
    fireEvent.click(screen.getByText('Add debt'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.writes[0]).toMatchObject({ table: 'accounts', op: 'insert', row: { household_id: 'h', name: 'Car loan', type: 'loan', currency: 'AED', balance: 40000, is_shared: true } });
    expect(calls.writes[0].row.balance_as_of).toBeTruthy();
    expect(calls.writes[1]).toMatchObject({ table: 'debts', op: 'insert', row: { balance: 40000, account_id: 'new-account' } });
  });

  it('removes the account it made when the debt cannot be saved', async () => {
    calls.failDebt = true;
    renderEditor();
    type(screen.getByLabelText('Balance owed'), '40000');
    type(field('Name'), 'Car loan');
    fireEvent.click(screen.getByText('Add debt'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('debt refused'));
    expect(calls.writes.at(-1)).toEqual({ table: 'accounts', op: 'delete', id: 'new-account' });
  });

  it('takes a linked account\'s balance, and writes a new one back to it', async () => {
    const debt = { id: 'd1', name: 'Car loan', note: '', balance: 40000, apr_pct: 3.5, minimum_payment: 2193, is_shared: true, account_id: 'loan' };
    const { onSaved } = renderEditor({ debt, debts: [debt] });
    expect(screen.getByLabelText('Balance owed').value).toBe('38000');
    expect(options()).toEqual(['Car loan (loan)', 'Not linked: not in net worth']);
    type(screen.getByLabelText('Balance owed'), '36000');
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.writes[0]).toMatchObject({ table: 'accounts', op: 'update', id: 'loan', row: { balance: 36000 } });
    expect(calls.writes[1]).toMatchObject({ table: 'debts', op: 'update', id: 'd1', row: { balance: 36000, account_id: 'loan' } });
  });

  it('links an existing debt to an account without touching the account', async () => {
    const debt = { id: 'd1', name: 'Car loan', note: '', balance: 40000, apr_pct: 3.5, minimum_payment: 2193, is_shared: true, account_id: null };
    const { onSaved } = renderEditor({ debt, debts: [debt] });
    expect(screen.getByLabelText('Account').value).toBe('');
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'loan' } });
    expect(screen.getByLabelText('Balance owed').value).toBe('38000');
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.writes).toEqual([{ table: 'debts', op: 'update', id: 'd1', row: expect.objectContaining({ balance: 38000, account_id: 'loan' }) }]);
  });

  it('does not offer an account another debt already plans for', () => {
    renderEditor({ debts: [{ id: 'other', account_id: 'loan' }] });
    expect(options()).toEqual(['Create a loan account', 'Not linked: not in net worth']);
  });
});
