// Synced copy of src/lib/splits.js -- see scope.js in this same directory for
// why.
//
// A transaction's amount by category (docs/decisions.md, "A transaction can be
// split across categories"; SHR-233). An ordinary record is one part: its
// category and its whole amount. A split record is one part per line, each
// signed like the record, adding up to it. Every total by category goes
// through this, so a 500 receipt split 400 groceries / 100 household counts
// 400 under one and 100 under the other everywhere: Budget, Insights,
// Overview, the "running high" check and the bot.
//
// The lines come embedded with the transaction (`transaction_splits` in the
// select). A split record whose lines didn't come with it reads as
// uncategorised rather than as one category.
export function categoryParts(t) {
  if (t?.is_split) {
    const lines = Array.isArray(t.transaction_splits) ? t.transaction_splits : [];
    return lines.map((s) => ({ categoryId: s.category_id, amount: Number(s.amount) || 0 }));
  }
  return [{ categoryId: t?.category_id ?? null, amount: Number(t?.amount) || 0 }];
}

// The part of a transaction's amount filed under one category (or any of a
// set of them): all of an ordinary record in it, a line's worth of a split
// one, zero otherwise.
export function amountInCategory(t, categoryIds) {
  const wanted = categoryIds instanceof Set ? categoryIds : new Set([categoryIds]);
  return categoryParts(t)
    .filter((p) => wanted.has(p.categoryId))
    .reduce((sum, p) => sum + p.amount, 0);
}

// Whether any part of a transaction is filed under one of these categories.
export function inCategory(t, categoryIds) {
  const wanted = categoryIds instanceof Set ? categoryIds : new Set([categoryIds]);
  return categoryParts(t).some((p) => wanted.has(p.categoryId));
}
