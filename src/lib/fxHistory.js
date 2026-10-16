// Exchange rates by day (docs/decisions.md, "A payment in rupees keeps both
// amounts"; SHR-321). fx_rate_history keeps one rate per day per pair, so a
// payment is estimated, and shown, at its own date's rate rather than
// today's. The app and the price refresh share this file
// (supabase/functions/_shared/applib/fxHistory.js is a copy).

// The dirham is pegged to the dollar, so a dollar amount converts exactly.
export const AED_PER_USD = 3.6725;

const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;

// The rupees per dirham on a day: that day's rate, or the latest one before
// it (no rate is published at a weekend, and a refresh can miss a day). Null
// when history holds nothing on or before it. `day` is YYYY-MM-DD.
export function inrPerAedOn(history = [], day) {
  let best = null;
  for (const row of history) {
    if (row.base !== 'AED' || row.quote !== 'INR' || !(Number(row.rate) > 0)) continue;
    if (row.day > day) continue;
    if (!best || row.day > best.day) best = row;
  }
  return best ? { rate: Number(best.rate), day: best.day } : null;
}

// The AED a payment in another currency comes to on its day, to the fil,
// with where the rate came from. Null when there is no rate to use: a
// missing rate means the value is unknown, never one-for-one. `currentRate`
// (households.inr_per_aed) is used only when history has nothing on or
// before the day, and says so.
export function estimateAed(nativeAmount, currency, day, history = [], currentRate = null) {
  const amount = Number(nativeAmount);
  if (!Number.isFinite(amount)) return null;
  if (currency === 'AED') return { aed: round(amount, 2), rate: 1, rateDay: day, source: 'aed' };
  if (currency === 'USD') return { aed: round(amount * AED_PER_USD, 2), rate: 1 / AED_PER_USD, rateDay: day, source: 'peg' };
  if (currency === 'INR') {
    const onDay = inrPerAedOn(history, day);
    if (onDay) return { aed: round(amount / onDay.rate, 2), rate: onDay.rate, rateDay: onDay.day, source: 'history' };
    if (Number(currentRate) > 0) return { aed: round(amount / Number(currentRate), 2), rate: Number(currentRate), rateDay: null, source: 'current' };
  }
  return null;
}

// History rows from an ECB time series of rupees per dollar (Frankfurter's
// `{"rates": {"2026-01-02": {"INR": 85.6}, ...}}`), as rupees per dirham
// through the peg. Days with no usable figure are skipped.
export function historyRowsFromEcb(body) {
  const rates = body && typeof body === 'object' ? body.rates : null;
  if (!rates || typeof rates !== 'object') return [];
  return Object.entries(rates)
    .filter(([day, r]) => /^\d{4}-\d{2}-\d{2}$/.test(day) && Number(r?.INR) > 0)
    .map(([day, r]) => ({ base: 'AED', quote: 'INR', day, rate: round(Number(r.INR) / AED_PER_USD, 6), source: 'ecb' }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}
