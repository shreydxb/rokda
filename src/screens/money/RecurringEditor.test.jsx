import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import RecurringEditor from './RecurringEditor';

const calls = vi.hoisted(() => ({ writes: [] }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      insert: async (row) => {
        calls.writes.push({ table, op: 'insert', row });
        return { error: null };
      },
      update: (row) => ({
        eq: async (column, id) => {
          calls.writes.push({ table, op: 'update', row, id });
          return { error: null };
        },
      }),
    }),
  },
}));

const HOUSEHOLD = { id: 'h', inr_per_aed: 26, inr_rate_set_at: '2026-09-27T00:00:00Z', inr_rate_source: 'auto' };
const field = (text) => screen.getByText(text).parentElement.querySelector('input');

function renderEditor(props = {}) {
  const onSaved = vi.fn();
  renderScreen(<RecurringEditor household={HOUSEHOLD} householdId="h" accounts={[]} categories={[]} members={[]} onClose={vi.fn()} onSaved={onSaved} {...props} />);
  return { onSaved };
}

beforeEach(() => {
  calls.writes.length = 0;
});

describe('RecurringEditor: rupees and a last date', () => {
  it('saves a premium in rupees, with its AED figure and last date', async () => {
    const { onSaved } = renderEditor();
    fireEvent.change(screen.getByLabelText('Currency'), { target: { value: 'INR' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '89554' } });
    expect(screen.getByText(/^≈ AED 3,444 at today's rate/)).toBeTruthy();
    fireEvent.change(field('Name'), { target: { value: 'LIC Policy A premium' } });
    fireEvent.change(field('Next due date'), { target: { value: '2026-11-11' } });
    fireEvent.change(screen.getByLabelText('Last one on'), { target: { value: '2034-11-11' } });
    fireEvent.click(screen.getByText('Add commitment'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.writes[0].row).toMatchObject({ currency: 'INR', native_amount: -89554, ends_on: '2034-11-11', next_due_date: '2026-11-11' });
    expect(calls.writes[0].row.amount).toBeCloseTo(-3444.38, 2);
  });

  it('edits a rupee schedule in rupees', () => {
    renderEditor({ item: { id: 'r', name: 'PPF deposit', amount: -5749.72, currency: 'INR', native_amount: -150000, cadence: 'yearly', interval_count: 1, next_due_date: '2027-04-01', ends_on: '2034-04-01', is_shared: true } });
    expect(screen.getByLabelText('Amount').value).toBe('150000');
    expect(screen.getByLabelText('Last one on').value).toBe('2034-04-01');
  });

  it('refuses a last date before the next one', () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '100' } });
    fireEvent.change(field('Name'), { target: { value: 'Gym' } });
    fireEvent.change(field('Next due date'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('Last one on'), { target: { value: '2026-10-01' } });
    fireEvent.click(screen.getByText('Add commitment'));
    expect(screen.getByRole('alert').textContent).toBe('The last date cannot be before the next due date.');
    expect(calls.writes).toEqual([]);
  });

  it('keeps an AED schedule in AED, with no second amount', async () => {
    const { onSaved } = renderEditor();
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '500' } });
    fireEvent.change(field('Name'), { target: { value: 'DEWA' } });
    fireEvent.click(screen.getByText('Add commitment'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.writes[0].row).toMatchObject({ amount: -500, currency: 'AED', native_amount: null, ends_on: null });
  });
});
