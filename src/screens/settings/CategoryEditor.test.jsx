import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, within, act } from '@testing-library/react';
import { renderScreen } from '../../test/renderScreen';

const calls = vi.hoisted(() => ({ updates: [], inserts: [] }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: () => ({
      update: (row) => ({ eq: async (col, id) => (calls.updates.push({ row, id }), { error: null }) }),
      insert: async (row) => (calls.inserts.push(row), { error: null }),
    }),
  },
}));

const { default: CategoryEditor } = await import('./CategoryEditor');

beforeEach(() => {
  calls.updates.length = 0;
  calls.inserts.length = 0;
});

const cat = (id, name, extra = {}) => ({ id, name, kind: 'expense', parent_id: null, archived: false, is_savings: false, stops_after_work: false, owner_member_id: null, ...extra });
const CATEGORIES = [
  cat('food', 'Food'),
  cat('groc', 'Groceries', { parent_id: 'food' }),
  cat('home', 'Housing'),
  cat('rent', 'Rent', { parent_id: 'home' }),
  cat('gift', 'Gifts'),
  cat('save', 'Savings goals', { is_savings: true }),
  cat('fund', 'Emergency fund', { parent_id: 'save', is_savings: true }),
];
const MEMBERS = [
  { id: 'm1', display_name: 'Alex' },
  { id: 'm2', display_name: 'Sam' },
];

function editor(category) {
  const onSaved = vi.fn();
  renderScreen(<CategoryEditor category={category} categories={CATEGORIES} householdId="hh" members={MEMBERS} onClose={vi.fn()} onSaved={onSaved} />);
  return { onSaved };
}
const drawer = () => screen.getByRole('dialog');
const options = (label) => [...within(drawer()).getByLabelText(label).querySelectorAll('option')].map((o) => o.textContent);
const save = () => act(async () => fireEvent.click(within(drawer()).getByRole('button', { name: /^(Save|Add category)$/ })));

// A category in the kit's drawer, like the prototype's (the revamp, phase
// 7b): name, kind, group, whose cost, and its switches, saved together.
describe('CategoryEditor', () => {
  it('offers the groups that already are groups, of its kind', () => {
    editor(CATEGORIES.find((c) => c.id === 'groc'));
    expect(screen.getByRole('dialog', { name: 'Groceries' })).toBeTruthy();
    expect(options('Group')).toEqual(['None', 'Food', 'Housing']);
    expect(within(drawer()).getByLabelText('Group').value).toBe('food');
  });

  it('moves a subcategory to another group', async () => {
    editor(CATEGORIES.find((c) => c.id === 'groc'));
    fireEvent.change(within(drawer()).getByLabelText('Group'), { target: { value: 'home' } });
    await save();
    expect(calls.updates[0]).toMatchObject({ id: 'groc', row: { parent_id: 'home' } });
  });

  it('offers a group no group to sit in', () => {
    editor(CATEGORIES.find((c) => c.id === 'food'));
    expect(within(drawer()).queryByLabelText('Group')).toBeNull();
  });

  // The fresh review of 7b: switching Savings on moved a subcategory out of
  // its group without a word. It keeps its group; the savings groups are
  // offered beside it.
  it('offers the savings groups to savings, and keeps the group it is in', () => {
    editor(CATEGORIES.find((c) => c.id === 'groc'));
    fireEvent.click(within(drawer()).getByRole('switch', { name: 'Savings, not spending' }));
    expect(options('Group')).toEqual(['None', 'Savings goals', 'Food']);
    expect(within(drawer()).getByLabelText('Group').value).toBe('food');
  });

  // The fresh review of 7b: a group whose kind changed left the table with
  // its subcategories. A group keeps its kind and its savings.
  it("keeps a group's kind and savings as they are", () => {
    editor(CATEGORIES.find((c) => c.id === 'food'));
    const kind = within(drawer()).getByRole('group', { name: 'Kind' });
    expect(within(kind).getByRole('button', { name: 'Income' }).disabled).toBe(true);
    expect(within(drawer()).getByRole('switch', { name: 'Savings, not spending' }).disabled).toBe(true);
    expect(within(drawer()).getByText("A group keeps its kind and savings; its subcategories follow it.")).toBeTruthy();
  });

  it('saves whose cost, the switches and archived with the rest', async () => {
    editor(CATEGORIES.find((c) => c.id === 'rent'));
    fireEvent.change(within(drawer()).getByLabelText('Whose cost'), { target: { value: 'm2' } });
    fireEvent.click(within(drawer()).getByRole('switch', { name: 'Stops when work stops' }));
    fireEvent.click(within(drawer()).getByRole('switch', { name: 'Archived' }));
    await save();
    expect(calls.updates[0]).toEqual({
      id: 'rent',
      row: { name: 'Rent', kind: 'expense', parent_id: 'home', is_savings: false, owner_member_id: 'm2', stops_after_work: true, archived: true },
    });
  });

  it('keeps income shared, and out of savings and of what stops with work', async () => {
    editor(null);
    fireEvent.change(within(drawer()).getByLabelText('Name'), { target: { value: 'Bonus' } });
    fireEvent.click(within(within(drawer()).getByRole('group', { name: 'Kind' })).getByRole('button', { name: 'Income' }));
    expect(within(drawer()).queryByRole('switch', { name: 'Savings, not spending' })).toBeNull();
    expect(within(drawer()).queryByLabelText('Whose cost')).toBeNull();
    await save();
    expect(calls.inserts[0]).toEqual({ name: 'Bonus', kind: 'income', parent_id: null, is_savings: false, owner_member_id: null, stops_after_work: false, household_id: 'hh' });
  });

  it('will not save without a name', async () => {
    editor(null);
    expect(screen.getByRole('dialog', { name: 'Add a category' })).toBeTruthy();
    await save();
    expect(within(drawer()).getByRole('alert').textContent).toBe('Name it.');
    expect(calls.inserts).toHaveLength(0);
  });
});
