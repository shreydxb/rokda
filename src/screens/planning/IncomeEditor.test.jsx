import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import IncomeEditor from './IncomeEditor';

const calls = vi.hoisted(() => ({ writes: [] }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      insert: async (row) => {
        calls.writes.push({ table, row });
        return { error: null };
      },
    }),
  },
}));

beforeEach(() => {
  calls.writes.length = 0;
});

describe('IncomeEditor: a sum paid in a set year', () => {
  it('saves a policy maturity in rupees, in its year', async () => {
    const onSaved = vi.fn();
    renderScreen(<IncomeEditor householdId="h" onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(screen.getByText('One-off sum'));
    fireEvent.click(screen.getByText('In a set year'));
    fireEvent.change(screen.getByLabelText('Currency'), { target: { value: 'INR' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '4350000' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'LIC Policy A maturity' } });
    fireEvent.click(screen.getByText('Add income'));
    expect(screen.getByRole('alert').textContent).toMatch(/^Enter the year it is paid, \d{4} or later\.$/);
    fireEvent.change(screen.getByLabelText('Paid in year'), { target: { value: '2044' } });
    fireEvent.click(screen.getByText('Add income'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.writes[0].row).toMatchObject({ kind: 'lump_sum', currency: 'INR', amount: 4350000, in_year: 2044, starts_after_years: 0, lasts_years: null });
  });
});
