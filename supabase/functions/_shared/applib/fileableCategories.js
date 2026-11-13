// Synced copy of src/lib/fileableCategories.js (scripts/applib-parity.test.mjs).
// The categories a record can be filed under (docs/decisions.md, "Only a
// category with no subcategories is chosen"). A group with active categories
// within it ("Food & Dining", with Eating Out and Food Delivery) is not one:
// in the feature review (November 2026) a guessed group was half the
// categories changed on approval. A group whose categories are all archived
// is filed under itself. Savings categories hold money set aside, not spent.
// Each comes with its label, "Group › Category", so a choice reads whole.
// The bot shares this (supabase/functions/_shared/applib/fileableCategories.js).

function groupIds(categories) {
  return new Set(categories.filter((c) => !c.archived && c.parent_id).map((c) => c.parent_id));
}

// keepId: the category a record already has, kept so an old record filed
// under a group still shows what it is.
/**
 * @param {Array<{ id: string, name: string, kind?: string | null, parent_id?: string | null, archived?: boolean | null, is_savings?: boolean | null }>} categories
 * @param {string | null} [kind]
 * @param {string | null} [keepId]
 */
export function fileableCategories(categories, kind = null, keepId = null) {
  const groups = groupIds(categories);
  const byId = new Map(categories.map((c) => [c.id, c]));
  return categories
    .filter((c) => c.id === keepId || (!c.archived && !c.is_savings && !groups.has(c.id) && (kind == null || (c.kind ?? 'expense') === kind)))
    .map((c) => {
      const parent = c.parent_id ? byId.get(c.parent_id) : null;
      return { ...c, label: parent ? `${parent.name} › ${c.name}` : c.name };
    });
}

// Whether a category is a group that a record should not be newly filed under.
/**
 * @param {Array<{ id: string, parent_id?: string | null, archived?: boolean | null }>} categories
 * @param {string | null | undefined} id
 */
export function needsSubcategory(categories, id) {
  return !!id && groupIds(categories).has(id);
}
