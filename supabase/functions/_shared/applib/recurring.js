// Synced copy of src/lib/recurring.js (trimmed to what the Telegram
// assistant's tools need) -- see scope.js in this same directory for why.
import { addMonthsClamped, parseDay, startOfDay } from './day.js';

// The nth occurrence of a schedule, always measured from the stored anchor
// date rather than by repeatedly stepping the previous result (QA-07).
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

// EVERY occurrence inside the window, not just the first (QA-07).
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
        occurrenceKey: `${r.id}@${dueDate.getFullYear()}-${dueDate.getMonth() + 1}-${dueDate.getDate()}#${index}`,
      })),
    )
    .sort((a, b) => a.dueDate - b.dueDate);
}
