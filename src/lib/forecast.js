import { scopedValue } from './scope';

// The current, still-open month is excluded — its spend is partial and would
// understate a real month. Forecast is always household-wide ("Both"): an
// individual FI date would need income and spend cleanly split per person,
// which isn't tracked, so scopeMemberId is always null here.
export function closedMonths(transactions, now = new Date()) {
  const byMonth = new Map();
  for (const t of transactions) {
    const d = new Date(t.occurred_at);
    const isCurrentMonth = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    if (isCurrentMonth) continue;
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (!byMonth.has(key)) byMonth.set(key, { income: 0, spend: 0 });
    const bucket = byMonth.get(key);
    const v = scopedValue(t.amount, t, null);
    if (v >= 0) bucket.income += v;
    else bucket.spend += -v;
  }
  return byMonth;
}

// A forecast needs three closed months of spend and at least one account
// valuation to start from — otherwise a target would be invented, not
// derived. Averages over up to the last 12 closed months.
export function forecastInputs(transactions, startNetWorth, now = new Date()) {
  const months = [...closedMonths(transactions, now).values()].slice(-12);
  const monthCount = months.length;
  const ready = monthCount >= 3 && startNetWorth !== null;
  if (!ready) {
    return { ready, monthCount, hasNetWorth: startNetWorth !== null, avgMonthlyIncome: 0, avgMonthlySpend: 0, annualSpend: 0, monthlySaving: 0, startNetWorth: startNetWorth ?? 0 };
  }
  const avgMonthlyIncome = months.reduce((s, m) => s + m.income, 0) / monthCount;
  const avgMonthlySpend = months.reduce((s, m) => s + m.spend, 0) / monthCount;
  return {
    ready,
    monthCount,
    hasNetWorth: true,
    avgMonthlyIncome,
    avgMonthlySpend,
    annualSpend: avgMonthlySpend * 12,
    monthlySaving: avgMonthlyIncome - avgMonthlySpend,
    startNetWorth,
  };
}

export function fiTarget(annualSpend, safeWithdrawalPct) {
  const swr = safeWithdrawalPct / 100;
  if (swr <= 0) return 0;
  return Math.round(annualSpend / swr / 1000) * 1000;
}

// 6% nominal, 2.5% inflation isn't 3.5% real — compounding means it's
// (1+nominal)/(1+inflation) - 1.
export function realReturn(nominalPct, inflationPct) {
  return (1 + nominalPct / 100) / (1 + inflationPct / 100) - 1;
}

function futureValue(years, rate, startNetWorth, annualSaving, mode, inflationPct) {
  let v = startNetWorth;
  const inflation = inflationPct / 100;
  for (let i = 0; i < years; i++) {
    v = v * (1 + rate) + annualSaving * (mode === 'real' ? 1 : (1 + inflation) ** (i + 1));
  }
  return v;
}

function goalAt(years, goal, mode, inflationPct) {
  return mode === 'real' ? goal : goal * (1 + inflationPct / 100) ** years;
}

export function projectSeries({ startYear, startNetWorth, annualSaving, rate, mode, inflationPct, horizonYears = 30, step = 3 }) {
  const points = [];
  for (let n = 0; n <= horizonYears; n += step) {
    points.push({ year: startYear + n, yearsOut: n, value: futureValue(n, rate, startNetWorth, annualSaving, mode, inflationPct) });
  }
  return points;
}

// First year the projection reaches the goal, or null if it doesn't within
// maxYears — an honest "beyond what's shown" rather than an invented date.
export function crossingYear({ startYear, startNetWorth, annualSaving, rate, mode, inflationPct, goal, maxYears = 60 }) {
  for (let n = 0; n <= maxYears; n++) {
    if (futureValue(n, rate, startNetWorth, annualSaving, mode, inflationPct) >= goalAt(n, goal, mode, inflationPct)) {
      return startYear + n;
    }
  }
  return null;
}

export { goalAt, futureValue };
