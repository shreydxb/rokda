import { scopedValue } from './scope';
import { monthKey, parseDay } from './day';
import { applyToIncomeSpend } from './transactionKind';
import { convertToAed } from './currency';

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

// What the household's budget says it will spend and save in a month, for a
// household too new to have three closed months of its own. Spending is every
// expense budget except savings categories; saving is the savings target
// (categories.is_savings). Averaged over the budgeted months from this one
// forward, up to a year out -- what the household plans to do next -- or, when
// nothing ahead is budgeted, the latest twelve before it. Null when no month
// has a spending budget.
const budgetKey = (b) => Number(b.year) * 12 + (Number(b.month) - 1);

function budgetByMonth(budgets, categories) {
  const catById = new Map(categories.map((c) => [c.id, c]));
  const byMonth = new Map();
  for (const b of budgets) {
    const cat = catById.get(b.category_id);
    if (!cat || cat.kind !== 'expense') continue;
    const key = budgetKey(b);
    const m = byMonth.get(key) ?? { spend: 0, saving: 0 };
    if (cat.is_savings) m.saving += Number(b.amount) || 0;
    else m.spend += Number(b.amount) || 0;
    byMonth.set(key, m);
  }
  return byMonth;
}

// The budgeted months a plan is averaged over (see budgetPlan).
function chosenBudgetMonths(byMonth, now) {
  const current = now.getFullYear() * 12 + now.getMonth();
  const budgeted = [...byMonth.keys()].filter((k) => byMonth.get(k).spend > 0).sort((a, b) => a - b);
  const ahead = budgeted.filter((k) => k >= current && k < current + 12);
  return ahead.length ? ahead : budgeted.filter((k) => k < current).slice(-12);
}

export function budgetPlan(budgets = [], categories = [], now = new Date()) {
  const byMonth = budgetByMonth(budgets, categories);
  const chosen = chosenBudgetMonths(byMonth, now);
  if (!chosen.length) return null;
  const avg = (field) => chosen.reduce((s, k) => s + byMonth.get(k)[field], 0) / chosen.length;
  return { monthlySpend: avg('spend'), monthlySaving: avg('saving'), monthCount: chosen.length };
}

// A year's spending in each expense category, on the same basis as
// forecastInputs' annualSpend: the budget's chosen months while it stands in,
// otherwise the last twelve closed months. Savings categories are left out,
// as they are from spending. Keyed by category id.
export function annualSpendByCategory({ inputs, transactions = [], budgets = [], categories = [], now = new Date() }) {
  const spendCats = new Set(categories.filter((c) => c.kind === 'expense' && !c.is_savings).map((c) => c.id));
  const totals = new Map();
  const add = (id, v) => totals.set(id, (totals.get(id) ?? 0) + v);
  if (!inputs?.ready) return totals;
  if (inputs.source === 'budget') {
    const chosen = new Set(chosenBudgetMonths(budgetByMonth(budgets, categories), now));
    for (const b of budgets) {
      if (spendCats.has(b.category_id) && chosen.has(budgetKey(b))) add(b.category_id, ((Number(b.amount) || 0) * 12) / chosen.size);
    }
    return totals;
  }
  const months = new Set([...closedMonths(transactions, now).keys()].slice(-12));
  for (const t of transactions) {
    if (!spendCats.has(t.category_id) || !months.has(monthKey(parseDay(t.occurred_at)))) continue;
    const bucket = { income: 0, spend: 0 };
    applyToIncomeSpend(t, scopedValue(t.amount, t, null), bucket);
    add(t.category_id, (bucket.spend * 12) / months.size);
  }
  return totals;
}

// The part of that spending the household expects to have stopped once work
// does -- rent on a home it will own, a loan's instalments -- from the
// categories marked stops_after_work. The Life plan leaves it out of spending
// after work stops.
export function spendThatStops(args) {
  const byCategory = annualSpendByCategory(args);
  const rows = (args.categories ?? [])
    .filter((c) => c.stops_after_work && byCategory.get(c.id) > 0)
    .map((c) => ({ id: c.id, name: c.name, annual: byCategory.get(c.id) }))
    .sort((a, b) => b.annual - a.annual);
  return { annual: rows.reduce((s, r) => s + r.annual, 0), categories: rows };
}

