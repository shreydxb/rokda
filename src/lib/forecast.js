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

// Other income once working stops (independence_income rows): rent, part-time
// work, a gratuity. `offset` is the year of independence counted from 0, the
// same way the rows count `starts_after_years`. A yearly row pays from its
// start for `lasts_years` years, or for good when that is null; a lump sum
// pays once, in its start year. All in today's money.
export function incomeInYear(incomes = [], offset) {
  let yearly = 0;
  let lump = 0;
  for (const row of incomes) {
    const amount = Number(row.amount) || 0;
    const start = Number(row.starts_after_years) || 0;
    if (row.kind === 'lump_sum') {
      if (offset === start) lump += amount;
    } else if (offset >= start && (row.lasts_years == null || offset < start + Number(row.lasts_years))) {
      yearly += amount;
    }
  }
  return { yearly, lump };
}

// The independence target, less what lasting income already covers. A yearly
// income that starts the day work stops and never ends does exactly what
// spending less would, so it comes off the spend the target is built on.
// Anything else -- a later start, an end date, a lump sum -- has no honest
// place in a multiple-of-spend target; Drawdown models those year by year, and
// `otherCount` says how many were left out here.
export function independenceTarget(annualSpend, safeWithdrawalPct, incomes = []) {
  const lasting = incomes.filter((r) => r.kind !== 'lump_sum' && !(Number(r.starts_after_years) > 0) && r.lasts_years == null);
  const lastingIncome = lasting.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  return {
    target: fiTarget(Math.max(0, annualSpend - lastingIncome), safeWithdrawalPct),
    lastingIncome,
    otherCount: incomes.length - lasting.length,
  };
}

// The other side of independence: a pot being spent. Everything here is in
// today's money -- the withdrawal stays the same real amount every year and
// the pot grows at the real return -- which is the same as a withdrawal
// rising with inflation on a pot growing at the nominal return.
//
// Each year, other income is spent first; only the rest comes out of the pot,
// at the start of the year, and what is left grows. Income beyond the year's
// spending goes into the pot, as does a lump sum. A year the pot cannot fully
// cover takes what is left. `lastsYears` counts the years covered in full
// before the first shortfall, or is null when there is none inside
// `maxYears`.
export function drawdownPath({ start, annualWithdrawal, rate, maxYears = 60, incomes = [] }) {
  const path = [{ year: 0, balance: start, withdrawn: 0, growth: 0, income: 0 }];
  let balance = start;
  let lastsYears = null;
  for (let y = 1; y <= maxYears; y++) {
    const { yearly, lump } = incomeInYear(incomes, y - 1);
    balance += lump + Math.max(0, yearly - annualWithdrawal);
    const needed = Math.max(0, annualWithdrawal - yearly);
    const withdrawn = Math.min(needed, Math.max(0, balance));
    const after = balance - withdrawn;
    const growth = after > 0 ? after * rate : 0;
    balance = Math.max(0, after + growth);
    path.push({ year: y, balance, withdrawn, growth, income: yearly + lump });
    // A shortfall under a thousandth of a unit is float noise, not a year the
    // pot failed to cover.
    if (lastsYears === null && withdrawn < needed - 1e-3) lastsYears = y - 1;
  }
  return { path, lastsYears };
}

const covers = (args, years) => {
  const { lastsYears } = drawdownPath({ ...args, maxYears: Math.max(years, 1) });
  return lastsYears === null || lastsYears >= years;
};

// Largest x in [lo, hi] for which ok(x) holds, assuming ok is monotone
// (true then false). To within `tolerance`.
function bisect(ok, lo, hi, tolerance) {
  if (!ok(lo)) return lo;
  while (hi - lo > tolerance) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

// The most a pot can pay out each year, in today's money, and still cover
// `years` years. Without other income that is the annuity-due payment, exact;
// with it the timing of each income matters, so it is found by bisection on
// drawdownPath itself, to the nearest unit.
export function sustainableWithdrawal({ start, rate, years, incomes = [] }) {
  if (!(years > 0)) return 0;
  if (!incomes.length) {
    if (start <= 0) return 0;
    if (rate === 0) return start / years;
    return (start * rate) / ((1 + rate) * (1 - (1 + rate) ** -years));
  }
  const incomeTotal = incomes.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const hi = Math.max(0, start) + incomeTotal * (years + 1) + 1;
  return bisect((w) => covers({ start, annualWithdrawal: w, rate, incomes }, years), 0, hi, 0.5);
}

// The pot a yearly spend needs to cover `years` years: the inverse of
// sustainableWithdrawal, found the same two ways.
export function potForWithdrawal({ annualWithdrawal, rate, years, incomes = [] }) {
  if (!(years > 0) || annualWithdrawal <= 0) return 0;
  if (!incomes.length) {
    if (rate === 0) return annualWithdrawal * years;
    return (annualWithdrawal * (1 + rate) * (1 - (1 + rate) ** -years)) / rate;
  }
  const hi = annualWithdrawal * years + 1;
  // Smallest pot that covers: bisect on "does not cover" and step past it.
  const notEnough = bisect((p) => !covers({ start: p, annualWithdrawal, rate, incomes }, years), 0, hi, 0.5);
  return covers({ start: 0, annualWithdrawal, rate, incomes }, years) ? 0 : notEnough + 0.5;
}
