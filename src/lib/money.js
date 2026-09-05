// Three formatters, deliberately distinct (QA-08, SHR-249).
//
// `formatMoney` is a MAGNITUDE formatter: it drops the sign. It is correct
// where the UI supplies the sign itself — an expense row that renders its own
// "−", a budget line that is a size rather than a direction — and wrong for any
// figure that can legitimately be negative. A net worth of −100 formatted with
// it reads as 100, which is the defect this split exists to prevent.
export function formatMoney(amount, { decimals = 0 } = {}) {
  const n = Number(amount) || 0;
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Math.abs(n));
}

// Sign-preserving: negatives keep their minus, positives are undecorated. This
// is the formatter for anything that can genuinely go either way — net worth,
// net saved, account balances, a signed transaction amount.
export function formatBalance(amount, opts) {
  const n = Number(amount) || 0;
  return (n < 0 ? '−' : '') + formatMoney(n, opts);
}

// Explicitly signed, including a leading "+" — for deltas and changes, where
// the direction is the point.
export function formatSigned(amount, opts) {
  const n = Number(amount) || 0;
  const sign = n < 0 ? '−' : n > 0 ? '+' : '';
  return sign + formatMoney(n, opts);
}

export function formatPct(fraction, { decimals = 0 } = {}) {
  if (!Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(decimals)}%`;
}
