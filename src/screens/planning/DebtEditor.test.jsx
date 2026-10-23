import { beforeEach, describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { screen, fireEvent, waitFor } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import DebtEditor from './DebtEditor';

// Every write the editor makes, in order.
// `moved` makes a write conditional on the balance find nothing to update,
// as when the account changed after the editor opened.
const calls = vi.hoisted(() => ({ writes: [], failDebt: false, moved: false }));
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
      update: (row) => {
        const filters = {};
        const write = () => calls.writes.push({ table, op: 'update', row, id: filters.id, ...('balance' in filters ? { onlyOver: filters.balance } : {}) });
        const chain = {
          eq: (column, value) => {
            filters[column] = value;
            return chain;
          },
          select: async () => {
            write();
            return { data: calls.moved ? [] : [{ id: filters.id }], error: null };
          },
          then: (resolve) => {
            write();
            return resolve({ error: null });
          },
        };
        return chain;
      },
      delete: () => ({
        eq: async (column, value) => {
          calls.writes.push({ table, op: 'delete', id: value });
          return { error: null };
        },
      }),
    }),
  },
}));

const MEMBERS = [{ id: 'm1', display_name: 'Alex' }];
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
  calls.moved = false;
});

function fillTerms(apr = '3.5', minimum = '2193') {
  type(field('APR (%/yr)'), apr);
  type(field('Minimum (AED/mo)'), minimum);
}

describe('DebtEditor: where the balance lives', () => {
  it('offers to create a loan account, the open loan and card accounts, or none', () => {
    renderEditor();
    expect(options()).toEqual(['Create a loan account', 'Car loan (loan)', 'Not linked: not in net worth']);
  });

  it('creates the loan account with the debt, so net worth counts it', async () => {
    const { onSaved } = renderEditor();
    type(screen.getByLabelText('Balance owed'), '40000');
    type(field('Name'), 'Car loan');
    fillTerms();
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
    fillTerms();
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
    expect(calls.writes[0]).toMatchObject({ table: 'accounts', op: 'update', id: 'loan', row: { balance: 36000 }, onlyOver: 38000 });
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

// A blank rate or minimum was saved as 0, and Debt payoff then called both
// known (Planning audit, 0b-C).
describe('DebtEditor: the rate and the minimum', () => {
  it('needs both, marks each field, and saves nothing until they are entered', () => {
    renderEditor();
    type(screen.getByLabelText('Balance owed'), '40000');
    type(field('Name'), 'Car loan');
    fireEvent.click(screen.getByText('Add debt'));
    expect(screen.getByRole('alert').textContent).toBe('Fix the marked field to save.');
    expect(field('APR (%/yr)').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Enter the rate, 0 if it has none.')).toBeTruthy();
    expect(screen.getByText('Enter the minimum payment, 0 if there is none.')).toBeTruthy();
    expect(document.activeElement).toBe(field('APR (%/yr)'));
    expect(calls.writes).toEqual([]);
  });

  it('refuses a negative minimum and a rate above 100%', () => {
    renderEditor();
    type(screen.getByLabelText('Balance owed'), '40000');
    type(field('Name'), 'Car loan');
    fillTerms('120', '-5');
    fireEvent.click(screen.getByText('Add debt'));
    expect(screen.getByText('A rate between 0% and 100%.')).toBeTruthy();
    expect(screen.getByText('A minimum of zero or more.')).toBeTruthy();
    expect(calls.writes).toEqual([]);
  });

  it('saves a 0% loan with no minimum when 0 is what was entered', async () => {
    const { onSaved } = renderEditor();
    type(screen.getByLabelText('Balance owed'), '6000');
    type(field('Name'), 'Family loan');
    fillTerms('0', '0');
    fireEvent.click(screen.getByText('Add debt'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.writes.at(-1)).toMatchObject({ table: 'debts', op: 'insert', row: { apr_pct: 0, minimum_payment: 0 } });
  });
});

// The form's balance is fixed when the editor opens, while accounts reload
// under it; a save once wrote the opening balance back over a newer one
// (Planning audit, 0b-C).
describe('DebtEditor: a balance changed while it is open', () => {
  const debt = { id: 'd1', name: 'Car loan', note: '', balance: 40000, apr_pct: 3.5, minimum_payment: 2193, is_shared: true, account_id: 'loan' };

  it('leaves the account alone when no new balance was typed', async () => {
    const onSaved = vi.fn();
    // Accounts reloading under the open editor, with the card paid down elsewhere.
    function Reloading() {
      const [accounts, setAccounts] = useState([LOAN, SAVINGS]);
      return (
        <>
          <button type="button" onClick={() => setAccounts([{ ...LOAN, balance: 35000, balance_aed: 35000 }, SAVINGS])}>
            Accounts reload
          </button>
          <DebtEditor householdId="h" members={MEMBERS} debt={debt} debts={[debt]} accounts={accounts} onClose={vi.fn()} onSaved={onSaved} />
        </>
      );
    }
    renderScreen(<Reloading />);
    fireEvent.click(screen.getByText('Accounts reload'));
    type(field('APR (%/yr)'), '3.9');
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.writes).toEqual([{ table: 'debts', op: 'update', id: 'd1', row: expect.objectContaining({ apr_pct: 3.9, balance: 35000 }) }]);
  });

  it('writes a typed balance only over the one it showed, and says so when that had changed', async () => {
    calls.moved = true;
    const { onSaved } = renderEditor({ debt, debts: [debt] });
    type(screen.getByLabelText('Balance owed'), '36000');
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe("Car loan's balance was changed after you opened this, so neither it nor the debt was saved. Cancel and open the debt again to see the new balance."));
    expect(calls.writes).toEqual([{ table: 'accounts', op: 'update', id: 'loan', row: expect.objectContaining({ balance: 36000 }), onlyOver: 38000 }]);
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('DebtEditor: whose debt it is', () => {
  it('takes a linked debt\'s owner from its account, and says where to change it', async () => {
    const own = { ...LOAN, is_shared: false, owner_member_id: 'm1' };
    const debt = { id: 'd1', name: 'Car loan', note: '', balance: 40000, apr_pct: 3.5, minimum_payment: 2193, is_shared: true, owner_member_id: null, account_id: 'loan' };
    const onSaved = vi.fn();
    renderScreen(<DebtEditor householdId="h" members={MEMBERS} accounts={[own, SAVINGS]} debt={debt} debts={[debt]} onClose={vi.fn()} onSaved={onSaved} />);
    expect(screen.getByText('Alex, as Car loan is in Wealth, where its owner is changed.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Shared' })).toBeNull();
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.writes.at(-1)).toMatchObject({ table: 'debts', row: { is_shared: false, owner_member_id: 'm1' } });
  });

  it('lets a debt with no account choose its owner', () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Shared' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Alex' })).toBeTruthy();
  });
});
