export function formatMoney(amount, { decimals = 0 } = {}) {
  const n = Number(amount) || 0;
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Math.abs(n));
}

export function formatSigned(amount, opts) {
  const n = Number(amount) || 0;
  const sign = n < 0 ? '−' : n > 0 ? '+' : '';
  return sign + formatMoney(n, opts);
}

export function formatPct(fraction, { decimals = 0 } = {}) {
  if (!Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(decimals)}%`;
}
