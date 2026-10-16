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

// The editor's lines, as typed: [{ category_id, amount }] with amounts as
// strings, positive. What's left to allocate, in cents to avoid 0.1 + 0.2.
export function unallocated(lines, total) {
  const cents = (v) => Math.round((Number(v) || 0) * 100);
  return (cents(total) - lines.reduce((sum, l) => sum + cents(l.amount), 0)) / 100;
}

// Why a set of lines can't be saved yet, or '' when they can. The same rules
// the database checks (supabase/migrations/*_transaction_splits.sql), said
// before saving rather than after.
export function splitProblem(lines, total) {
  if (lines.length < 2) return 'A split needs at least two lines.';
  if (lines.some((l) => !l.category_id)) return 'Choose a category for every line.';
  if (lines.some((l) => !(Number(l.amount) > 0))) return 'Give every line an amount above zero.';
  if (new Set(lines.map((l) => l.category_id)).size !== lines.length) return 'Each category once: put two amounts in one category on one line.';
  const left = unallocated(lines, total);
  if (left > 0) return `${left.toFixed(2)} still to allocate.`;
  if (left < 0) return `The lines are ${(-left).toFixed(2)} more than the total.`;
  return '';
}
