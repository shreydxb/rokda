// Synced copy of src/lib/statements.js, trimmed to the statement dates the
// Telegram bot asks about -- see scope.js in this same directory for why.
import { atDayOfMonth, parseDay, startOfDay } from './day.js';

// A day as stored: YYYY-MM-DD, read in local time like every stored date.
export function isoDay(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The statements a card has closed before today, newest first. A statement
// closing today is not included: its last day's spending can still arrive,
// so it is asked about from tomorrow.
export function closedStatementDates(statementDay, today = new Date(), count = 1) {
  if (!statementDay) return [];
  const day = startOfDay(today);
  const year = day.getFullYear();
  let month = day.getMonth();
  let close = atDayOfMonth(year, month, statementDay);
  if (close >= day) {
    month -= 1;
    close = atDayOfMonth(year, month, statementDay);
  }
  const dates = [];
  while (dates.length < count) {
    dates.push(close);
    month -= 1;
    close = atDayOfMonth(year, month, statementDay);
  }
  return dates;
}

// The day after the previous statement closed: where this statement begins.
export function statementPeriodStart(statementDay, statementDate) {
  const close = parseDay(statementDate);
  const previous = atDayOfMonth(close.getFullYear(), close.getMonth() - 1, statementDay);
  return new Date(previous.getFullYear(), previous.getMonth(), previous.getDate() + 1);
}

// When a statement is due: the first due day on or after it closes. A card
// due on its statement day (paid in full automatically) is due the same day.
export function statementDueDate(statementDate, dueDay) {
  if (!dueDay) return null;
  const close = parseDay(statementDate);
  const sameMonth = atDayOfMonth(close.getFullYear(), close.getMonth(), dueDay);
  return sameMonth >= close ? sameMonth : atDayOfMonth(close.getFullYear(), close.getMonth() + 1, dueDay);
}
