import { describe, expect, it } from 'vitest';
import { fileableCategories, needsSubcategory } from './fileableCategories.js';

const tree = [
  { id: 'food', name: 'Food & Dining', kind: 'expense', parent_id: null, archived: false, is_savings: false },
  { id: 'out', name: 'Eating Out', kind: 'expense', parent_id: 'food', archived: false, is_savings: false },
  { id: 'deliv', name: 'Food Delivery', kind: 'expense', parent_id: 'food', archived: false, is_savings: false },
  { id: 'shop', name: 'Shopping', kind: 'expense', parent_id: null, archived: false, is_savings: false },
  { id: 'old', name: 'Old', kind: 'expense', parent_id: 'shop', archived: true, is_savings: false },
  { id: 'save', name: 'Savings', kind: 'expense', parent_id: null, archived: false, is_savings: true },
  { id: 'pay', name: 'Salary', kind: 'income', parent_id: null, archived: false, is_savings: false },
];

describe('fileableCategories', () => {
  it('leaves out a group with categories within it, savings and archived ones, and names each with its group', () => {
    expect(fileableCategories(tree).map((c) => c.label)).toEqual(['Food & Dining › Eating Out', 'Food & Dining › Food Delivery', 'Shopping', 'Salary']);
  });

  it('can be limited to one kind', () => {
    expect(fileableCategories(tree, 'income').map((c) => c.id)).toEqual(['pay']);
  });

  it('keeps the one already chosen, even a group, so an old record still shows it', () => {
    expect(fileableCategories(tree, 'expense', 'food').map((c) => c.id)).toEqual(['food', 'out', 'deliv', 'shop']);
  });
});

describe('needsSubcategory', () => {
  it('is true only for a group with active categories within it', () => {
    expect(needsSubcategory(tree, 'food')).toBe(true);
    expect(needsSubcategory(tree, 'shop')).toBe(false);
    expect(needsSubcategory(tree, 'out')).toBe(false);
    expect(needsSubcategory(tree, '')).toBe(false);
  });
});
