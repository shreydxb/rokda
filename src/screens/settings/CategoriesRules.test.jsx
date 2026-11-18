import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderScreen } from '../../test/renderScreen';
import { householdYearMonth } from '../../lib/day';

const calls = vi.hoisted(() => ({ updates: [], inserts: [], applied: [] }));
vi.mock('../../lib/supabaseClient', () => {
  // Apply: an update filtered down to uncategorised rows, read back.
  const apply = (row) => {
    const c = {
      eq: () => c,
      is: () => c,
      neq: () => c,
      ilike: (col, pattern) => {
        calls.applied.push({ row, pattern });
        return c;
      },
      select: async () => ({ data: [{ id: 't1' }, { id: 't2' }], error: null }),
      then: (resolve) => {
        calls.updates.push(row);
        resolve({ error: null });
      },
    };
    return c;
  };
  return {
    supabase: {
      from: (table) => ({
        update: (row) => (table === 'transactions' ? apply(row) : { eq: async (col, id) => (calls.updates.push({ table, row, id }), { error: null }) }),
        insert: async (row) => (calls.inserts.push({ table, row }), { error: null }),
        delete: () => ({ eq: async () => ({ error: null }) }),
      }),
    },
  };
});

const { default: CategoriesRules } = await import('./CategoriesRules');

beforeEach(() => {
  calls.updates.length = 0;
  calls.inserts.length = 0;
  calls.applied.length = 0;
});

const { year, month } = householdYearMonth();
const cat = (id, name, extra = {}) => ({ id, name, kind: 'expense', parent_id: null, archived: false, is_savings: false, stops_after_work: false, owner_member_id: null, ...extra });
const CATEGORIES = [
  cat('c-salary', 'Salary', { kind: 'income' }),
  cat('c-food', 'Food'),
  cat('c-groceries', 'Groceries', { parent_id: 'c-food' }),
  cat('c-dining', 'Dining out', { parent_id: 'c-food', owner_member_id: 'm2' }),
  cat('c-rent', 'Rent', { stops_after_work: true }),
  cat('c-old', 'Old hobby', { archived: true }),
  cat('c-save', 'Savings goals', { is_savings: true }),
  cat('c-fund', 'Emergency fund', { parent_id: 'c-save', is_savings: true }),
];
const BUDGETS = [{ category_id: 'c-groceries', year, month, amount: 1200 }];
const RULES = [
  { id: 'r1', pattern: 'corner', match_type: 'contains', category_id: 'c-dining', archived: false },
  { id: 'r2', pattern: 'old shop', match_type: 'starts_with', category_id: 'c-groceries', archived: true },
];
const MEMBERS = [
  { id: 'm1', display_name: 'Alex' },
  { id: 'm2', display_name: 'Sam' },
];

function LocationProbe() {
  return <output data-testid="location">{useLocation().search}</output>;
}

function renderAt(url = '/settings?tab=categories', { categories = CATEGORIES, rules = RULES, reload = vi.fn() } = {}) {
  renderScreen(
    <MemoryRouter initialEntries={[url]}>
      <LocationProbe />
      <CategoriesRules household={{ id: 'hh' }} members={MEMBERS} loading={false} data={{ categories, categoryRules: rules, budgets: BUDGETS, reload }} />
    </MemoryRouter>,
  );
  return { reload };
}
const categoriesCard = () => screen.getByRole('region', { name: 'Categories' });
const rulesCard = () => screen.getByRole('region', { name: 'Merchant rules' });
const drawer = () => screen.getByRole('dialog');

