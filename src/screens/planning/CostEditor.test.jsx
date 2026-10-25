import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import CostEditor from './CostEditor';

const calls = vi.hoisted(() => ({ writes: [] }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      insert: async (row) => {
        calls.writes.push({ table, op: 'insert', row });
        return { error: null };
      },
      update: (row) => ({
        eq: async (column, value) => {
          calls.writes.push({ table, op: 'update', row, value });
          return { error: null };
        },
      }),
      delete: () => ({
        eq: async (column, value) => {
          calls.writes.push({ table, op: 'delete', value });
          return { error: null };
        },
      }),
    }),
  },
}));

beforeEach(() => {
  calls.writes.length = 0;
});

const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

// Planning audit, 3.13: the costs that start when work stops.
describe('CostEditor', () => {
  it('saves health cover for each person, rising above inflation, for a set number of years', async () => {
    const onSaved = vi.fn();
    renderScreen(<CostEditor householdId="h" onClose={vi.fn()} onSaved={onSaved} />);
    type('Amount a year', '9000');
    type('Name', 'Health cover');
    fireEvent.click(screen.getByText('Each person'));
    type('Rise a year above inflation', '3.5');
    fireEvent.click(screen.getByText('A set number of years'));
    type('Lasts for years', '30');
    fireEvent.click(screen.getByText('Add cost'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.writes).toEqual([
      {
        table: 'after_work_costs',
        op: 'insert',
        row: expect.objectContaining({ household_id: 'h', name: 'Health cover', amount: 9000, currency: 'AED', per_person: true, rise_pct: 3.5, starts_after_years: 0, lasts_years: 30 }),
      },
    ]);
  });

  it('says what is missing or out of range, the limits the database keeps, and saves nothing', () => {
    renderScreen(<CostEditor householdId="h" onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByText('Add cost'));
    expect(screen.getByRole('alert').textContent).toBe('Name it.');
    type('Name', 'Visa fees');
    fireEvent.click(screen.getByText('Add cost'));
    expect(screen.getByRole('alert').textContent).toBe('Enter an amount above zero.');
    type('Amount a year', '2000');
    type('Rise a year above inflation', '12');
    fireEvent.click(screen.getByText('Add cost'));
    expect(screen.getByRole('alert').textContent).toBe('A rise between 0% and 10% a year above inflation.');
    type('Rise a year above inflation', '');
    type('Starts after years from when work stops', '61');
    fireEvent.click(screen.getByText('Add cost'));
    expect(screen.getByRole('alert').textContent).toBe('Start between 0 and 60 years after work stops.');
    expect(calls.writes).toEqual([]);
  });

  it('warns that a rupee amount is not counted until a rate is set', () => {
    renderScreen(<CostEditor householdId="h" household={{ id: 'h', inr_per_aed: null }} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Currency'), { target: { value: 'INR' } });
    expect(screen.getByText(/No AED\/INR rate is set yet/)).toBeTruthy();
  });

  it('edits a saved cost, and deletes it on the second press', async () => {
    const row = { id: 'c1', name: 'Visa fees', amount: 2000, currency: 'AED', per_person: false, rise_pct: 0, starts_after_years: 0, lasts_years: null, note: '' };
    const onSaved = vi.fn();
    renderScreen(<CostEditor row={row} householdId="h" onClose={vi.fn()} onSaved={onSaved} />);
    expect(screen.getByLabelText('Rise a year above inflation').value).toBe('');
    type('Amount a year', '2500');
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(calls.writes[0]).toMatchObject({ op: 'update', value: 'c1', row: { amount: 2500 } });
    fireEvent.click(screen.getByText('Delete'));
    expect(calls.writes).toHaveLength(1);
    fireEvent.click(screen.getByText('Confirm delete?'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    expect(calls.writes[1]).toEqual({ table: 'after_work_costs', op: 'delete', value: 'c1' });
  });
});
