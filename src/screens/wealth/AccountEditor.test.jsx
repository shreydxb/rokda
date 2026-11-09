import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import AccountEditor from './AccountEditor';

const calls = vi.hoisted(() => ({ inserts: [], updates: [], deletes: [], deleteResult: { error: null }, updateMissing: false }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      insert: async (row) => {
        calls.inserts.push({ table, row });
        return { error: null };
      },
      update: (row) => ({
        eq: () => {
          calls.updates.push({ table, row });
          // The rows the update changed, read back: none when the account was
          // deleted elsewhere.
          return Object.assign(Promise.resolve({ error: null }), {
            select: async () => ({ data: calls.updateMissing ? [] : [{ id: 'a1' }], error: null }),
          });
        },
      }),
      delete: () => ({
        eq: async (_field, id) => {
          calls.deletes.push({ table, id });
          return calls.deleteResult;
        },
      }),
    }),
  },
}));

function renderEditor(defaultType) {
  const onSaved = vi.fn();
  renderScreen(<AccountEditor defaultType={defaultType} householdId="h" members={[]} onClose={vi.fn()} onSaved={onSaved} />);
  return { onSaved };
}

const hero = () => document.querySelector('.te-hero-input');
const name = () => screen.getByText('Name').parentElement.querySelector('input');

beforeEach(() => {
  calls.inserts.length = 0;
  calls.updates.length = 0;
  calls.deletes.length = 0;
  calls.deleteResult = { error: null };
  calls.updateMissing = false;
});

// A loan typed below zero was stored that way, and net worth read it as money
// held while Debt payoff read it as owed (Planning audit, 0b-D).
describe('AccountEditor: what a loan or card owes', () => {
  it('asks for a loan\'s amount owed and stores it as owed', async () => {
    const { onSaved } = renderEditor('loan');
    expect(screen.getByText('Amount owed')).toBeTruthy();
    fireEvent.change(name(), { target: { value: 'Car loan' } });
    fireEvent.change(hero(), { target: { value: '-40000' } });
    fireEvent.click(screen.getByText('Add account'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.inserts[0].row).toMatchObject({ type: 'loan', balance: 40000 });
  });

  it('keeps a card in credit below zero, and says how to enter one', async () => {
    const { onSaved } = renderEditor('credit_card');
    expect(screen.getByText('A card in credit is entered below zero.')).toBeTruthy();
    fireEvent.change(name(), { target: { value: 'Bank card' } });
    fireEvent.change(hero(), { target: { value: '-500' } });
    fireEvent.click(screen.getByText('Add account'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.inserts[0].row).toMatchObject({ type: 'credit_card', balance: -500 });
  });
});

// A broker fund's balance moves with every trade. An editor opened before a
// trade and saved after it must not put the old balance back (SHR-367).
describe('AccountEditor: an existing fund', () => {
  const fund = { id: 'a1', name: 'Dollar broker funds', type: 'broker_funds', currency: 'USD', balance: 1000, balance_as_of: '2026-10-01T00:00:00Z', is_shared: true, owner_member_id: null };

  function renderFund() {
    const onSaved = vi.fn();
    renderScreen(<AccountEditor account={fund} householdId="h" members={[]} transactions={[]} onClose={vi.fn()} onSaved={onSaved} />);
    return { onSaved };
  }

  // The outside review, E-10: an update that changed no row did not save.
  it('saving an account deleted elsewhere says it was not saved, and stays open', async () => {
    const { onSaved } = renderFund();
    calls.updateMissing = true;
    fireEvent.change(name(), { target: { value: 'Dollar broker funds (main)' } });
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(screen.getByText("This account wasn't saved: it may have been deleted elsewhere. Close it and refresh.")).toBeTruthy());
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('renaming an account does not send its balance', async () => {
    const { onSaved } = renderFund();
    fireEvent.change(name(), { target: { value: 'Dollar broker funds (main)' } });
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.updates[0].row.name).toBe('Dollar broker funds (main)');
    expect(calls.updates[0].row).not.toHaveProperty('balance');
  });

  it('changing the balance still sends it', async () => {
    const { onSaved } = renderFund();
    fireEvent.change(hero(), { target: { value: '1200' } });
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.updates[0].row).toMatchObject({ balance: 1200 });
  });

  it('retyping an account as a loan stores what it owes, though the balance was not typed', async () => {
    // A loan's balance is what is owed. Left at -2000, net worth would read
    // the new loan as money held (0b-D).
    const overdrawn = { ...fund, id: 'a2', name: 'Bank card', type: 'checking', currency: 'AED', balance: -2000 };
    const onSaved = vi.fn();
    renderScreen(<AccountEditor account={overdrawn} householdId="h" members={[]} transactions={[]} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByText('Type').parentElement.querySelector('select'), { target: { value: 'loan' } });
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.updates[0].row).toMatchObject({ type: 'loan', balance: 2000 });
  });

  it('an account money moved through is closed, not deleted, and says why', async () => {
    calls.deleteResult = { error: { code: '23503', message: 'violates foreign key' } };
    const { onSaved } = renderFund();
    fireEvent.click(screen.getByText('Delete'));
    fireEvent.click(screen.getByText('Confirm delete?'));
    await waitFor(() =>
      expect(screen.getByText("Money moved through this account in recorded trades, so it can't be deleted. Close it instead: everything recorded through it stays.")).toBeTruthy()
    );
    expect(screen.queryByText('violates foreign key')).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Close account'));
    fireEvent.click(screen.getByText('Confirm close?'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.updates[0].row.archived_at).toBeTruthy();
  });
});

// Dividends (SHR-366): a broker fund names where its holdings' dividends are
// paid; the rupee broker's go to the bank account linked to the demat account.
describe('AccountEditor: where a broker fund\'s dividends land', () => {
  const fund = { id: 'f1', name: 'Dollar broker funds', type: 'broker_funds', currency: 'USD', balance: 100, is_shared: true,
    credit_limit: null, statement_day: null, due_day: null, principal: null, interest_rate_pct: null, dividends_into_account_id: null };
  const accounts = [
    fund,
    { id: 'a1', name: 'Dollar current', type: 'checking', currency: 'USD' },
    { id: 'a2', name: 'Rupee bank', type: 'checking', currency: 'INR' },
    { id: 'a3', name: 'Old dollar account', type: 'checking', currency: 'USD', archived_at: '2026-01-01T00:00:00Z' },
  ];

  it('offers this fund and the open accounts in its currency, and saves the choice', async () => {
    const onSaved = vi.fn();
    renderScreen(<AccountEditor account={fund} accounts={accounts} householdId="h" members={[]} onClose={vi.fn()} onSaved={onSaved} />);
    const select = screen.getByLabelText('Dividends paid into');
    expect([...select.options].map((o) => o.textContent)).toEqual(['This fund', 'Dollar current']);
    fireEvent.change(select, { target: { value: 'a1' } });
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.updates[0].row.dividends_into_account_id).toBe('a1');
  });

  it('is not offered for a bank account, which saves no destination', async () => {
    const { onSaved } = renderEditor('checking');
    expect(screen.queryByLabelText('Dividends paid into')).toBeNull();
    fireEvent.change(name(), { target: { value: 'Current' } });
    fireEvent.click(screen.getByText('Add account'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.inserts[0].row.dividends_into_account_id).toBeNull();
  });
});
