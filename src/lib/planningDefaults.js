// The planning assumptions used until the household saves its own, in one
// place: six screens and two libraries each kept a copy (Planning audit, 1.3).
// The database fills its columns with the same figures whenever any editor
// first creates the row, and planningDefaults.test.js holds the two together.
export const PLANNING_DEFAULTS = { nominal_return_pct: 6, inflation_pct: 2.5, safe_withdrawal_pct: 4 };

// Whether the household chose its assumptions. A row is not a choice: the
// life plan or the debt plan creates one filled with the defaults above, and
// that read as "Your saved assumptions". The assumptions drawer marks its
// save (assumptions_saved_at).
export function assumptionsSaved(assumptions) {
  return assumptions?.assumptions_saved_at != null;
}

// One of the three: the household's figure, or the default with no row.
export function assumption(assumptions, column) {
  return assumptions?.[column] != null ? Number(assumptions[column]) : PLANNING_DEFAULTS[column];
}
