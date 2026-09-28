import { isPosted, parseDay } from './day';
import { hasEnded } from './recurring';
import { isSpendRow, spendDelta } from './transactionKind';

// Who pays for what in a household of two earners. Each category's costs are
// either one person's own (his car loan, her family remittance) or shared by
// the household (rent, groceries), set on the category and inherited by its
// subcategories. Shared costs are split in proportion to income, the fairest
// default when two salaries differ a lot: each gives the same fraction of
// what they earn, and keeps the same fraction for themselves.

const MONTHS_PER = { weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };

// A category's owner, or null for shared. A subcategory with none of its own
// follows its parent, so marking "Transport" as his covers every line under it.
export function categoryOwner(categoryId, catById) {
  const cat = catById.get(categoryId);
  if (!cat) return null;
  if (cat.owner_member_id) return cat.owner_member_id;
  return (cat.parent_id && catById.get(cat.parent_id)?.owner_member_id) || null;
}

// Each member's usual monthly income, from the income reminders (salaries),
// in AED. Shared income counts half to each.
export function monthlyIncomeByMember(recurring = [], members = [], now = new Date()) {
  const byMember = new Map(members.map((m) => [m.id, 0]));
  for (const r of recurring) {
    const amount = Number(r.amount) || 0;
    if (amount <= 0 || r.active === false || hasEnded(r, now)) continue;
    const monthly = (amount * (MONTHS_PER[r.cadence] ?? 0)) / (r.interval_count || 1);
    if (r.owner_member_id && byMember.has(r.owner_member_id) && !r.is_shared) {
      byMember.set(r.owner_member_id, byMember.get(r.owner_member_id) + monthly);
    } else {
      for (const m of members) byMember.set(m.id, byMember.get(m.id) + monthly / members.length);
    }
  }
  return byMember;
}

// The fraction of shared costs each member carries: by income when there is
// income to go on, evenly otherwise.
export function shareSplit(recurring, members, now = new Date()) {
  const income = monthlyIncomeByMember(recurring, members, now);
  const total = [...income.values()].reduce((s, v) => s + v, 0);
  const basis = total > 0 ? 'income' : 'even';
  const pct = new Map(members.map((m) => [m.id, total > 0 ? income.get(m.id) / total : 1 / members.length]));
  return { basis, income, pct };
}

// One month of the household's share: what each person's budget asks of them,
// what they are responsible for of what was spent, what they actually paid
// (spending from their own accounts; a joint account's counts by the split),
// and the one transfer that squares it. Uncategorised spending is shared.
export function householdShare({ members = [], categories = [], budgets = [], transactions = [], accounts = [], recurring = [], year, month, now = new Date() }) {
  const catById = new Map(categories.map((c) => [c.id, c]));
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const memberIds = new Set(members.map((m) => m.id));
  const { basis, income, pct } = shareSplit(recurring, members, now);
  const ownerOf = (categoryId) => {
    const owner = categoryOwner(categoryId, catById);
    return owner && memberIds.has(owner) ? owner : null;
  };
  // Adds `amount` to each member's figure: all of it to the one it belongs
  // to, or their split of it when it belongs to the household.
  const spread = (totals, who, amount) => {
    for (const m of members) totals.set(m.id, totals.get(m.id) + (who === null ? amount * pct.get(m.id) : who === m.id ? amount : 0));
  };
  const zero = () => new Map(members.map((m) => [m.id, 0]));

  const planned = { shared: 0, own: zero(), total: zero() };
  const plannedSaving = { shared: 0, own: zero(), total: zero() };
  for (const b of budgets) {
    if (b.year !== year || b.month !== month) continue;
    const amount = Number(b.amount) || 0;
    const target = catById.get(b.category_id)?.is_savings ? plannedSaving : planned;
    const owner = ownerOf(b.category_id);
    if (owner === null) target.shared += amount;
    else target.own.set(owner, target.own.get(owner) + amount);
    spread(target.total, owner, amount);
  }

  const responsible = zero();
  const paid = zero();
  let spent = 0;
  let sharedSpent = 0;
  for (const t of transactions) {
    const d = parseDay(t.occurred_at);
    if (d.getFullYear() !== year || d.getMonth() + 1 !== month || !isPosted(t, now)) continue;
    const v = Number(t.amount) || 0;
    if (!isSpendRow(t, v)) continue;
    const amount = spendDelta(t, v);
    const owner = t.category_id ? ownerOf(t.category_id) : null;
    const account = accountById.get(t.account_id);
    const payer = account && !account.is_shared && memberIds.has(account.owner_member_id) ? account.owner_member_id : null;
    spent += amount;
    if (owner === null) sharedSpent += amount;
    spread(responsible, owner, amount);
    spread(paid, payer, amount);
  }

  const people = members.map((m) => ({
    member: m,
    income: income.get(m.id),
    pct: pct.get(m.id),
    ownPlanned: planned.own.get(m.id),
    sharedPlanned: planned.shared * pct.get(m.id),
    planned: planned.total.get(m.id),
    savingPlanned: plannedSaving.total.get(m.id),
    responsible: responsible.get(m.id),
    paid: paid.get(m.id),
    net: paid.get(m.id) - responsible.get(m.id),
  }));

  // Two people: whoever paid less than their part owes the other the gap.
  // Under a dirham either way is even.
  let settle = null;
  if (people.length === 2) {
    const [a, b] = people;
    const gap = a.net;
    if (Math.abs(gap) >= 1) settle = gap > 0 ? { from: b.member, to: a.member, amount: gap } : { from: a.member, to: b.member, amount: -gap };
  }

  return { basis, people, planned, plannedSaving, spent, sharedSpent, settle };
}
