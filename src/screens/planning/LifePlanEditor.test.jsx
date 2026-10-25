import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import LifePlanEditor from './LifePlanEditor';

const calls = vi.hoisted(() => ({ upserts: [], deletes: [], updates: [], inserts: [] }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      upsert: async (row, options) => {
        calls.upserts.push({ table, row, options });
        return { error: null };
      },
      insert: async (row) => {
        calls.inserts.push({ table, row });
        return { error: null };
      },
      update: (patch) => ({
        eq: async (column, value) => {
          calls.updates.push({ table, patch, value });
          return { error: null };
        },
      }),
      delete: () => ({
        in: async (column, values) => {
          calls.deletes.push({ table, column, values });
          return { error: null };
        },
      }),
    }),
  },
}));

const MEMBERS = [
  { id: 'm1', display_name: 'Alex' },
  { id: 'm2', display_name: 'Sam' },
];

function renderEditor(props = {}) {
  const onSaved = vi.fn();
  renderScreen(<LifePlanEditor householdId="h" members={MEMBERS} memberLife={[]} assumptions={null} onClose={vi.fn()} onSaved={onSaved} {...props} />);
  return { onSaved };
}

const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => {
  calls.upserts.length = 0;
  calls.deletes.length = 0;
  calls.updates.length = 0;
  calls.inserts.length = 0;
});

