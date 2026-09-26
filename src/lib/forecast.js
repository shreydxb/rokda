import { scopedValue } from './scope';
import { monthKey, parseDay } from './day';
import { applyToIncomeSpend } from './transactionKind';

// The current, still-open month is excluded — its spend is partial and would
// understate a real month. Forecast is always household-wide ("Both"): an
// individual FI date would need income and spend cleanly split per person,
// which isn't tracked, so scopeMemberId is always null here.
export function closedMonths(transactions, now = new Date()) {
  const byMonth = new Map();
  const currentMonth = monthKey(now);
  for (const t of transactions) {
    const key = monthKey(parseDay(t.occurred_at));
    // A month is closed only if it is behind the current one. Excluding just
    // the current month let future-dated records become forecast history
    // (QA-06).
    if (key >= currentMonth) continue;
    if (!byMonth.has(key)) byMonth.set(key, { income: 0, spend: 0 });
    const bucket = byMonth.get(key);
    // A refund nets against spend rather than inflating income, the same as
    // every other consumer of transaction amounts (SHR-252).
    applyToIncomeSpend(t, scopedValue(t.amount, t, null), bucket);
  }
  // Chronological, so "the last 12 closed months" means the newest twelve
  // rather than whichever twelve happened to be inserted last.
  return new Map([...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])));
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

// Conservative/Optimistic are derived from the baseline assumptions rather
// than stored, matching the offsets already used for the "if things change"
// scenarios elsewhere on this screen (±2pp nominal). Custom is the one set a
// household actually edits independently, so it falls back to the baseline
// numbers until it's been saved once.
export function scenarioSets(assumptions, defaults) {
  const nominal = assumptions?.nominal_return_pct != null ? Number(assumptions.nominal_return_pct) : defaults.nominal_return_pct;
  const inflation = assumptions?.inflation_pct != null ? Number(assumptions.inflation_pct) : defaults.inflation_pct;
  const swr = assumptions?.safe_withdrawal_pct != null ? Number(assumptions.safe_withdrawal_pct) : defaults.safe_withdrawal_pct;
  const hasCustom = assumptions?.custom_updated_at != null;

  return {
    baseline: { key: 'baseline', label: 'Baseline', meta: 'Your saved assumptions', nominalPct: nominal, inflationPct: inflation, swrPct: swr },
    conservative: {
      key: 'conservative',
      label: 'Conservative',
      meta: 'Derived from Baseline · not edited',
      nominalPct: Math.max(0, nominal - 2),
      inflationPct: inflation + 1,
      swrPct: swr,
    },
    optimistic: {
      key: 'optimistic',
      label: 'Optimistic',
      meta: 'Derived from Baseline · not edited',
      nominalPct: nominal + 2,
      inflationPct: Math.max(0, inflation - 1),
      swrPct: swr,
    },
    custom: {
      key: 'custom',
      label: 'Custom',
      meta: hasCustom ? 'Your own assumptions' : 'Not set yet — edit to start from Baseline',
      nominalPct: hasCustom ? Number(assumptions.custom_nominal_return_pct) : nominal,
      inflationPct: hasCustom ? Number(assumptions.custom_inflation_pct) : inflation,
      swrPct: hasCustom ? Number(assumptions.custom_safe_withdrawal_pct) : swr,
    },
  };
}

// Year-by-year path of a projection, split into what it is made of: the
// starting net worth, the saving added on top of it, and the growth on both.
// The same loop as futureValue, so `value` is identical to it for every year
// and the three parts always add up to `value`.
export function projectYears({ startNetWorth, annualSaving, rate, mode, inflationPct, years }) {
  const inflation = inflationPct / 100;
  let value = startNetWorth;
  let saved = 0;
  const out = [{ yearsOut: 0, value, start: startNetWorth, saved: 0, growth: 0 }];
  for (let i = 0; i < years; i++) {
    const added = annualSaving * (mode === 'real' ? 1 : (1 + inflation) ** (i + 1));
    value = value * (1 + rate) + added;
    saved += added;
    out.push({ yearsOut: i + 1, value, start: startNetWorth, saved, growth: value - startNetWorth - saved });
  }
  return out;
}

// The saving a year it would take to reach the goal in exactly `years` --
// the solve-for-the-payment direction of crossingYear. The projection is
// linear in the saving, value = start's growth + saving x (what one unit a
// year compounds to), so this is exact rather than a search. In nominal mode
// the saving grows with inflation exactly as it does in the projection, so
// the figure is in today's money either way.
//
// 0 when growth on the starting net worth gets there alone; null when there
// is no year to solve for.
export function requiredAnnualSaving({ startNetWorth, rate, mode, inflationPct, goal, years }) {
  if (!(years > 0)) return null;
  const fromStart = futureValue(years, rate, startNetWorth, 0, mode, inflationPct);
  const perUnit = futureValue(years, rate, 0, 1, mode, inflationPct);
  const needed = goalAt(years, goal, mode, inflationPct) - fromStart;
  if (needed <= 0) return 0;
  return needed / perUnit;
}

export { goalAt, futureValue };

// The other side of independence: a pot being spent. Everything here is in
// today's money -- the withdrawal stays the same real amount every year and
// the pot grows at the real return -- which is the same as a withdrawal
// rising with inflation on a pot growing at the nominal return.
//
// Each year's spending comes out at the start of the year and the rest grows.
// A year the pot cannot fully cover takes what is left and the pot is empty
// from then on; `lastsYears` counts the years that were covered in full, or is
// null when the pot never runs short inside `maxYears`.
export function drawdownPath({ start, annualWithdrawal, rate, maxYears = 60 }) {
  const path = [{ year: 0, balance: start, withdrawn: 0, growth: 0 }];
  let balance = start;
  let lastsYears = null;
  for (let y = 1; y <= maxYears; y++) {
    const withdrawn = Math.min(annualWithdrawal, Math.max(0, balance));
    const after = balance - withdrawn;
    const growth = after > 0 ? after * rate : 0;
    balance = Math.max(0, after + growth);
    path.push({ year: y, balance, withdrawn, growth });
    // A shortfall under a thousandth of a unit is float noise, not a year the
    // pot failed to cover.
    if (lastsYears === null && withdrawn < annualWithdrawal - 1e-3) lastsYears = y - 1;
  }
  return { path, lastsYears };
}

// The most a pot can pay out each year, in today's money, and run out after
// exactly `years` -- the annuity-due payment, since each year's spending comes
// out at its start.
export function sustainableWithdrawal({ start, rate, years }) {
  if (!(years > 0) || start <= 0) return 0;
  if (rate === 0) return start / years;
  return (start * rate) / ((1 + rate) * (1 - (1 + rate) ** -years));
}

// The pot a yearly spend needs to last `years`: the inverse of
// sustainableWithdrawal.
export function potForWithdrawal({ annualWithdrawal, rate, years }) {
  if (!(years > 0) || annualWithdrawal <= 0) return 0;
  if (rate === 0) return annualWithdrawal * years;
  return (annualWithdrawal * (1 + rate) * (1 - (1 + rate) ** -years)) / rate;
}
