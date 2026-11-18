// Settings -> Categories like the prototype (the revamp, phase 7b; design
// note docs/superpowers/specs/2026-11-18-settings-design.md): the categories
// as one table, grouped as the prototype groups them. Income first, then each
// group of expense subcategories, then the expense categories in no group as
// Other, then each group of savings and any savings in no group. Archived
// categories are set apart, for a fold at the foot.

const hasChildren = (categories, id) => categories.some((c) => c.parent_id === id);

// The table's groups, each { title, group (the category heading it, or
// null), rows: [{ category, budget }] }, with this month's budget beside each
// row (null when none), the archived categories, and how many categories and
// groups are shown.
export function categoryTable(categories = [], budgets = [], { year, month }) {
  const active = categories.filter((c) => !c.archived);
  const activeIds = new Set(active.map((c) => c.id));
  // A group is a category in view with a subcategory in view. A subcategory
  // whose group is archived stays in view, as a category in no group.
  const parentOf = (c) => (c.parent_id && activeIds.has(c.parent_id) ? c.parent_id : null);
  const isGroup = (c) => !parentOf(c) && active.some((k) => parentOf(k) === c.id);
  const budgetOf = (id) => {
    const rows = budgets.filter((b) => b.category_id === id && b.year === year && b.month === month);
    return rows.length ? rows.reduce((sum, b) => sum + Number(b.amount ?? 0), 0) : null;
  };
  const row = (c) => ({ category: c, budget: budgetOf(c.id) });
  const childrenOf = (id) => active.filter((k) => parentOf(k) === id);

  const groups = [];
  const add = (title, group, list) => {
    if (list.length) groups.push({ title, group, rows: list.map(row) });
  };

  add('Income', null, active.filter((c) => c.kind === 'income' && !isGroup(c)));
  const expense = active.filter((c) => c.kind !== 'income');
  const spending = expense.filter((c) => !c.is_savings);
  const savings = expense.filter((c) => c.is_savings);
  for (const g of spending.filter(isGroup)) add(g.name, g, childrenOf(g.id));
  add('Other', null, spending.filter((c) => !parentOf(c) && !isGroup(c)));
  for (const g of savings.filter(isGroup)) add(g.name, g, childrenOf(g.id));
  add('Savings', null, savings.filter((c) => !parentOf(c) && !isGroup(c)));

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
  if (category?.id && hasChildren(categories, category.id)) return [];
  return categories.filter(
    (c) =>
      !c.parent_id &&
      !c.archived &&
      c.id !== category?.id &&
      (c.kind ?? 'expense') === (category?.kind ?? 'expense') &&
      Boolean(c.is_savings) === Boolean(category?.is_savings) &&
      hasChildren(categories, c.id),
  );
}
