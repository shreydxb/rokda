import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import DebtPlanEditor from './DebtPlanEditor';

const calls = vi.hoisted(() => ({ upserts: [] }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      upsert: async (row, options) => {
        calls.upserts.push({ table, row, options });
        return { error: null };
      },
    }),
  },
}));

function renderEditor(assumptions = null) {
  const onSaved = vi.fn();
  renderScreen(<DebtPlanEditor householdId="h" assumptions={assumptions} onClose={vi.fn()} onSaved={onSaved} />);
  return { onSaved };
}

const extra = () => screen.getByLabelText('Committed extra payment, AED a month');

beforeEach(() => {
  calls.upserts.length = 0;
});

// Nothing tested what this drawer saves (Planning audit, 0b-C).
describe('DebtPlanEditor', () => {
  it('saves a blank extra payment as not set, not as 0', async () => {
    const { onSaved } = renderEditor();
    fireEvent.click(screen.getByText('Stops — nothing new charged'));
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.upserts[0].row).toMatchObject({ household_id: 'h', debt_extra_payment: null, debt_assume_no_new_card_spend: true });
  });

  it('saves 0 when 0 is entered, and the card choice as it stands', async () => {
    const { onSaved } = renderEditor({ debt_extra_payment: 500, debt_assume_no_new_card_spend: true });
    expect(extra().value).toBe('500');
    fireEvent.change(extra(), { target: { value: '0' } });
    fireEvent.click(screen.getByText('Continues at the current rate'));
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.upserts[0].row).toMatchObject({ debt_extra_payment: 0, debt_assume_no_new_card_spend: false });
  });

  it('refuses a negative extra payment', () => {
    renderEditor();
    fireEvent.change(extra(), { target: { value: '-200' } });
    fireEvent.click(screen.getByText('Save changes'));
    expect(screen.getByRole('alert').textContent).toBe('An extra payment of zero or more.');
    expect(extra().getAttribute('aria-invalid')).toBe('true');
    expect(calls.upserts).toEqual([]);
  });
});
