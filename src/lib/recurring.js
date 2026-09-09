import { addMonthsClamped, parseDay, startOfDay } from './day';

const CADENCES = ['weekly', 'monthly', 'quarterly', 'yearly'];

// The nth occurrence of a schedule, always measured from the stored anchor
// date rather than by repeatedly stepping the previous result. Stepping loses
// the anchor day in short months: Jan 31 advanced monthly became Mar 3 because
// "Feb 31" overflowed, and every later occurrence inherited the drift (QA-07).
export function occurrenceAt(anchorDate, cadence, n) {
  const anchor = parseDay(anchorDate);
  if (cadence === 'weekly') {
    const d = new Date(anchor);
    d.setDate(d.getDate() + 7 * n);
    return d;
  }
  if (cadence === 'monthly') return addMonthsClamped(anchor, n);
  if (cadence === 'quarterly') return addMonthsClamped(anchor, 3 * n);
  if (cadence === 'yearly') return addMonthsClamped(anchor, 12 * n);
  return anchor;
}

// Rolls a (possibly past) next_due_date forward by cadence until it's today
// or later, so a bill paid last month still shows correctly without the
// user having to bump the stored date after every payment.
export function rollForward(dateStr, cadence, now = new Date()) {
  const today = startOfDay(now);
  for (let n = 0; n < 1000; n++) {
    const occurrence = occurrenceAt(dateStr, cadence, n);
    if (occurrence >= today) return occurrence;
  }
  return occurrenceAt(dateStr, cadence, 0);
}

// EVERY occurrence inside the window, not just the first. A weekly bill in a
// 30-day window is five commitments; returning one understated what the
// household had already committed to (QA-07).
export function occurrencesInWindow(dateStr, cadence, days, now = new Date()) {
  const today = startOfDay(now);
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + days);
  const occurrences = [];
  for (let n = 0; n < 1000; n++) {
    const occurrence = occurrenceAt(dateStr, cadence, n);
    if (occurrence > horizon) break;
    if (occurrence >= today) occurrences.push(occurrence);
  }
  return occurrences;
}

export function upcomingItems(rows, days, now = new Date()) {
  return rows
    .filter((r) => r.active !== false)
    .flatMap((r) =>
      occurrencesInWindow(r.next_due_date, r.cadence, days, now).map((dueDate, index) => ({
        ...r,
        dueDate,
        // Rows can now appear more than once in a window, so they need a key
        // that distinguishes the occurrences.
        occurrenceKey: `${r.id}@${dueDate.getFullYear()}-${dueDate.getMonth() + 1}-${dueDate.getDate()}#${index}`,
      })),
    )
    .sort((a, b) => a.dueDate - b.dueDate);
}

// Whether a posted transaction already matches this bill/income's current
// due occurrence -- the same matching rule the daily Telegram nudge check
// uses server-side (amount within 20% tolerance, posted within 5 days
// either side of the due date). Merchant text isn't checked: it's too
// inconsistent between a bank SMS and a manual entry to be a reliable
// signal here, and amount + timing is already a fair bar.
//
// rollForward always lands on a FUTURE-or-today occurrence (it assumes
// every earlier cycle was already paid, which is exactly the display-only
// convenience it exists for -- see its own comment). Checking payment
// status needs the opposite: the occurrence one cadence step BEHIND that,
// which is the cycle that just came due and hasn't been confirmed paid yet.
// If the schedule's very first occurrence hasn't even arrived (n === 0, the
// anchor itself is still in the future), there is no past cycle to check --
// only "upcoming" applies.
export function billStatus(row, transactions, now = new Date()) {
  const today = startOfDay(now);
  let n = 0;
  let occurrence = occurrenceAt(row.next_due_date, row.cadence, 0);
  while (occurrence < today && n < 1000) {
    n += 1;
    occurrence = occurrenceAt(row.next_due_date, row.cadence, n);
  }
  const isPastCycle = n > 0;
  const due = isPastCycle ? occurrenceAt(row.next_due_date, row.cadence, n - 1) : occurrence;

  const amount = Math.abs(Number(row.amount));
  const windowStart = new Date(due);
  windowStart.setDate(windowStart.getDate() - 5);
  const windowEnd = new Date(due);
  windowEnd.setDate(windowEnd.getDate() + 5);
  const posted = transactions.some((t) => {
    const d = parseDay(t.occurred_at);
    if (d < windowStart || d > windowEnd) return false;
    return Math.abs(Math.abs(Number(t.amount)) - amount) <= amount * 0.2;
  });
  if (posted) return { label: 'Posted', tone: 'pos', needsAction: false, posted: true, due };
  if (isPastCycle) return { label: 'Late', tone: 'neg', needsAction: true, posted: false, due };

  const daysUntil = Math.round((due - today) / 86400000);
  if (daysUntil <= 3) return { label: 'Due soon', tone: 'warn', needsAction: true, posted: false, due };
  return { label: 'Upcoming', tone: 'mute', needsAction: false, posted: false, due };
}

export { CADENCES };
