// Holding valuation freshness (QA-04, SHR-245).
//
// Two separate facts, previously collapsed into one column:
//   priced_at  — the date the stored value is a valuation *as of*
//   updated_at — when the record was last edited
//
// Reloading the screen changes neither. Renaming a holding changes only the
// second. A stale holding stays stale until someone actually confirms a new
// valuation.

export const HOLDING_STALE_DAYS = 30;

// Fields that carry a valuation. A change to any of them is a repricing and
// needs a confirmed as-of date; a change to name, asset class, owner or
// currency is not.
export const VALUATION_FIELDS = ['value_aed', 'quantity', 'avg_price', 'current_price', 'invested_value_aed', 'day_change_pct'];

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// True when the submitted values differ from what is stored. Used to decide
// whether a save may advance priced_at at all.
export function valuationChanged(before, after) {
  return VALUATION_FIELDS.some((field) => numeric(before?.[field]) !== numeric(after?.[field]));
}

export function daysSincePriced(holding, now = new Date()) {
  if (!holding?.priced_at) return null;
  return Math.floor((now - new Date(holding.priced_at)) / 86400000);
}

export function isStale(holding, now = new Date(), staleDays = HOLDING_STALE_DAYS) {
  const days = daysSincePriced(holding, now);
  return days === null || days >= staleDays;
}

// What a save should write for priced_at. Reloading and non-valuation edits
// preserve whatever is already there; only a confirmed new valuation moves it.
export function nextPricedAt(holding, submitted, { confirmedAsOf = null } = {}) {
  if (!valuationChanged(holding, submitted)) return holding?.priced_at ?? null;
  if (confirmedAsOf) return new Date(`${confirmedAsOf}T00:00:00Z`).toISOString();
  return holding?.priced_at ?? null;
}

// A confirmed valuation is also a dated history point. Keyed on
// (holding_id, as_of) so confirming the same day twice is idempotent rather
// than duplicating the point.
export function historyPointFor(holdingId, asOfDate, valueAed) {
  if (!holdingId || !asOfDate) return null;
  return { holding_id: holdingId, as_of: asOfDate, value_aed: Number(valueAed) || 0 };
}

export function todayISODate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
