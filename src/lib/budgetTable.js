import { formatMoney } from './money';
import { isPosted, parseDay } from './day';
import { scopedValue } from './scope';
import { isSpendRow } from './transactionKind';
import { amountInCategory, inCategory } from './splits';
import { trailingAverageByCategory } from './insights';
import { categoryAndChildren } from './activityLink';

// Money -> Budget's month as the prototype lays it out (the revamp, phase
// 4b; design/prototype budMonth): the verdict on the month and each line,
// the rows of the By category table with each one's usual month, and the
// records a line opens beneath it. The spending comes from budgetGroupSpend
// (lib/budget.js), so the table adds up exactly as the hero, the year view
// and Overview read it.

// How far through the month the usual is taken from: the same six months
// Overview's What changed and the old Insights used (the design note's
// decision 4), so "usual" means one thing everywhere.
export const USUAL_MONTHS = 6;

// Over by an amount once the limit is passed; over pace when the share of
// the limit spent is more than ten points ahead of the share of the month
// gone; on pace; within budget once the month is over; not started for one
// ahead. Nothing without a limit, nor on the pace before a third of the month
// has gone.
export function paceVerdict(spent, limit, pace) {
  if (!(limit > 0)) return null;
  if (spent > limit + 0.005) return { label: `Over by ${formatMoney(spent - limit)}`, tone: 'neg' };
  if (pace.isPast) return { label: 'Within budget', tone: 'pos' };
  if (pace.isFuture) return { label: 'Not started', tone: 'neutral' };
  // Early in the month what was spent is mostly whichever big bill landed
  // first (rent on the 1st), so the pace says nothing until a third of the
  // month has gone, as Budget's projection always waited (monthPace's
  // canProject; the fresh review of 4b).
  if (!pace.canProject) return null;
  if (spent / limit > pace.elapsedFraction + 0.1) return { label: 'Over pace', tone: 'warn' };
  return { label: 'On pace', tone: 'pos' };
}

// The table's rows. A group with several budgeted lines gets a header row
// with its subtotal and usual, its lines with their own spending, and "Other"
// for spending in the group none of them holds (posted to the group itself,
// or to a line with no budget), so the lines add up to the header, as in the
// year view. A group with one budgeted line is that one row, counting the
// whole group: a household files the same purchase under the group one day
// and the line the next. `usual` is null where nothing was spent in the
// months it looks back over.
export function budgetTable({ budgets, catById, spend, transactions, year, month, scopeMemberId }) {
  const { averages } = trailingAverageByCategory(transactions, year, month, USUAL_MONTHS, scopeMemberId);
  const usualOf = (ids) => {
    const known = ids.filter((id) => averages.has(id));
    return known.length ? known.reduce((s, id) => s + averages.get(id), 0) : null;
  };
  const groupIds = (groupId) => [...catById.values()].filter((c) => c.id === groupId || c.parent_id === groupId).map((c) => c.id);
  const nameOf = (id) => catById.get(id)?.name ?? 'Unknown';

  const byGroup = new Map();
  for (const b of budgets) {
    const groupId = catById.get(b.category_id)?.parent_id ?? b.category_id;
    if (!byGroup.has(groupId)) byGroup.set(groupId, []);
    byGroup.get(groupId).push(b);
  }

  const sections = [];
  for (const [groupId, rows] of byGroup) {
    const groupSpent = spend.groups.get(groupId) ?? 0;
    const groupLimit = rows.reduce((s, r) => s + Number(r.amount), 0);
    const groupUsual = usualOf(groupIds(groupId));
    if (rows.length === 1) {
      const b = rows[0];
      const name = b.category_id === groupId ? nameOf(groupId) : `${nameOf(groupId)} › ${nameOf(b.category_id)}`;
      sections.push({ group: null, lines: [{ id: b.id, budget: b, categoryId: b.category_id, name, spent: groupSpent, limit: Number(b.amount), usual: groupUsual, recordsCategoryId: groupId }] });
      continue;
    }
    // A group budgeted beside its own lines is its "general" line: what was
    // filed to the group itself, so its records are those alone (the fresh
    // review of 4b).
    const lines = rows.map((b) => ({
      id: b.id,
      budget: b,
      categoryId: b.category_id,
      name: b.category_id === groupId ? `${nameOf(groupId)} · general` : nameOf(b.category_id),
      spent: spend.byCategory.get(b.category_id) ?? 0,
      limit: Number(b.amount),
      usual: usualOf([b.category_id]),
      recordsCategoryId: b.category_id,
      ownOnly: b.category_id === groupId,
    }));
    const other = groupSpent - lines.reduce((s, l) => s + l.spent, 0);
    if (Math.abs(other) >= 0.005) {
      lines.push({ id: `${groupId}-other`, budget: null, categoryId: null, name: `Other ${nameOf(groupId)}`, spent: other, limit: null, usual: null, recordsCategoryId: null });
    }
    sections.push({ group: { id: groupId, name: nameOf(groupId), spent: groupSpent, limit: groupLimit, usual: groupUsual }, lines });
  }

  const limit = budgets.reduce((s, b) => s + Number(b.amount), 0);
  return { sections, budgeted: { spent: spend.inBudgetedGroups, limit }, outside: spend.outside, uncategorised: spend.uncategorised };
}

// A line's records for the month, opened beneath it: posted spending (and
// refunds) in its categories, the selected person's part, newest first, each
// with its amount in those categories (a split record's lines there). A
// group's line takes in its subcategories; its "general" line, `ownOnly`, the
// group alone.
export function lineRecords(transactions, categoryId, categories, year, month, scopeMemberId, now = new Date(), { ownOnly = false } = {}) {
  const ids = ownOnly ? new Set([categoryId]) : categoryAndChildren(categoryId, categories);
  return transactions
    .filter((t) => {
      const d = parseDay(t.occurred_at);
      if (d.getFullYear() !== year || d.getMonth() + 1 !== month || !isPosted(t, now)) return false;
      if (!(scopeMemberId === null || t.is_shared || t.owner_member_id === scopeMemberId)) return false;
      return inCategory(t, ids) && isSpendRow(t, scopedValue(t.amount, t, scopeMemberId));
    })
    .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0))
    .map((t) => ({ t, amount: scopedValue(amountInCategory(t, ids), t, scopeMemberId) }));
}
