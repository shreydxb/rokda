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

// A holding nothing has ever put a number on. holdings.value_aed is `not null
// default 0`, so a row created before its first price refresh stores a zero
// that nobody asserted -- and a zero that means "unknown" is not the same fact
// as a zero that means "this is worth nothing" (QA #6). priced_at is what
// tells them apart: it is set only when a valuation is actually confirmed, by
// a person or by the price feed, and it was backfilled for every legacy row
// (see docs/holdings-priced-at-migration.md), so null here really does mean
// never.
//
// Callers must not present the stored 0 as a measurement: no gain against a
// cost basis, no history point, no "valued today".
export function isAwaitingFirstValuation(holding) {
  return !!holding && holding.priced_at == null;
}

// What the editor's value field should hold when a holding is reopened.
//
// holdings.value_aed is `not null default 0`, so a holding awaiting its first
// valuation stores a numeric 0. Rehydrating that as the string '0' is how the
// placeholder got certified: '0' is not blank, so the editor stopped treating
// the holding as pending, and the next save -- correcting a quantity, say --
// stamped priced_at and wrote a zero history point for a value nobody ever
// supplied (QA #6). Blank is what it means, so blank is what comes back.
export function valueFieldFor(holding) {
  if (!holding) return '';
  return isAwaitingFirstValuation(holding) ? '' : String(holding.value_aed ?? 0);
}

// Whether this edit is still awaiting a first valuation, and so must certify
// nothing: no priced_at, no history point.
//
// `autoValued` is derived from the form (a price provider, a quantity, a
// convertible currency) and was the only input. On reopen that is not enough:
// a holding already known to have never been valued stays pending until
// someone actually types a number, whatever the form's other fields say.
export function isPendingValuation({ holding = null, valueField = '', autoValued = false } = {}) {
  if (String(valueField).trim() !== '') return false;
  return autoValued || isAwaitingFirstValuation(holding);
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
// (a rename, a category change) preserve whatever is already there — only a
// confirmed new valuation moves it.
//
// Two things count as "confirmed": the numbers actually changed, or this is
// an explicit reconfirmation of the value that's already stored — signalled
// by the caller passing the SAME object for `holding` and `submitted`. An
// ordinary Save always builds `submitted` fresh from form state, so it can
// never accidentally look like a reconfirmation; only a dedicated "confirm
// unchanged" action does that on purpose (SHR-245: a holding whose value
// truly hasn't moved still needs a way to be marked current).
export function nextPricedAt(holding, submitted, { confirmedAsOf = null } = {}) {
  if (!confirmedAsOf) return holding?.priced_at ?? null;
  const reconfirmingAsIs = submitted === holding;
  if (reconfirmingAsIs || valuationChanged(holding, submitted)) {
    return new Date(`${confirmedAsOf}T00:00:00Z`).toISOString();
  }
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
