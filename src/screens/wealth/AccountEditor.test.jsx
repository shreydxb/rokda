import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import AccountEditor from './AccountEditor';

const calls = vi.hoisted(() => ({ inserts: [] }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      insert: async (row) => {
        calls.inserts.push({ table, row });
        return { error: null };
      },
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
