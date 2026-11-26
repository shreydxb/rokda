import { describe, it, expect } from 'vitest';
import { categoryTable, groupChoices } from './categoryTable';

const cat = (id, name, extra = {}) => ({ id, name, kind: 'expense', parent_id: null, archived: false, is_savings: false, stops_after_work: false, owner_member_id: null, ...extra });

const CATS = [
  cat('inc', 'Salary', { kind: 'income' }),
  cat('home', 'Housing'),
  cat('rent', 'Rent', { parent_id: 'home', stops_after_work: true }),
  cat('util', 'Utilities', { parent_id: 'home' }),
  cat('food', 'Food'),
  cat('groc', 'Groceries', { parent_id: 'food' }),
  cat('old', 'Old snacks', { parent_id: 'food', archived: true }),
  cat('gift', 'Gifts'),
  cat('save', 'Savings goals', { is_savings: true }),
  cat('emer', 'Emergency fund', { parent_id: 'save', is_savings: true }),
];

const BUDGETS = [
  { category_id: 'rent', year: 2026, month: 11, amount: 5000 },
  { category_id: 'rent', year: 2026, month: 10, amount: 4800 },
  { category_id: 'groc', year: 2026, month: 11, amount: 1200 },
];

// Settings -> Categories like the prototype (the revamp, phase 7b): Income,
// then each group of expense subcategories, then the ones in no group as
// Other, then Savings, with this month's budget beside each.
describe('categoryTable', () => {
  const table = categoryTable(CATS, BUDGETS, { year: 2026, month: 11 });

  it('groups as the prototype does', () => {
    expect(table.groups.map((g) => [g.title, g.group?.id ?? null, g.rows.map((r) => r.category.id)])).toEqual([
      ['Income', null, ['inc']],
      ['Housing', 'home', ['rent', 'util']],
      ['Food', 'food', ['groc']],
      ['Other', null, ['gift']],
      ['Savings goals', 'save', ['emer']],
    ]);
  });

  it("gives each row this month's budget, and none for another month's", () => {
    const rows = table.groups.flatMap((g) => g.rows);
    expect(rows.find((r) => r.category.id === 'rent').budget).toBe(5000);
    expect(rows.find((r) => r.category.id === 'groc').budget).toBe(1200);
    expect(rows.find((r) => r.category.id === 'util').budget).toBeNull();
  });

  it('sets archived categories apart, and counts the rest and their groups', () => {
    expect(table.archived.map((c) => c.id)).toEqual(['old']);
    expect(table.count).toBe(6);
    expect(table.groupCount).toBe(5);
  });

  it('keeps a subcategory whose group is archived in view, under Other', () => {
    const t = categoryTable([cat('food', 'Food', { archived: true }), cat('groc', 'Groceries', { parent_id: 'food' })], [], { year: 2026, month: 11 });
    expect(t.groups.map((g) => [g.title, g.rows.map((r) => r.category.id)])).toEqual([['Other', ['groc']]]);
    expect(t.archived.map((c) => c.id)).toEqual(['food']);
  });

  it('leaves out a group with nothing in it', () => {
    expect(categoryTable([], [], { year: 2026, month: 11 }).groups).toEqual([]);
  });

  // The fresh review of 7b.
  const placed = (t) => t.groups.flatMap((g) => [...(g.group ? [g.group.id] : []), ...g.rows.map((r) => r.category.id)]);

  it('keeps a group in view when its kind changes, with all its subcategories', () => {
    const cats = [cat('home', 'Housing', { kind: 'income' }), cat('rent', 'Rent', { parent_id: 'home' }), cat('gift', 'Gifts')];
    const t = categoryTable(cats, [], { year: 2026, month: 11 });
    expect(t.groups.map((g) => [g.title, g.group?.id ?? null, g.rows.map((r) => r.category.id)])).toEqual([
      ['Housing', 'home', ['rent']],
      ['Other', null, ['gift']],
    ]);
  });

  it('shows every category in view exactly once', () => {
    const cats = [...CATS, cat('bonus', 'Bonus', { kind: 'income', parent_id: 'home' }), cat('side', 'Side work', { kind: 'income' }), cat('tips', 'Tips', { kind: 'income', parent_id: 'side' })];
    const t = categoryTable(cats, [], { year: 2026, month: 11 });
    const ids = placed(t);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(cats.filter((c) => !c.archived).map((c) => c.id).sort());
  });

  it("gives a group heading its own budget, and whose cost each row really is", () => {
    const cats = [cat('car', 'Car', { owner_member_id: 'm2' }), cat('fuel', 'Fuel', { parent_id: 'car' }), cat('ins', 'Insurance', { parent_id: 'car', owner_member_id: 'm1' })];
    const t = categoryTable(cats, [{ category_id: 'car', year: 2026, month: 11, amount: 900 }], { year: 2026, month: 11 });
    expect(t.groups[0].budget).toBe(900);
    expect(t.groups[0].rows.map((r) => [r.category.id, r.owner, r.ownerFromGroup])).toEqual([
      ['fuel', 'm2', true],
      ['ins', 'm1', false],
    ]);
    expect(t.groups[0].rows[0].groupName).toBe('Car');
  });

  // The review of the whole revamp: under Other, its owner's group was named
  // "Other".
  it('names an archived group a row takes its owner from', () => {
    const cats = [cat('car', 'Car', { owner_member_id: 'm2', archived: true }), cat('fuel', 'Fuel', { parent_id: 'car' })];
    const t = categoryTable(cats, [], { year: 2026, month: 11 });
    const fuel = t.groups.flatMap((g) => g.rows).find((r) => r.category.id === 'fuel');
    expect([fuel.ownerFromGroup, fuel.groupName]).toEqual([true, 'Car (archived)']);
  });
});

// A category's group is one that already is a group, or none: a record is
// filed under a category with no subcategories, so making a category that
// holds records into a group would strand them (the revamp, phase 7b).
describe('groupChoices', () => {
  it('offers the groups of its kind, savings or not', () => {
    expect(groupChoices(CATS, cat('x', 'New')).map((c) => c.id)).toEqual(['home', 'food']);
    expect(groupChoices(CATS, cat('x', 'New', { is_savings: true })).map((c) => c.id)).toEqual(['save']);
    expect(groupChoices(CATS, cat('x', 'New', { kind: 'income' }))).toEqual([]);
  });

  it('offers no group to a category that is a group itself', () => {
    expect(groupChoices(CATS, CATS.find((c) => c.id === 'food'))).toEqual([]);
  });

  // The fresh review of 7b: a category whose subcategories are all archived
  // is filed under itself (lib/fileableCategories.js), so it holds records.
  it('does not offer a category whose subcategories are all archived', () => {
    const cats = [cat('food', 'Food'), cat('old', 'Old snacks', { parent_id: 'food', archived: true }), cat('home', 'Housing'), cat('rent', 'Rent', { parent_id: 'home' })];
    expect(groupChoices(cats, cat('x', 'New')).map((c) => c.id)).toEqual(['home']);
    expect(groupChoices(cats, cats[0]).map((c) => c.id)).toEqual(['home']);
  });
});
