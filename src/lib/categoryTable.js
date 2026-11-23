// Settings -> Categories like the prototype (the revamp, phase 7b; design
// note docs/superpowers/specs/2026-11-18-settings-design.md): the categories
// as one table, grouped as the prototype groups them. Income first, then each
// group of expense subcategories, then the expense categories in no group as
// Other, then each group of savings and any savings in no group. Archived
// categories are set apart, for a fold at the foot.

import { categoryOwner } from './share';

// A group is a category with a subcategory in use, as the pickers count it
// (lib/fileableCategories.js): one whose subcategories are all archived is
// filed under itself.
const hasActiveChildren = (categories, id) => categories.some((c) => c.parent_id === id && !c.archived);

// The table's groups, each { title, group (the category heading it, or
// null), budget (the group's own this month, or null), rows: [{ category,
// budget, owner, ownerFromGroup }] }, the archived categories, and how many
// categories and groups are shown. Every category in view is either a group's
// heading or one row, once: a subcategory sits under its group whatever its
// own kind (the fresh review of 7b).
export function categoryTable(categories = [], budgets = [], { year, month }) {
  const active = categories.filter((c) => !c.archived);
  const activeIds = new Set(active.map((c) => c.id));
  const byId = new Map(categories.map((c) => [c.id, c]));
  // A subcategory whose group is archived stays in view, as a category in no
  // group.
  const parentOf = (c) => (c.parent_id && activeIds.has(c.parent_id) ? c.parent_id : null);
  const isGroup = (c) => !parentOf(c) && active.some((k) => parentOf(k) === c.id);
  const budgetOf = (id) => {
    const rows = budgets.filter((b) => b.category_id === id && b.year === year && b.month === month);
    return rows.length ? rows.reduce((sum, b) => sum + Number(b.amount ?? 0), 0) : null;
  };
  // Whose cost a row is: its own owner, or its group's when it has none, as
  // the split and the budget read it (lib/share.js categoryOwner).
  const row = (c) => {
    const owner = categoryOwner(c.id, byId);
    return { category: c, budget: budgetOf(c.id), owner, ownerFromGroup: Boolean(owner && !c.owner_member_id) };
  };
  const childrenOf = (id) => active.filter((k) => parentOf(k) === id);

  const groups = [];
  const addGroup = (g) => groups.push({ title: g.name, group: g, budget: budgetOf(g.id), rows: childrenOf(g.id).map(row) });
  const addLoose = (title, list) => {
    if (list.length) groups.push({ title, group: null, budget: null, rows: list.map(row) });
  };

  const top = active.filter((c) => !parentOf(c));
  const income = top.filter((c) => c.kind === 'income');
  const spending = top.filter((c) => c.kind !== 'income' && !c.is_savings);
  const savings = top.filter((c) => c.kind !== 'income' && c.is_savings);
  addLoose('Income', income.filter((c) => !isGroup(c)));
  income.filter(isGroup).forEach(addGroup);
  spending.filter(isGroup).forEach(addGroup);
  addLoose('Other', spending.filter((c) => !isGroup(c)));
  savings.filter(isGroup).forEach(addGroup);
  addLoose('Savings', savings.filter((c) => !isGroup(c)));

  return {
    groups,
    archived: categories.filter((c) => c.archived),
    count: groups.reduce((n, g) => n + g.rows.length, 0),
    groupCount: groups.length,
  };
}

// The groups a category may sit in: those that already are groups, of its
// kind and its savings-or-not, or none. A record is filed under a category
// with no subcategories, so turning one that holds records into a group would
// strand them; a group can't sit in another group either.
export function groupChoices(categories = [], category) {
  if (category?.id && hasActiveChildren(categories, category.id)) return [];
  return categories.filter(
    (c) =>
      !c.parent_id &&
      !c.archived &&
      c.id !== category?.id &&
      (c.kind ?? 'expense') === (category?.kind ?? 'expense') &&
      Boolean(c.is_savings) === Boolean(category?.is_savings) &&
      hasActiveChildren(categories, c.id),
  );
}