describe('LifePlanEditor', () => {
  it('needs a birth year and an age for at least one person', () => {
    renderEditor();
    fireEvent.click(screen.getByText('Save plan'));
    expect(screen.getByRole('alert').textContent).toMatch(/at least one person/);
    type("Alex's birth year", '1994');
    fireEvent.click(screen.getByText('Save plan'));
    expect(screen.getByRole('alert').textContent).toBe('Plan Alex to an age between 40 and 120.');
    expect(calls.upserts).toEqual([]);
  });

  it('suggests stopping at 60 and shows the ages then', () => {
    renderEditor();
    type("Alex's birth year", '1994');
    expect(screen.getByLabelText('Stop working in').getAttribute('placeholder')).toBe('2054');
    expect(screen.getByText('Assumed until you choose a year · Alex 60')).toBeTruthy();
    type('Stop working in', '2044');
    expect(screen.getByText('Alex 50')).toBeTruthy();
  });

  // Planning audit, 1.3: it wrote the suggested year, which then read as chosen.
  it('leaves a stop year left blank unsaved', async () => {
    const { onSaved } = renderEditor();
    type("Alex's birth year", '1994');
    type('Age to plan Alex to', '80');
    fireEvent.click(screen.getByText('Save plan'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const assumptions = calls.upserts.find((c) => c.table === 'planning_assumptions');
    expect(assumptions.row.retirement_year).toBeNull();
  });

  it('saves the ages and the plan together', async () => {
    const { onSaved } = renderEditor();
    type("Alex's birth year", '1994');
    type('Age to plan Alex to', '80');
    type("Sam's birth year", '1994');
    type('Age to plan Sam to', '85');
    type('Stop working in', '2054');
    type('Spending a year after work stops', '61000');
    type('Spending once one person remains', '50');
    fireEvent.click(screen.getByText('Save plan'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const byTable = Object.fromEntries(calls.upserts.map((c) => [c.table, c]));
    expect(byTable.member_life.row).toEqual([
      expect.objectContaining({ member_id: 'm1', household_id: 'h', birth_year: 1994, life_expectancy: 80 }),
      expect.objectContaining({ member_id: 'm2', household_id: 'h', birth_year: 1994, life_expectancy: 85 }),
    ]);
    expect(byTable.member_life.options).toEqual({ onConflict: 'member_id' });
    expect(byTable.planning_assumptions.row).toEqual(
      expect.objectContaining({ household_id: 'h', retirement_year: 2054, retirement_annual_spend: 61000, retirement_return_pct: null, survivor_spend_pct: 50, lean_annual_spend: null }),
    );
    // The growth figures were left alone, so they are not written, and the
    // defaults do not become the household's choice.
    expect(byTable.planning_assumptions.row).not.toHaveProperty('nominal_return_pct');
    expect(byTable.planning_assumptions.row).not.toHaveProperty('assumptions_saved_at');
    expect(calls.deletes).toEqual([]);
  });

  it('takes a person out of the plan when their fields are cleared', async () => {
    const memberLife = [
      { member_id: 'm1', birth_year: 1994, life_expectancy: 80 },
      { member_id: 'm2', birth_year: 1994, life_expectancy: 85 },
    ];
    const { onSaved } = renderEditor({ memberLife, assumptions: { retirement_year: 2054 } });
    type("Sam's birth year", '');
    type('Age to plan Sam to', '');
    fireEvent.click(screen.getByText('Save plan'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.deletes).toEqual([{ table: 'member_life', column: 'member_id', values: ['m2'] }]);
  });

  it('refuses a plan that would already have ended', () => {
    renderEditor();
    type("Alex's birth year", '1930');
    type('Age to plan Alex to', '80');
    fireEvent.click(screen.getByText('Save plan'));
    expect(screen.getByRole('alert').textContent).toMatch(/already have ended/);
  });
});

describe('LifePlanEditor: spending that stops', () => {
  const categories = [
    { id: 'rent', name: 'Rent', kind: 'expense' },
    { id: 'emi', name: 'Car EMI', kind: 'expense', stops_after_work: true },
    { id: 'food', name: 'Groceries', kind: 'expense' },
    { id: 'save', name: 'Savings & Investments', kind: 'expense', is_savings: true },
  ];
  const spendByCategory = new Map([
    ['rent', 70200],
    ['emi', 26316],
    ['food', 24000],
  ]);
  const memberLife = [{ member_id: 'm1', birth_year: 1994, life_expectancy: 80 }];

  it('lists spending categories by size, hints at the usual ones, and saves only what changed', async () => {
    const { onSaved } = renderEditor({ categories, spendByCategory, memberLife });
    const labels = [...document.querySelectorAll('.lp-stop-list label')].map((l) => l.textContent);
    expect(labels).toEqual(['Rent70,200 a year· often stops', 'Car EMI26,316 a year', 'Groceries24,000 a year']);
    fireEvent.click(screen.getByLabelText(/^Rent/));
    fireEvent.click(screen.getByText('Save plan'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.updates).toEqual([{ table: 'categories', patch: { stops_after_work: true }, value: 'rent' }]);
  });
});

// Planning audit, 3.13: Forecast's assumptions joined this drawer. A cleared
// field was saved as 0%, and any number was stored as typed, with nothing in
// the database to stop either (0b-C).
describe('LifePlanEditor: growth, on Baseline', () => {
  const SAVED = { household_id: 'h', nominal_return_pct: 7, inflation_pct: 3, safe_withdrawal_pct: 4, lean_annual_spend: null, baseline_set_at: '2026-09-01T00:00:00Z' };
  const memberLife = [{ member_id: 'm1', birth_year: 1994, life_expectancy: 90 }];
  const input = (label) => screen.getByLabelText(label);
  const RETURN = 'Investment return, nominal percent a year';
  const INFLATION = 'Inflation, percent a year';
  const WITHDRAWAL = 'Safe withdrawal rate, percent a year';
  const LEAN = 'Essentials-only annual spend';
  const AFTER = 'Return after work stops';
  const saved = () => calls.upserts.find((c) => c.table === 'planning_assumptions').row;

  it('saves what was typed, and on the first change makes it the baseline, with the budget\'s savings target', async () => {
    const { onSaved } = renderEditor({ memberLife, assumptions: null, budgetMonthlySaving: 5000 });
    expect(screen.getByText(/your budget's savings target of 5,000 a month/)).toBeTruthy();
    expect(input(RETURN).value).toBe('6');
    type(RETURN, '7.5');
    fireEvent.click(screen.getByText('Save plan'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(saved()).toMatchObject({
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
    expect(saved().assumptions_saved_at).toEqual(expect.any(String));
  });

  // Planning audit, 1.2: it froze the recorded average, months recorded only
  // in part included.
  it('takes no baseline while the budget has no savings target', async () => {
    const { onSaved } = renderEditor({ memberLife, assumptions: null, budgetMonthlySaving: null });
    expect(screen.getByText(/No baseline is set yet\. It takes your budget's savings target, and the budget has none/)).toBeTruthy();
    type(RETURN, '6.5');
    fireEvent.click(screen.getByText('Save plan'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(saved()).toMatchObject({ nominal_return_pct: 6.5, inflation_pct: 2.5 });
    expect(saved()).not.toHaveProperty('baseline_set_at');
    expect(saved()).not.toHaveProperty('baseline_monthly_saving');
  });

  it('saves a cleared field as the default its placeholder names, never 0', async () => {
    const { onSaved } = renderEditor({ memberLife, assumptions: SAVED });
    type(INFLATION, '');
    type(WITHDRAWAL, '');
    expect(input(INFLATION).placeholder).toBe('blank: 2.5');
    fireEvent.click(screen.getByText('Save plan'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(saved()).toMatchObject({ nominal_return_pct: 7, inflation_pct: 2.5, safe_withdrawal_pct: 4 });
    // Saved before, so the baseline stays where it was.
    expect(saved()).not.toHaveProperty('baseline_set_at');
  });

  it('keeps 0% when 0 is what was typed, and saves the essentials-only spend', async () => {
    const { onSaved } = renderEditor({ memberLife, assumptions: SAVED });
    type(INFLATION, '0');
    type(LEAN, '40000');
    fireEvent.click(screen.getByText('Save plan'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(saved()).toMatchObject({ inflation_pct: 0, lean_annual_spend: 40000 });
  });

  it('refuses figures out of range, marks each, and saves nothing', () => {
    renderEditor({ memberLife, assumptions: SAVED });
    type(RETURN, '-40');
    type(INFLATION, '-100');
    type(WITHDRAWAL, '0');
    type(LEAN, '-1');
    type(AFTER, '60');
    fireEvent.click(screen.getByText('Save plan'));
    // The first problem in the drawer, by the Save button; each beside its field.
    expect(screen.getByRole('alert').textContent).toBe('Essentials-only spend is an amount above zero.');
    expect(screen.getAllByText('Essentials-only spend is an amount above zero.')).toHaveLength(2);
    expect(screen.getByText('A return between −20% and 50%.')).toBeTruthy();
    expect(screen.getByText('Inflation between −10% and 30%.')).toBeTruthy();
    expect(screen.getByText('A withdrawal rate between 1% and 10%.')).toBeTruthy();
    expect(screen.getByText('A return after work stops between −20% and 50%.')).toBeTruthy();
    expect(input(RETURN).getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(input(LEAN));
    expect(calls.upserts).toEqual([]);
  });

  it('takes the message away as the field is corrected', () => {
    renderEditor({ memberLife, assumptions: SAVED });
    type(RETURN, '60');
    fireEvent.click(screen.getByText('Save plan'));
    expect(screen.getAllByText('A return between −20% and 50%.')).toHaveLength(2);
    type(RETURN, '8');
    expect(screen.getByRole('alert').textContent).toBe('A return between −20% and 50%.');
    expect(document.querySelector('.te-fieldproblem')).toBeNull();
    expect(input(RETURN).getAttribute('aria-invalid')).toBe('false');
  });

  it('says the return after work stops is a point below the working return until one is set', () => {
    renderEditor({ memberLife, assumptions: SAVED });
    expect(input(AFTER).placeholder).toBe('blank: 6.0, a point below');
    type(RETURN, '9');
    expect(input(AFTER).placeholder).toBe('blank: 8.0, a point below');
  });
});

describe('LifePlanEditor: growth, on the Custom scenario', () => {
  const SAVED = { household_id: 'h', nominal_return_pct: 7, inflation_pct: 3, safe_withdrawal_pct: 4, baseline_set_at: '2026-09-01T00:00:00Z' };
  const memberLife = [{ member_id: 'm1', birth_year: 1994, life_expectancy: 90 }];
  const input = (label) => screen.getByLabelText(label);

  it('starts from Baseline, and a cleared field keeps following it', async () => {
    const { onSaved } = renderEditor({ memberLife, assumptions: SAVED, scenario: 'custom' });
    expect(screen.getByText('Growth · Custom scenario')).toBeTruthy();
    expect(input('Investment return, nominal percent a year').value).toBe('7');
    type('Investment return, nominal percent a year', '9');
    type('Inflation, percent a year', '');
    expect(input('Inflation, percent a year').placeholder).toBe("blank: Baseline's 3.0");
    fireEvent.click(screen.getByText('Save plan'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const row = calls.upserts.find((c) => c.table === 'planning_assumptions').row;
    expect(row).toMatchObject({ household_id: 'h', custom_nominal_return_pct: 9, custom_inflation_pct: null, custom_safe_withdrawal_pct: 4 });
    expect(row.custom_updated_at).toBeTruthy();
    // Custom never writes Baseline's columns, or says Baseline was chosen.
    expect(row).not.toHaveProperty('assumptions_saved_at');
    expect(row).not.toHaveProperty('nominal_return_pct');
    expect(row).not.toHaveProperty('inflation_pct');
  });

  it('opens on its own saved figures, and a figure saved blank opens blank', () => {
    renderEditor({
      memberLife,
      scenario: 'custom',
      assumptions: { ...SAVED, custom_nominal_return_pct: 5.5, custom_inflation_pct: null, custom_safe_withdrawal_pct: 3.5, custom_updated_at: '2026-09-02T00:00:00Z' },
    });
    expect(input('Investment return, nominal percent a year').value).toBe('5.5');
    expect(input('Inflation, percent a year').value).toBe('');
    expect(input('Inflation, percent a year').placeholder).toBe("blank: Baseline's 3.0");
    expect(input('Safe withdrawal rate, percent a year').value).toBe('3.5');
  });
});

// Drawdown's other income joined this drawer, beside the costs that start
// when work stops (3.13). Each opens in a drawer over this one.
describe('LifePlanEditor: other income and costs after work', () => {
  const costs = [{ id: 'c1', name: 'Health cover', amount: 8000, currency: 'AED', per_person: true, rise_pct: 3, starts_after_years: 0, lasts_years: null }];
  const incomes = [{ id: 'i1', name: 'Flat rent', kind: 'yearly', amount: 24000, currency: 'AED', starts_after_years: 0, lasts_years: null }];

  it('lists both, each with what it is', () => {
    renderEditor({ costs, incomes });
    expect(screen.getByText('Health cover')).toBeTruthy();
    expect(screen.getByText('Each person · rising 3% a year above inflation · from the year work stops, for good')).toBeTruthy();
    expect(screen.getByText('Flat rent')).toBeTruthy();
    expect(screen.getByText('From the first year, for good · lowers the target')).toBeTruthy();
  });

  it('adds a cost in a drawer over the plan, and comes back to the plan', async () => {
    const onRowsChanged = vi.fn();
    renderEditor({ costs: [], incomes, onRowsChanged });
    expect(screen.getByText(/None added\. Health cover an employer pays until then/)).toBeTruthy();
    fireEvent.click(screen.getByText('+ Cost'));
    expect(screen.getByRole('dialog', { name: 'Add cost' })).toBeTruthy();
    // Escape closes the drawer on top, and the plan stays open.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Add cost' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Life plan' })).toBeTruthy();
    fireEvent.click(screen.getByText('+ Cost'));
    fireEvent.change(screen.getByLabelText('Amount a year'), { target: { value: '2000' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Visa fees' } });
    fireEvent.click(screen.getByText('Add cost'));
    await waitFor(() => expect(onRowsChanged).toHaveBeenCalled());
    expect(calls.inserts).toEqual([{ table: 'after_work_costs', row: expect.objectContaining({ household_id: 'h', name: 'Visa fees', amount: 2000, per_person: false, rise_pct: 0 }) }]);
    expect(screen.queryByRole('dialog', { name: 'Add cost' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Life plan' })).toBeTruthy();
  });

  it('opens an income to edit it', () => {
    renderEditor({ incomes });
    fireEvent.click(screen.getByText('Flat rent'));
    expect(screen.getByRole('dialog', { name: 'Edit income' })).toBeTruthy();
  });

  it('starts at the part it was opened for', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderEditor({ section: 'growth' });
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0].textContent).toBe('Growth');
    delete Element.prototype.scrollIntoView;
  });
});
