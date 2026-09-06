// One household date convention (QA-06, SHR-247).
//
// `occurred_at` is a Postgres `date` — a calendar day with no time and no zone.
// `new Date('2026-09-06')` parses that as UTC midnight, which in Dubai (UTC+4)
// is 04:00 on the 6th; comparing it against locally-constructed boundaries
// silently shifted records across day and month edges. Everything here reads a
// stored date as a *local* calendar day, so a day boundary means the same thing
// on both sides of every comparison.

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

// A stored day as local midnight. Accepts 'YYYY-MM-DD' and full timestamps.
export function parseDay(value) {
  if (value instanceof Date) return startOfDay(value);
  const match = DATE_ONLY.exec(String(value ?? ''));
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return startOfDay(new Date(value));
}

export function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// The exclusive upper bound for "up to and including today". Every window in
// the app is half-open [start, end), so today's records are in and tomorrow's
// are out — the MTD window used to add 24 hours to the current *timestamp*,
// which let tomorrow in.
export function endOfDayExclusive(date) {
  const d = startOfDay(date);
  d.setDate(d.getDate() + 1);
  return d;
}

// Sortable month key. Zero-padded so lexical order is chronological order —
// the previous `${year}-${month}` keys sorted "2026-10" before "2026-2".
export function monthKey(date) {
  const d = date instanceof Date ? date : parseDay(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function startOfMonth(date) {
  const d = date instanceof Date ? date : parseDay(date);
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

// A record dated after today is planned, not posted. It must never count
// towards actual spend, income or averages — and its date is never rewritten
// to make that true.
export function isPosted(row, now = new Date()) {
  return parseDay(row?.occurred_at) < endOfDayExclusive(now);
}

// Clamp a month/quarter/year bucket so the still-running one stops at today
// rather than reaching into the future.
export function clampToToday(end, now = new Date()) {
  const today = endOfDayExclusive(now);
  return end > today ? today : end;
}

// Days between two calendar days, counted in whole days and never negative for
// a future record — a transaction dated tomorrow is 0 days old, not "-1d ago".
export function daysBetweenDays(from, to) {
  return Math.round((startOfDay(to) - startOfDay(from)) / 86400000);
}

// Days in a given month. `new Date(y, m + 1, 0)` is the last day of month m.
export function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

// A calendar day in a month, clamped to that month's length. The 31st of
// February is the 28th (or 29th), not the 3rd of March (QA-07).
export function atDayOfMonth(year, monthIndex, day) {
  const normalisedYear = year + Math.floor(monthIndex / 12);
  const normalisedMonth = ((monthIndex % 12) + 12) % 12;
  return new Date(normalisedYear, normalisedMonth, Math.min(day, daysInMonth(normalisedYear, normalisedMonth)));
}

// Add whole months to a date while preserving its ANCHOR day rather than the
// day it happened to land on last time. Stepping Jan 31 by one month gives
// Feb 28; stepping that result again gives Mar 31, not Mar 28 — the anchor is
// remembered, so a short month does not permanently shift the schedule.
export function addMonthsClamped(anchor, months) {
  const a = anchor instanceof Date ? anchor : parseDay(anchor);
  return atDayOfMonth(a.getFullYear(), a.getMonth() + months, a.getDate());
}