// A forecast needs three closed months of spend and at least one account
// valuation to start from — otherwise a target would be invented, not
// derived. Averages over up to the last 12 closed months.
//
// Until there are three closed months, a budget (budgetPlan) stands in: the
// household's own stated plan rather than an invented figure. `source` says
// which one the numbers came from -- 'actual' or 'budget' -- so every screen
// can say so, and the budget steps aside by itself once the third month
// closes. From a budget there is no recorded income; saving is the savings
// target, and income is taken as spend plus that saving.
export function forecastInputs(transactions, startNetWorth, now = new Date(), plan = null) {
  const months = [...closedMonths(transactions, now).values()].slice(-12);
  const monthCount = months.length;
  const hasNetWorth = startNetWorth !== null;
  if (monthCount < 3 && hasNetWorth && plan) {
    return {
      ready: true,
      source: 'budget',
      monthCount,
      budgetMonths: plan.monthCount,
      hasNetWorth,
      avgMonthlyIncome: plan.monthlySpend + plan.monthlySaving,
      avgMonthlySpend: plan.monthlySpend,
      annualSpend: plan.monthlySpend * 12,
      monthlySaving: plan.monthlySaving,
      startNetWorth,
    };
  }
  const ready = monthCount >= 3 && hasNetWorth;
  if (!ready) {
    return { ready, source: null, monthCount, hasNetWorth, avgMonthlyIncome: 0, avgMonthlySpend: 0, annualSpend: 0, monthlySaving: 0, startNetWorth: startNetWorth ?? 0 };
  }
  const avgMonthlyIncome = months.reduce((s, m) => s + m.income, 0) / monthCount;
  const avgMonthlySpend = months.reduce((s, m) => s + m.spend, 0) / monthCount;
  return {
    ready,
    source: 'actual',
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
// Other income timed from the year work stops, in AED: a row set in rupees is
// converted at today's rate, and one that cannot be converted (no rate yet) is
// left out rather than counted as dirhams. A lump sum paid in a fixed calendar
// year (`in_year`, a policy maturity) is left out too: it lands whenever that
// year comes, so only the Life plan, which runs by calendar year, places it.
export function incomesFromStop(incomes = [], household = null) {
  return incomes
    .filter((r) => r.in_year == null)
    .map((r) => ({ ...r, amount: convertToAed(Number(r.amount) || 0, r.currency ?? 'AED', household) }))
    .filter((r) => r.amount !== null);
}

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
//
// `returns`, when given, is a real return per year (index 0 is year 1) that
// replaces `rate` wherever it has a number -- see marketReturns.
export function drawdownPath({ start, annualWithdrawal, rate, maxYears = 60, incomes = [], returns = null }) {
  const path = [{ year: 0, balance: start, withdrawn: 0, growth: 0, income: 0 }];
  let balance = start;
  let lastsYears = null;
  for (let y = 1; y <= maxYears; y++) {
    const { yearly, lump } = incomeInYear(incomes, y - 1);
    balance += lump + Math.max(0, yearly - annualWithdrawal);
    const needed = Math.max(0, annualWithdrawal - yearly);
    const withdrawn = Math.min(needed, Math.max(0, balance));
    const after = balance - withdrawn;
    const r = returns?.[y - 1] ?? rate;
    const growth = after > 0 ? after * r : 0;
    balance = Math.max(0, after + growth);
    path.push({ year: y, balance, withdrawn, growth, income: yearly + lump, rate: r });
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
// `years` years. With a steady return and no other income that is the
// annuity-due payment, exact; otherwise the timing of each income or bad year
// matters, so it is found by bisection on drawdownPath itself, to the nearest
// unit.
export function sustainableWithdrawal({ start, rate, years, incomes = [], returns = null }) {
  if (!(years > 0)) return 0;
  if (!incomes.length && !returns) {
    if (start <= 0) return 0;
    if (rate === 0) return start / years;
    return (start * rate) / ((1 + rate) * (1 - (1 + rate) ** -years));
  }
  const incomeTotal = incomes.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const hi = Math.max(0, start) + incomeTotal * (years + 1) + 1;
  return bisect((w) => covers({ start, annualWithdrawal: w, rate, incomes, returns }, years), 0, hi, 0.5);
}

// The pot a yearly spend needs to cover `years` years: the inverse of
// sustainableWithdrawal, found the same two ways.
export function potForWithdrawal({ annualWithdrawal, rate, years, incomes = [], returns = null }) {
  if (!(years > 0) || annualWithdrawal <= 0) return 0;
  if (!incomes.length && !returns) {
    if (rate === 0) return annualWithdrawal * years;
    return (annualWithdrawal * (1 + rate) * (1 - (1 + rate) ** -years)) / rate;
  }
  const args = { annualWithdrawal, rate, incomes, returns };
  // A pot big enough for every year to lose as much as the worst year is
  // surely enough: each year's spending, grown back by what that loss takes.
  const worst = Math.max(-0.99, Math.min(rate, ...(returns ?? []).filter(Number.isFinite)));
  const hi = worst < 0 ? annualWithdrawal * years * (1 + worst) ** -years + 1 : annualWithdrawal * years + 1;
  // Smallest pot that covers: bisect on "does not cover" and step past it.
  const notEnough = bisect((p) => !covers({ ...args, start: p }, years), 0, hi, 0.5);
  return covers({ ...args, start: 0 }, years) ? 0 : notEnough + 0.5;
}

// A market fall while the pot is being spent: this real return in the first
// year of it, then the second, then back to the steady return. Illustrative,
// not a forecast -- about what a pot of mixed investments and cash lost after
// inflation in a bad stretch such as 2008.
export const MARKET_FALL = [-0.2, -0.1];

// Year-by-year real returns for drawdownPath: null for a steady return, else
// the steady rate with MARKET_FALL starting in `fallYear` (1 = the first year
// of independence). The same fall early or late shows sequence risk alone:
// the returns are the same set of numbers, only their order differs.
export function marketReturns(rate, fallYear, maxYears = 60) {
  if (!fallYear) return null;
  return Array.from({ length: maxYears }, (_, i) => {
    const k = i + 1 - fallYear;
    return k >= 0 && k < MARKET_FALL.length ? MARKET_FALL[k] : rate;
  });
}
