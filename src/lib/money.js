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

// Sign-preserving and abbreviated — 850, 12.5K, 1.2M — for chart axes and
// other places too narrow for a full figure. Never for a figure that stands
// on its own: rounding 1,249,000 to 1.2M is fine on a tick, not in a total.
export function formatCompact(amount) {
  const n = Number(amount) || 0;
  const abs = Math.abs(n);
  if (abs < 0.5) return '0';
  const sign = n < 0 ? '−' : '';
  const units = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
    [1, ''],
  ];
  for (let i = 0; i < units.length; i++) {
    const [unit, suffix] = units[i];
    if (abs < unit && unit > 1) continue;
    const value = suffix ? Number((abs / unit).toFixed(abs / unit >= 100 ? 0 : 1)) : Math.round(abs);
    // A value that rounds up to 1000 of one unit reads in the next one up:
    // 999,960 is 1M, not 1000K.
    if (value >= 1000 && i > 0) {
      const [bigger, biggerSuffix] = units[i - 1];
      return `${sign}${Number((abs / bigger).toFixed(1))}${biggerSuffix}`;
    }
    return `${sign}${value}${suffix}`;
  }
  return '0';
}

export function formatPct(fraction, { decimals = 0 } = {}) {
  if (!Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(decimals)}%`;
}
