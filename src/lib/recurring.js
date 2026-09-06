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

export { CADENCES };
