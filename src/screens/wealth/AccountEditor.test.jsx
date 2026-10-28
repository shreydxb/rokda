import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import AccountEditor from './AccountEditor';

const calls = vi.hoisted(() => ({ inserts: [], updates: [], deletes: [], deleteResult: { error: null } }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      insert: async (row) => {
        calls.inserts.push({ table, row });
        return { error: null };
      },
      update: (row) => ({
        eq: async () => {
          calls.updates.push({ table, row });
          return { error: null };
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