// Settings -> Categories & rules like the prototype (the revamp, phase 7b).
describe('Categories: the table', () => {
  it('groups them as the prototype does, with whose cost, this month’s budget and chips', () => {
    renderAt();
    const table = within(categoriesCard()).getByRole('table');
    const rows = within(table).getAllByRole('row').slice(1).map((r) => [...r.querySelectorAll('th, td')].map((c) => c.textContent));
    expect(rows).toEqual([
      ['Income'],
      ['Salary', 'Shared', '—', ''],
      ['Food'],
      ['Groceries', 'Shared', '1,200', ''],
      ['Dining out', 'SSam', '—', ''],
      ['Other'],
      ['Rent', 'Shared', '—', 'Stops with work'],
      ['Savings goals'],
      ['Emergency fund', 'Shared', '—', 'Savings'],
    ]);
    expect(within(categoriesCard()).getByText('5 in 4 groups')).toBeTruthy();
  });

  it('folds the archived ones at the foot', () => {
    renderAt();
    const fold = within(categoriesCard()).getByText('Archived (1)').closest('details');
    expect(fold.open).toBe(false);
    expect(within(fold).getByRole('button', { name: 'Old hobby' })).toBeTruthy();
  });

  it('opens a category, and a group, from its name', () => {
    renderAt();
    fireEvent.click(within(categoriesCard()).getByRole('button', { name: 'Groceries' }));
    expect(screen.getByRole('dialog', { name: 'Groceries' })).toBeTruthy();
  });

  it('opens a group from its heading', () => {
    renderAt();
    fireEvent.click(within(categoriesCard()).getByRole('button', { name: 'Food' }));
    expect(screen.getByRole('dialog', { name: 'Food' })).toBeTruthy();
  });

  it('puts + Rule and + Category in the header, and the starter set at the foot', () => {
    renderAt();
    expect(screen.getByRole('button', { name: '+ Category' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ Rule' })).toBeTruthy();
    expect(within(categoriesCard()).getByRole('button', { name: 'Starter set' })).toBeTruthy();
  });

  it('offers the starter set when there are no categories', () => {
    renderAt('/settings?tab=categories', { categories: [], rules: [] });
    expect(screen.getByText('No categories yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ Rule' }).disabled).toBe(true);
    fireEvent.click(within(categoriesCard()).getByRole('button', { name: 'Starter set' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('Merchant rules', () => {
  it('lists each rule as when the merchant, file under, and Apply on an active one', () => {
    renderAt();
    const rows = within(rulesCard()).getAllByRole('row').slice(1);
    expect(rows.map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent))).toEqual([
      ['contains corner', 'Dining out', 'Apply'],
      ['starts with old shopOff', 'Groceries', ''],
    ]);
    expect(within(rulesCard()).getByText('1 active')).toBeTruthy();
  });

  it('applies a rule to uncategorised transactions and says how many', async () => {
    const { reload } = renderAt();
    await act(async () => fireEvent.click(within(rulesCard()).getByRole('button', { name: 'Apply contains corner' })));
    expect(calls.applied[0].row).toEqual({ category_id: 'c-dining' });
    expect(within(rulesCard()).getByRole('status').textContent).toBe('Applied to 2 uncategorised transactions.');
    expect(reload).toHaveBeenCalled();
  });

  it('says there are none yet, with + Rule', () => {
    renderAt('/settings?tab=categories', { rules: [] });
    expect(within(rulesCard()).getByText('No rules yet')).toBeTruthy();
  });
});

// "Open that rule in Settings", from a transaction's editor, and "See the rule
// in Settings", from Activity, open Settings at one rule.
describe('A link to one rule', () => {
  it('opens that rule’s drawer', () => {
    renderAt('/settings?tab=categories&rule=r1');
    expect(screen.getByRole('dialog', { name: 'Contains “corner”' })).toBeTruthy();
    expect(within(drawer()).getByLabelText('Merchant pattern').value).toBe('corner');
  });

  it('takes the rule out of the address once closed, keeping the tab', () => {
    renderAt('/settings?tab=categories&rule=r1');
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('location').textContent).toBe('?tab=categories');
  });

  it('opens an archived rule as it is, switched off', () => {
    renderAt('/settings?tab=categories&rule=r2');
    expect(within(drawer()).getByRole('switch', { name: 'Active' }).getAttribute('aria-checked')).toBe('false');
  });

  it('opens nothing for a rule that no longer exists', () => {
    renderAt('/settings?tab=categories&rule=gone');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(rulesCard()).getByText('corner')).toBeTruthy();
  });
});

describe('The rule drawer', () => {
  it('saves its match, pattern, category and whether it is active, together', async () => {
    renderAt('/settings?tab=categories&rule=r1');
    fireEvent.click(within(within(drawer()).getByRole('group', { name: 'Match' })).getByRole('button', { name: 'Starts with' }));
    fireEvent.change(within(drawer()).getByLabelText('Merchant pattern'), { target: { value: 'corner cafe' } });
    fireEvent.click(within(drawer()).getByRole('switch', { name: 'Active' }));
    await act(async () => fireEvent.click(within(drawer()).getByRole('button', { name: 'Save' })));
    expect(calls.updates.at(-1)).toEqual({ table: 'category_rules', row: { pattern: 'corner cafe', match_type: 'starts_with', category_id: 'c-dining', archived: true }, id: 'r1' });
  });

  it('adds a rule', async () => {
    renderAt();
    fireEvent.click(screen.getByRole('button', { name: '+ Rule' }));
    expect(screen.getByRole('dialog', { name: 'Add a rule' })).toBeTruthy();
    fireEvent.change(within(drawer()).getByLabelText('Merchant pattern'), { target: { value: 'bakery' } });
    fireEvent.change(within(drawer()).getByLabelText('Category'), { target: { value: 'c-groceries' } });
    await act(async () => fireEvent.click(within(drawer()).getByRole('button', { name: 'Add rule' })));
    expect(calls.inserts.at(-1)).toEqual({ table: 'category_rules', row: { pattern: 'bakery', match_type: 'contains', category_id: 'c-groceries', archived: false, household_id: 'hh' } });
  });
});
