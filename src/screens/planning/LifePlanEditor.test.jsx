import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import LifePlanEditor from './LifePlanEditor';

const calls = vi.hoisted(() => ({ upserts: [], deletes: [] }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      upsert: async (row, options) => {
        calls.upserts.push({ table, row, options });
        return { error: null };
      },
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
  { id: 'm1', display_name: 'Shreyash' },
  { id: 'm2', display_name: 'Tarika' },
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
});

describe('LifePlanEditor', () => {
  it('needs a birth year and an age for at least one person', () => {
    renderEditor();
    fireEvent.click(screen.getByText('Save plan'));
    expect(screen.getByRole('alert').textContent).toMatch(/at least one person/);
    type("Shreyash's birth year", '1994');
    fireEvent.click(screen.getByText('Save plan'));
    expect(screen.getByRole('alert').textContent).toBe('Plan Shreyash to an age between 40 and 120.');
    expect(calls.upserts).toEqual([]);
  });

  it('suggests stopping at 60 and shows the ages then', () => {
    renderEditor();
    type("Shreyash's birth year", '1994');
    expect(screen.getByLabelText('Stop working in').getAttribute('placeholder')).toBe('2054');
    type('Stop working in', '2044');
    expect(screen.getByText('Shreyash 50')).toBeTruthy();
  });

  it('saves the ages and the plan together', async () => {
    const { onSaved } = renderEditor();
    type("Shreyash's birth year", '1994');
    type('Age to plan Shreyash to', '80');
    type("Tarika's birth year", '1994');
    type('Age to plan Tarika to', '85');
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
      expect.objectContaining({ household_id: 'h', retirement_year: 2054, retirement_annual_spend: 61000, retirement_return_pct: null, survivor_spend_pct: 50 }),
    );
    expect(calls.deletes).toEqual([]);
  });

  it('takes a person out of the plan when their fields are cleared', async () => {
    const memberLife = [
      { member_id: 'm1', birth_year: 1994, life_expectancy: 80 },
      { member_id: 'm2', birth_year: 1994, life_expectancy: 85 },
    ];
    const { onSaved } = renderEditor({ memberLife, assumptions: { retirement_year: 2054 } });
    type("Tarika's birth year", '');
    type('Age to plan Tarika to', '');
    fireEvent.click(screen.getByText('Save plan'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.deletes).toEqual([{ table: 'member_life', column: 'member_id', values: ['m2'] }]);
  });

  it('refuses a plan that would already have ended', () => {
    renderEditor();
    type("Shreyash's birth year", '1930');
    type('Age to plan Shreyash to', '80');
    fireEvent.click(screen.getByText('Save plan'));
    expect(screen.getByRole('alert').textContent).toMatch(/already have ended/);
  });
});
