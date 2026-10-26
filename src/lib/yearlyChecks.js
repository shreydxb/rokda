import { householdToday, parseDay } from './day';

// A note checked once a year (Planning audit, 4.18): insurance, wills and
// nominations, or anything else the household writes down to look at yearly.
// The note is the reminder's text; the app only keeps the day it was last
// checked and asks again a year on (docs/decisions.md, "A yearly check is a
// note").

// The day a checked note is due again: a year after it was last checked, the
// same date, or 28 February for one checked on 29 February.
function yearAfter(day) {
  const next = new Date(day.getFullYear() + 1, day.getMonth(), day.getDate());
  if (next.getMonth() !== day.getMonth()) next.setDate(0);
  return next;
}

// Where a note stands as a yearly check: null when it is not one. Never
// checked is due at once, so marking a note yearly asks for the first check.
export function yearlyCheckStatus(note, now = new Date()) {
  if (!note?.check_yearly) return null;
  if (!note.checked_on) return { due: true, last: null, next: null };
  const last = parseDay(note.checked_on);
  const next = yearAfter(last);
  return { due: next <= parseDay(householdToday(now)), last, next };
}

const DAY = { day: 'numeric', month: 'short', year: 'numeric' };
export const dayText = (date) => date.toLocaleDateString('en-GB', DAY);

// "Checked once a year · last checked 12 Mar 2026 · next from 12 Mar 2027".
export function yearlyCheckText(status) {
  if (!status) return null;
  if (!status.last) return 'Checked once a year · not checked yet';
  return `Checked once a year · last checked ${dayText(status.last)} · ${status.due ? 'due now' : `next from ${dayText(status.next)}`}`;
}

// Overview's Needs attention items: one for each yearly check that is due.
export function yearlyCheckItems(notes = [], now = new Date()) {
  return notes
    .map((note) => ({ note, status: yearlyCheckStatus(note, now) }))
    .filter(({ status }) => status?.due)
    .map(({ note, status }) => ({
      id: `yearly-check-${note.id}`,
      kind: 'yearly_check',
      severity: 'info',
      title: `Yearly check: ${note.title}`,
      detail: status.last
        ? `Last checked ${dayText(status.last)}. Go through the note in Planning → Notes, then mark it checked.`
        : 'Not checked yet. Go through the note in Planning → Notes, then mark it checked.',
    }));
}
