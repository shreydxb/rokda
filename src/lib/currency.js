// Display-currency conversion for hero/portfolio figures. Everything is
// still stored in AED — this only affects what a figure is shown as.
//
// USD is the AED-USD peg: fixed at 3.6725 by the UAE Central Bank since
// 1997, so it's a real constant, not a rate anyone needs to maintain.
// INR floats, so there's no constant to hardcode — it comes from
// households.inr_per_aed, refreshed daily by the price-refresh Edge
// Function (see SHR-237) from a real AED/INR rate, with a manual entry in
// Settings as a fallback for as long as that feed has never succeeded.
// When no rate exists yet either way, INR stays unavailable rather than
// guessing one.
export const USD_PER_AED = 1 / 3.6725;

export const CURRENCIES = ['AED', 'USD', 'INR'];

export function currencyAvailable(code, household) {
  if (code === 'AED' || code === 'USD') return true;
  if (code === 'INR') return household?.inr_per_aed != null;
  return false;
}

// Returns null (never a guess) when the code isn't available yet.
export function convertFromAed(amountAed, code, household) {
  if (code === 'AED') return amountAed;
  if (code === 'USD') return amountAed * USD_PER_AED;
  if (code === 'INR') return household?.inr_per_aed != null ? amountAed * Number(household.inr_per_aed) : null;
  return null;
}

// The inverse of convertFromAed, for entering an amount in a foreign
// currency and storing it in AED (every transaction is stored in AED
// regardless of what currency it was entered in). Same null-when-unknown
// rule as convertFromAed -- never guesses a rate.
export function convertToAed(amount, code, household) {
  if (code === 'AED') return amount;
  if (code === 'USD') return amount / USD_PER_AED;
  if (code === 'INR') return household?.inr_per_aed != null ? amount / Number(household.inr_per_aed) : null;
  return null;
}

export function rateNote(code, household) {
  if (code === 'AED') return null;
  if (code === 'USD') return '1 USD = 3.6725 AED · fixed peg';
  if (code === 'INR' && household?.inr_per_aed != null) {
    const setAt = household.inr_rate_set_at ? new Date(household.inr_rate_set_at) : null;
    const when = setAt ? setAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'unknown date';
    const source = household.inr_rate_source === 'auto' ? `refreshed ${when}` : `set ${when}, manual`;
    return `1 AED = ${Number(household.inr_per_aed).toLocaleString('en-IN')} INR · ${source}`;
  }
  return null;
}
