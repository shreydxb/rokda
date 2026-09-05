// Display-currency conversion for hero/portfolio figures. Everything is
// still stored in AED — this only affects what a figure is shown as.
//
// USD is the AED-USD peg: fixed at 3.6725 by the UAE Central Bank since
// 1997, so it's a real constant, not a rate anyone needs to maintain.
// INR floats, so there's no constant to hardcode — it comes from
// households.inr_per_aed, a real number a household member enters by hand
// in Settings (there's no live FX feed yet). When that rate hasn't been
// set, INR stays unavailable rather than guessing one.
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

export function rateNote(code, household) {
  if (code === 'AED') return null;
  if (code === 'USD') return '1 USD = 3.6725 AED · fixed peg';
  if (code === 'INR' && household?.inr_per_aed != null) {
    const setAt = household.inr_rate_set_at ? new Date(household.inr_rate_set_at) : null;
    const when = setAt ? setAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'unknown date';
    return `1 AED = ${Number(household.inr_per_aed).toLocaleString('en-IN')} INR · set ${when}, manual`;
  }
  return null;
}
