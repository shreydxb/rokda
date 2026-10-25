import { incomesWithoutRate } from './forecast';

// How the plan's drawer lists the rows behind the plan: other
// income once work stops, and the costs that start then (Planning audit, 3.13).

// A row set in another currency, in that currency: "₹43,50,000". Null for AED.
export function nativeAmountLabel(row) {
  if (!row.currency || row.currency === 'AED') return null;
  const symbol = { INR: '₹', USD: '$' }[row.currency] ?? `${row.currency} `;
  return `${symbol}${Number(row.amount).toLocaleString(row.currency === 'INR' ? 'en-IN' : 'en-US', { maximumFractionDigits: 0 })}`;
}

const years = (n) => `${n} year${Number(n) === 1 ? '' : 's'}`;

export function describeIncome(row, household) {
  if (incomesWithoutRate([row], household).length) return 'Not counted: no AED/INR rate yet (Settings → Household)';
  if (row.in_year != null) return `Paid in ${row.in_year} · counted on the Life plan in that year`;
  const start = Number(row.starts_after_years) || 0;
  if (row.kind === 'lump_sum') return start === 0 ? 'One-off, in the first year of independence' : `One-off, ${years(start)} in`;
  const from = start === 0 ? 'From the first year' : `From ${years(start)} in`;
  const lasts = row.lasts_years == null ? 'for good' : `for ${years(row.lasts_years)}`;
  return `${from}, ${lasts}`;
}

// "Each person · rising 3% a year above inflation · from the year work stops,
// for good".
export function describeCost(row, household) {
  if (incomesWithoutRate([row], household).length) return 'Not counted: no AED/INR rate yet (Settings → Household)';
  const start = Number(row.starts_after_years) || 0;
  const rise = Number(row.rise_pct) || 0;
  return [
    row.per_person ? 'Each person' : 'The household',
    rise > 0 ? `rising ${rise}% a year above inflation` : 'level in today’s money',
    `${start === 0 ? 'from the year work stops' : `from ${years(start)} after work stops`}, ${row.lasts_years == null ? 'for good' : `for ${years(row.lasts_years)}`}`,
  ].join(' · ');
}
