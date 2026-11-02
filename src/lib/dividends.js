// Dividends in the app (SHR-366; docs/decisions.md, "Dividends are their own
// records"). Pure helpers for showing a holding's dividends and the database's
// answers about them. The figures themselves are worked out by the database
// (preview_dividend, save_dividend); nothing here computes a net.

// A holding's dividends, newest first: by ex-date, or for one added without
// an ex-date, by the day it was credited.
export function dividendsOfHolding(rows, holdingId) {
  const day = (r) => r.ex_date ?? r.credited_on ?? '';
  return (rows ?? []).filter((r) => r.holding_id === holdingId).sort((a, b) => (day(a) < day(b) ? 1 : day(a) > day(b) ? -1 : 0));
}

const STATUS_TEXT = {
  earned: 'Earned',
  received: 'Received',
  presumed: 'Presumed received, not checked',
  skipped: 'Skipped',
};

export function dividendStatusText(row) {
  return STATUS_TEXT[row.status] ?? row.status;
}

const REVIEW_TEXT = {
  trades_changed: 'A trade changed the units held on the ex-date after this was recorded.',
  feed_changed: "The feed's amount per share has changed since this was recorded.",
  moved_ex_date: 'The feed no longer lists this dividend on this date.',
  possible_duplicate: 'The feed has a dividend close to this date. Is it this one?',
  split_on_ex_date: 'A split took effect on this ex-date, so its units may be on the wrong basis.',
};

// Why a row waits for a member's look, or null when it does not.
export function reviewText(row) {
  return REVIEW_TEXT[row.review_reason] ?? null;
}

// Recording marks an earned dividend received, or a presumed one checked.
export function canRecord(row) {
  return row.status === 'earned' || row.status === 'presumed';
}

const REFUSALS = {
  stale: 'This dividend changed since you opened it. Check it again.',
  fund_confirmed_since: "The fund's balance was confirmed since you checked. Check again.",
  needs_answer: "Say whether this was already in the fund's confirmed balance.",
  not_member: "This holding isn't in your household.",
  dividend_not_found: 'This dividend is no longer there.',
  holding_not_found: 'This holding is no longer there.',
  bad_input: "Something in this form isn't a valid date or number.",
  bad_figures: 'The tax and fees come to more than the dividend, or a figure is below zero.',
  currency_mismatch: "That account isn't in this dividend's currency.",
  fund_archived: 'That fund is archived, so its balance cannot move.',
  already_linked: 'That dividend from the feed is already linked to another one.',
  already_recorded: 'This holding already has a dividend on that ex-date.',
  wrong_status: 'This dividend has moved on since you opened it. Check it again.',
};

// One sentence for a refusal from the database, keeping what was typed.
export function dividendRefusalMessage(code) {
  return REFUSALS[code] ?? 'That could not be saved. Nothing was changed.';
}
