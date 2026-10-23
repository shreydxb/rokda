import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import ForecastAssumptionsEditor from './ForecastAssumptionsEditor';

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

const SAVED = { household_id: 'h', nominal_return_pct: 7, inflation_pct: 3, safe_withdrawal_pct: 4, lean_annual_spend: null, baseline_set_at: '2026-09-01T00:00:00Z' };

function renderEditor(props = {}) {
  const onSaved = vi.fn();
  renderScreen(<ForecastAssumptionsEditor householdId="h" assumptions={SAVED} budgetMonthlySaving={5000} onClose={vi.fn()} onSaved={onSaved} {...props} />);
  return { onSaved };
}

const input = (label) => screen.getByLabelText(label);
const type = (label, value) => fireEvent.change(input(label), { target: { value } });
const RETURN = 'Investment return, nominal percent a year';
const INFLATION = 'Inflation, percent a year';
const WITHDRAWAL = 'Safe withdrawal rate, percent a year';
const LEAN = 'Essentials-only annual spend';

beforeEach(() => {
  calls.upserts.length = 0;
});

// A cleared field was saved as 0%, and any number was stored as typed, with
// nothing in the database to stop either (Planning audit, 0b-C).
describe('ForecastAssumptionsEditor: Baseline', () => {
  it('saves what was typed, and on the first save makes it the baseline, with the budget\'s savings target', async () => {
    const { onSaved } = renderEditor({ assumptions: null });
    expect(screen.getByText(/your budget's savings target of 5,000 a month/)).toBeTruthy();
    expect(input(RETURN).value).toBe('6');
    type(RETURN, '7.5');
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.upserts).toHaveLength(1);
    expect(calls.upserts[0].row).toMatchObject({
      household_id: 'h',
      nominal_return_pct: 7.5,
      inflation_pct: 2.5,
      safe_withdrawal_pct: 4,
      lean_annual_spend: null,
      baseline_nominal_return_pct: 7.5,
      baseline_inflation_pct: 2.5,
      baseline_monthly_saving: 5000,
    });
    // From now on they are the household's, not the defaults.
    expect(calls.upserts[0].row.assumptions_saved_at).toEqual(expect.any(String));
  });

  // Planning audit, 1.2: it froze the recorded average, months recorded only
  // in part included.
  it('takes no baseline while the budget has no savings target', async () => {
    const { onSaved } = renderEditor({ assumptions: null, budgetMonthlySaving: null });
    expect(screen.getByText(/No baseline is set yet\. It takes your budget's savings target, and the budget has none/)).toBeTruthy();
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.upserts[0].row).toMatchObject({ nominal_return_pct: 6, inflation_pct: 2.5 });
    expect(calls.upserts[0].row).not.toHaveProperty('baseline_set_at');
    expect(calls.upserts[0].row).not.toHaveProperty('baseline_monthly_saving');
  });

  it('saves a cleared field as the default its placeholder names, never 0', async () => {
    const { onSaved } = renderEditor();
    type(INFLATION, '');
    type(WITHDRAWAL, '');
    expect(input(INFLATION).placeholder).toBe('blank: 2.5');
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.upserts[0].row).toMatchObject({ nominal_return_pct: 7, inflation_pct: 2.5, safe_withdrawal_pct: 4 });
    // Saved before, so the baseline stays where it was.
    expect(calls.upserts[0].row).not.toHaveProperty('baseline_set_at');
  });

  it('keeps 0% when 0 is what was typed', async () => {
    const { onSaved } = renderEditor();
    type(INFLATION, '0');
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.upserts[0].row.inflation_pct).toBe(0);
  });

  it('refuses figures out of range, marks each, and saves nothing', () => {
    renderEditor();
    type(RETURN, '-40');
    type(INFLATION, '-100');
    type(WITHDRAWAL, '0');
    type(LEAN, '-1');
    fireEvent.click(screen.getByText('Save changes'));
    expect(screen.getByRole('alert').textContent).toBe('Fix the marked field to save.');
    expect(screen.getByText('A return between −20% and 50%.')).toBeTruthy();
    expect(screen.getByText('Inflation between −10% and 30%.')).toBeTruthy();
    expect(screen.getByText('A withdrawal rate between 1% and 10%.')).toBeTruthy();
    expect(screen.getByText('Essentials-only spend is an amount above zero.')).toBeTruthy();
    expect(input(RETURN).getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(input(RETURN));
    expect(calls.upserts).toEqual([]);
  });

  it('takes the message away as the field is corrected', () => {
    renderEditor();
    type(RETURN, '60');
    fireEvent.click(screen.getByText('Save changes'));
    expect(screen.getByText('A return between −20% and 50%.')).toBeTruthy();
    type(RETURN, '8');
    expect(screen.queryByText('A return between −20% and 50%.')).toBeNull();
    expect(input(RETURN).getAttribute('aria-invalid')).toBe('false');
  });
});

describe('ForecastAssumptionsEditor: Custom', () => {
  it('starts from Baseline, and a cleared field keeps following it', async () => {
    const { onSaved } = renderEditor({ scenario: 'custom' });
    expect(input(RETURN).value).toBe('7');
    expect(screen.queryByLabelText(LEAN)).toBeNull();
    type(RETURN, '9');
    type(INFLATION, '');
    expect(input(INFLATION).placeholder).toBe("blank: Baseline's 3.0");
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const row = calls.upserts[0].row;
    expect(row).toMatchObject({ household_id: 'h', custom_nominal_return_pct: 9, custom_inflation_pct: null, custom_safe_withdrawal_pct: 4 });
    expect(row.custom_updated_at).toBeTruthy();
    // Custom never writes Baseline's columns, or says Baseline was chosen.
    expect(row).not.toHaveProperty('assumptions_saved_at');
    expect(row).not.toHaveProperty('nominal_return_pct');
    expect(row).not.toHaveProperty('inflation_pct');
  });

  it('opens on its own saved figures, and a figure saved blank opens blank', () => {
    renderEditor({ scenario: 'custom', assumptions: { ...SAVED, custom_nominal_return_pct: 5.5, custom_inflation_pct: null, custom_safe_withdrawal_pct: 3.5, custom_updated_at: '2026-09-02T00:00:00Z' } });
    expect(input(RETURN).value).toBe('5.5');
    expect(input(INFLATION).value).toBe('');
    expect(input(INFLATION).placeholder).toBe("blank: Baseline's 3.0");
    expect(input(WITHDRAWAL).value).toBe('3.5');
  });
});
