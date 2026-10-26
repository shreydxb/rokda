import { scopedValue } from './scope';
import { monthKey, parseDay } from './day';
import { applyToIncomeSpend } from './transactionKind';
import { categoryParts } from './splits';
import { convertToAed } from './currency';
import { matchWindowDays, occurrenceAt } from './recurring';
import { PLANNING_DEFAULTS, assumptionsSaved } from './planningDefaults';

// The current, still-open month is excluded — its spend is partial and would
// understate a real month. The plan is always household-wide ("Both"): an
// individual stop year would need income and spend cleanly split per person,
// which isn't tracked, so scopeMemberId is always null here.
export function closedMonths(transactions, now = new Date()) {
  const byMonth = new Map();
  const currentMonth = monthKey(now);
  for (const t of transactions) {
    // A salary is counted in the month it is for (payMonthTransactions).
    const key = monthKey(parseDay(t.pay_month_date ?? t.occurred_at));
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

// Salary is paid on a date that moves: a bank holiday brings it forward, a
// payroll cut-off pushes it back, sometimes into the next month. Counted by
// the day it landed, one month would show no salary and the next two, and
// with only a few closed months that swings every average built on them.
//
// So an income transaction that matches an expected-income reminder (same
// account and category where the reminder names them, an amount within 20%,
// within the reminder's window of an occurrence) is counted in the month of
// that occurrence: `pay_month_date` carries it, and closedMonths reads it
// before the date it landed. Everything else is returned unchanged.
const PERIOD_DAYS = { weekly: 7, monthly: 30.44, quarterly: 91.31, yearly: 365.25 };

function nearestOccurrence(row, date) {
  const anchor = parseDay(row.next_due_date);
  const every = Math.max(1, Number(row.interval_count) || 1);
  const period = (PERIOD_DAYS[row.cadence] ?? 30.44) * every;
  const guess = Math.round((date - anchor) / 86400000 / period);
  let best = null;
  for (let n = guess - 1; n <= guess + 1; n++) {
    const occurrence = occurrenceAt(row.next_due_date, row.cadence, n, row.interval_count);
    if (!best || Math.abs(occurrence - date) < Math.abs(best - date)) best = occurrence;
  }
  return best;
}

// Each income row an expected-income reminder claims, with the occurrence it
// is for. Rows nothing claims are left out.
function payMatches(transactions, recurring) {
  const expected = recurring.filter((r) => Number(r.amount) > 0 && r.active !== false && r.next_due_date && r.cadence);
  const matches = new Map();
  if (!expected.length) return matches;
  for (const t of transactions) {
    if (t.kind !== 'income' || !(Number(t.amount) > 0)) continue;
    const landed = parseDay(t.occurred_at);
    for (const r of expected) {
      if (r.account_id && t.account_id !== r.account_id) continue;
      if (r.category_id && t.category_id !== r.category_id) continue;
      const amount = Number(r.amount);
      if (Math.abs(Number(t.amount) - amount) > amount * 0.2) continue;
      const due = nearestOccurrence(r, landed);
      if (Math.abs(due - landed) > matchWindowDays(r) * 86400000) continue;
      matches.set(t, { reminder: r, due });
      break;
    }
  }
  return matches;
}

export function payMonthTransactions(transactions = [], recurring = []) {
  const matches = payMatches(transactions, recurring);
  if (!matches.size) return transactions;
  return transactions.map((t) => {
    const match = matches.get(t);
    if (!match || monthKey(match.due) === monthKey(parseDay(t.occurred_at))) return t;
    const { due } = match;
    const y = due.getFullYear();
    const m = String(due.getMonth() + 1).padStart(2, '0');
    const d = String(due.getDate()).padStart(2, '0');
    return { ...t, pay_month_date: `${y}-${m}-${d}` };
  });
}

// The closed months every Planning figure is averaged over: each salary in
// the month it is for (payMonthTransactions), oldest first. Where the records
// begin, moving pay can make two months that are not the household's:
//   * pay for the month before the first record, counted in a month with no
//     spending recorded at all, which then reads as a month of pure saving;
//   * the first month with its spending but without its pay, which landed
//     before the records began and so was never recorded.
// The first is not a month of records, so it is never counted. The second is
// left out, rather than counted as a month of spending with nothing earned.
export function planningMonths(transactions = [], recurring = [], now = new Date()) {
  const months = closedMonths(payMonthTransactions(transactions, recurring), now);
  if (!transactions.length) return months;
  const first = transactions.reduce((min, t) => {
    const key = monthKey(parseDay(t.occurred_at));
    return key < min ? key : min;
  }, '9999-99');
  for (const key of [...months.keys()]) if (key < first) months.delete(key);
  // A reminder whose pay landed in the first month and counts for a later
  // one, with none of its pay counted for the first month.
  const payMonthsByReminder = new Map();
  const movedOutOfFirst = new Set();
  for (const [t, { reminder, due }] of payMatches(transactions, recurring)) {
    const counted = monthKey(due);
    if (!payMonthsByReminder.has(reminder)) payMonthsByReminder.set(reminder, new Set());
    payMonthsByReminder.get(reminder).add(counted);
    if (monthKey(parseDay(t.occurred_at)) === first && counted > first) movedOutOfFirst.add(reminder);
  }
  if ([...movedOutOfFirst].some((r) => !payMonthsByReminder.get(r).has(first))) months.delete(first);
  return months;
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
  // The very months forecastInputs averaged over, so a category's share of
  // spending is the share of the same months.
  const months = new Set(inputs.months ?? []);
  if (!months.size) return totals;
  for (const t of transactions) {
    if (!months.has(monthKey(parseDay(t.occurred_at)))) continue;
    for (const part of categoryParts(t)) {
      if (!spendCats.has(part.categoryId)) continue;
      const bucket = { income: 0, spend: 0 };
      applyToIncomeSpend(t, scopedValue(part.amount, t, null), bucket);
      add(part.categoryId, (bucket.spend * 12) / months.size);
    }
  }
  return totals;
}

// The part of that spending the household expects to have stopped once work
// does -- rent on a home it will own, a loan's instalments -- from the
// categories marked stops_after_work. The Life plan leaves it out of spending
// after work stops. `byCategory` is every category's year, for the editor that
// marks them, so it is not worked out twice.
export function spendThatStops(args) {
  const byCategory = annualSpendByCategory(args);
  const rows = (args.categories ?? [])
    .filter((c) => c.stops_after_work && byCategory.get(c.id) > 0)
    .map((c) => ({ id: c.id, name: c.name, annual: byCategory.get(c.id) }))
    .sort((a, b) => b.annual - a.annual);
  return { annual: rows.reduce((s, r) => s + r.annual, 0), categories: rows, byCategory };
}

// The basis the household chose for its planning figures, from its saved
// assumptions (Planning audit, 2.9): `basis` is 'budget', 'recorded', or null
// when nothing is chosen, and `recordsFrom` the first month recorded months
// count from, 'YYYY-MM', or null for all of them.
export const PLANNING_BASES = ['budget', 'recorded'];
export function basisChoice(assumptions) {
  const basis = PLANNING_BASES.includes(assumptions?.planning_basis) ? assumptions.planning_basis : null;
  const recordsFrom = assumptions?.records_from ? String(assumptions.records_from).slice(0, 7) : null;
  return { basis, recordsFrom };
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "Oct 2026" for the month key "2026-10".
export function monthKeyLabel(key) {
  const [year, month] = String(key).split('-').map(Number);
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

// The months the records can be counted from: every month from the first one
// recorded to this one, newest first. This month is offered too, so a
// household can start counting from it before it has ended.
export function recordsFromOptions(recordedMonths = [], now = new Date()) {
  const current = monthKey(now);
  const first = recordedMonths.length && recordedMonths[0] < current ? recordedMonths[0] : current;
  const keys = [];
  for (let d = new Date(now.getFullYear(), now.getMonth(), 1); monthKey(d) >= first; d.setMonth(d.getMonth() - 1)) keys.push(monthKey(d));
  return keys;
}

// A forecast needs three ended months of spend and at least one account
// valuation to start from — otherwise a target would be invented, not
// derived. Averages over up to the last 12 ended months, from the month the
// household says its records count from: a first month or two recorded in
// part read as months of saving everything.
//
// Which figures the plan rests on is the household's choice (`choice`, from
// basisChoice; Planning audit, 2.9):
//   budget:     the budget (budgetPlan), the plan it wrote down, whatever is
//               recorded; the recorded months stand in only while no month
//               has a spending budget;
//   recorded:   the recorded months; the budget stands in until three have
//               ended;
//   not chosen: as recorded, the old rule, said as not chosen.
// `source` says which one the numbers came from -- 'actual' or 'budget' --
// and `why` why: 'chosen'; 'few-months', the budget standing in until three
// months have ended; 'no-budget', the records standing in for a budget that
// isn't there; or 'not-chosen'. From a budget there is no recorded income;
// saving is the savings target, and income is taken as spend plus that
// saving. `recordedMonths` is every ended month on record, for choosing
// where they count from.
export function forecastInputs(transactions, startNetWorth, now = new Date(), plan = null, recurring = [], choice = {}) {
  const { basis = null, recordsFrom = null } = choice;
  const all = [...planningMonths(transactions, recurring, now).entries()];
  const recent = all.filter(([key]) => !recordsFrom || key >= recordsFrom).slice(-12);
  const months = recent.map(([, m]) => m);
  const monthCount = months.length;
  const hasNetWorth = startNetWorth !== null;
  const told = (inputs, why) => ({ ...inputs, basis, recordsFrom, why, recordedMonths: all.map(([key]) => key) });
  if (basis === 'budget' && hasNetWorth && plan) return told(budgetInputs(plan, startNetWorth, monthCount), 'chosen');
  if (monthCount < 3 && hasNetWorth && plan) return told(budgetInputs(plan, startNetWorth, monthCount), 'few-months');
  const ready = monthCount >= 3 && hasNetWorth;
  if (!ready) {
    return told(
      { ready, source: null, monthCount, hasNetWorth, avgMonthlyIncome: 0, avgMonthlySpend: 0, annualSpend: 0, monthlySaving: 0, startNetWorth: startNetWorth ?? 0 },
      basis === 'budget' ? 'no-budget' : null
    );
  }
  const avgMonthlyIncome = months.reduce((s, m) => s + m.income, 0) / monthCount;
  const avgMonthlySpend = months.reduce((s, m) => s + m.spend, 0) / monthCount;
  return told(
    {
      ready,
      source: 'actual',
      monthCount,
      months: recent.map(([key]) => key),
      hasNetWorth: true,
      avgMonthlyIncome,
      avgMonthlySpend,
      annualSpend: avgMonthlySpend * 12,
      monthlySaving: avgMonthlyIncome - avgMonthlySpend,
      startNetWorth,
    },
    basis === 'recorded' ? 'chosen' : basis === 'budget' ? 'no-budget' : 'not-chosen'
  );
}

// The same inputs on the budget's figures, however many months are recorded:
// the plan as the household wrote it down. Where the plan rests on the
// records, the screens that give the answer show the budget's beside them
// rather than dropping it from view (Planning audit, 1.2). Null without a
// budget or an account valuation to start from.
export function budgetInputs(plan, startNetWorth, monthCount = 0) {
  if (!plan || startNetWorth === null) return null;
  return {
    ready: true,
    source: 'budget',
    monthCount,
    budgetMonths: plan.monthCount,
    hasNetWorth: true,
    avgMonthlyIncome: plan.monthlySpend + plan.monthlySaving,
    avgMonthlySpend: plan.monthlySpend,
    annualSpend: plan.monthlySpend * 12,
    monthlySaving: plan.monthlySaving,
    startNetWorth,
  };
}

// 6% nominal, 2.5% inflation isn't 3.5% real — compounding means it's
// (1+nominal)/(1+inflation) - 1.
export function realReturn(nominalPct, inflationPct) {
  return (1 + nominalPct / 100) / (1 + inflationPct / 100) - 1;
}

// Conservative/Optimistic are derived from the baseline assumptions rather
// than stored (±2pp nominal, ∓1pp inflation). Custom is the one set a
// household actually edits independently, so it falls back to the baseline
// numbers until it's been saved once, and any figure saved blank keeps
// following Baseline's after that.
export function scenarioSets(assumptions, defaults = PLANNING_DEFAULTS) {
  const nominal = assumptions?.nominal_return_pct != null ? Number(assumptions.nominal_return_pct) : defaults.nominal_return_pct;
  const inflation = assumptions?.inflation_pct != null ? Number(assumptions.inflation_pct) : defaults.inflation_pct;
  const hasCustom = assumptions?.custom_updated_at != null;
  const custom = (column, fallback) => (hasCustom && assumptions[column] != null ? Number(assumptions[column]) : fallback);

  return {
    // Until the household saves its own, Baseline is the app's defaults, and
    // says so (Planning audit, 1.3).
    baseline: {
      key: 'baseline',
      label: 'Baseline',
      saved: assumptionsSaved(assumptions),
      meta: assumptionsSaved(assumptions) ? 'Your saved assumptions' : 'Defaults, nothing saved',
      nominalPct: nominal,
      inflationPct: inflation,
    },
    conservative: {
      key: 'conservative',
      label: 'Conservative',
      meta: 'Derived from Baseline · not edited',
      nominalPct: Math.max(0, nominal - 2),
      inflationPct: inflation + 1,
    },
    optimistic: {
      key: 'optimistic',
      label: 'Optimistic',
      meta: 'Derived from Baseline · not edited',
      nominalPct: nominal + 2,
      inflationPct: Math.max(0, inflation - 1),
    },
    custom: {
      key: 'custom',
      label: 'Custom',
      meta: hasCustom ? 'Your own assumptions' : 'Not set yet — edit to start from Baseline',
      nominalPct: custom('custom_nominal_return_pct', nominal),
      inflationPct: custom('custom_inflation_pct', inflation),
    },
  };
}

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

// The other income no plan counts yet: rows in a currency with no rate to AED
// (rupees before the household sets its AED/INR rate). They are left out of
// every figure, so the screens that list them say so: the list read "counted"
// while the Life plan quietly left them out (Planning audit, 0b-D).
export function incomesWithoutRate(incomes = [], household = null) {
  return incomes.filter((r) => convertToAed(1, r.currency ?? 'AED', household) === null);
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

// A market fall while the pot is being spent: this real return in the first
// year of it, then the second, then back to the steady return. Illustrative,
// not a forecast -- about what a pot of mixed investments and cash lost after
// inflation in a bad stretch such as 2008.
export const MARKET_FALL = [-0.2, -0.1];
