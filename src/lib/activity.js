import { isPosted, parseDay } from './day';
import { scopedValue } from './scope';
import { applyToIncomeSpend } from './transactionKind';

// The arithmetic behind Activity's list, its summary line and its calendar.
// It is the same arithmetic Overview, Budget and Insights use: a member's
// view counts their own records in full and half of each shared one
// (scopedValue), and a refund nets against spend rather than counting as
// income (transactionKind.js). The calendar used to add up raw signed amounts,
// so under Me a shared expense of 100 and a shared refund of 20 read as 100
// spent and 20 earned, while the list above it said 40 out and nothing in.

// Which records Activity counts: posted (dated today or earlier), scheduled
// (dated after today), or both. Totals on every other screen are posted-only;
// a record dated next week is a plan, not money that has moved.
export const DATE_BASES = [
  { id: 'posted', label: 'Posted' },
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'all', label: 'All' },
];

export function matchesDateBasis(row, basis, now = new Date()) {
  if (basis === 'all') return true;
  return basis === 'scheduled' ? !isPosted(row, now) : isPosted(row, now);
}

// What a record contributes to the selected person's figures: all of it for
// the household or their own record, half of a shared one, nothing of the
// other person's. Rows show this beside the full amount when they differ.
// `amount` defaults to the whole record's; Activity narrowed to a category
// passes a split record's line in that category instead.
export function shareOf(row, scopeMemberId, amount = row.amount) {
  return scopedValue(amount, row, scopeMemberId);
}

const wholeAmount = (row) => row.amount;

// Income and net spend over a set of records, as the selected person's share.
export function incomeAndSpend(rows, scopeMemberId) {
  const totals = { income: 0, spend: 0 };
  for (const row of rows) applyToIncomeSpend(row, shareOf(row, scopeMemberId), totals);
  return totals;
}

// A local calendar day as YYYY-MM-DD, the key the calendar groups by.
export function dayKeyOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// The calendar's days: each day's records with its income and net spend,
// worked out exactly as the summary line works out the whole list, so the
// days of a month add up to the list's totals for that month. Net spend can
// be negative on a day that only had a refund.
export function dayTotals(rows, scopeMemberId, amountOf = wholeAmount) {
  const byDay = new Map();
  for (const row of rows) {
    const key = dayKeyOf(parseDay(row.occurred_at));
    if (!byDay.has(key)) byDay.set(key, { income: 0, spend: 0, items: [] });
    const day = byDay.get(key);
    applyToIncomeSpend(row, shareOf(row, scopeMemberId, amountOf(row)), day);
    day.items.push(row);
  }
  return byDay;
}

// The summary line's figures: income, and spending split into what was bought
// and what came back, so "net spend" can be seen to be purchases less refunds.
export function activitySummary(rows, scopeMemberId, amountOf = wholeAmount) {
  const summary = { income: 0, purchases: 0, refunds: 0, spend: 0, transfers: 0 };
  for (const row of rows) {
    const v = shareOf(row, scopeMemberId, amountOf(row));
    // Counted, so the line can say it left them out, but in neither total.
    if (row.kind === 'transfer') summary.transfers += 1;
    else if (row.kind === 'refund') summary.refunds += v;
    else if (v < 0) summary.purchases += -v;
    else summary.income += v;
  }
  summary.spend = summary.purchases - summary.refunds;
  return summary;
}

// The list's order. Largest is by size of the amount, either direction.
export function sortRows(rows, sort) {
  const byDate = (a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : 0);
  if (sort === 'oldest') return [...rows].sort(byDate);
  if (sort === 'largest') return [...rows].sort((a, b) => Math.abs(Number(b.amount)) - Math.abs(Number(a.amount)));
  return [...rows].sort((a, b) => byDate(b, a));
}

// A row's date: the year is added once it isn't this year's.
export function rowDateLabel(occurredAt, now = new Date()) {
  const d = parseDay(occurredAt);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}
