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
export function shareOf(row, scopeMemberId) {
  return scopedValue(row.amount, row, scopeMemberId);
}

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
export function dayTotals(rows, scopeMemberId) {
  const byDay = new Map();
  for (const row of rows) {
    const key = dayKeyOf(parseDay(row.occurred_at));
    if (!byDay.has(key)) byDay.set(key, { income: 0, spend: 0, items: [] });
    const day = byDay.get(key);
    applyToIncomeSpend(row, shareOf(row, scopeMemberId), day);
    day.items.push(row);
  }
  return byDay;
}
