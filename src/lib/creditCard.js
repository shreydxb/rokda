import { atDayOfMonth, startOfDay } from './day';

export function utilisation(account) {
  if (!account.credit_limit) return null;
  return Number(account.balance) / Number(account.credit_limit);
}

// The single due-date rule, shared by Overview's attention list and the cards
// panel. Both compare whole days from the same starting point, so a card due
// today reads as due today on both screens instead of one of them rolling it
// into next month (QA-07).
export function nextDueDate(dueDay, now = new Date()) {
  if (!dueDay) return null;
  const today = startOfDay(now);
  const thisMonth = atDayOfMonth(today.getFullYear(), today.getMonth(), dueDay);
  return thisMonth >= today ? thisMonth : atDayOfMonth(today.getFullYear(), today.getMonth() + 1, dueDay);
}

export function daysUntilDue(dueDay, now = new Date()) {
  const due = nextDueDate(dueDay, now);
  if (!due) return null;
  return Math.round((due - startOfDay(now)) / 86400000);
}

// A day of the month as people say it: 1st, 2nd, 3rd, 11th, 21st, 22nd.
export function ordinal(n) {
  return `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}
