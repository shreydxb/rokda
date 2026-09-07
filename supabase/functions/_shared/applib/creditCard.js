// Synced copy of src/lib/creditCard.js (trimmed to what the Telegram
// assistant's tools need) -- see scope.js in this same directory for why.
import { atDayOfMonth, startOfDay } from './day.js';

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
