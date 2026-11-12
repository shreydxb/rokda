import { incomeInYear } from './forecast';
import { convertToAed } from './currency';
import { parseDay } from './day';
import { goalInflationPct, isDone } from './goals';

// The life plan: one year-by-year timeline from this year to the end of the
// longest life expectancy, the calculation a financial adviser's "cash
// adequacy" sheet does. While working, the pot grows and the year's saving is
// added; each goal is paid out of the pot in its year; once work stops,
// spending comes out of the pot after any other income. The question it
// answers is the one the sheet exists for: does the money last, and if not,
// in which year does it run out.
//
// Everything is in today's money: the pot grows at the real return, saving
// and spending keep their buying power. It is one formula applied to every
// year, so no year can be computed differently from its neighbours -- the
// adviser's sheets had exactly that fault.
//
// A working year's saving is added at the end of the year and the pot grows
// on what it held. A year without work has its spending taken at the start of
// the year, other income first, and only the rest from the pot; a goal is
// paid at the start of its year either way. What
// the pot cannot pay is a shortfall, and the first year with one is the year
// the plan runs out.
//
// While working, the pot can be below zero: a loan larger than the accounts,
// or years of spending more than is earned. That is debt the saving goes on
// repaying. It earns nothing, as the loan's own cost is in the recorded
// spending already, and it is carried rather than forgiven. It cannot pay a
// goal, and once work stops nothing repays it, so what is still owed then is a
// shortfall and the pot starts again from zero.

// Each person is planned for until the end of the year they reach their life
// expectancy. The plan ends when the last of them does.
export function planEndYear(people) {
  return Math.max(...people.map((p) => p.birthYear + p.lifeExpectancy));
}

function plannedCount(people, year) {
  return people.filter((p) => year <= p.birthYear + p.lifeExpectancy).length;
}

export function agesIn(people, year) {
  return people.map((p) => ({ name: p.name, age: year - p.birthYear, planned: year <= p.birthYear + p.lifeExpectancy }));
}

// Dated goals the plan pays out of the pot, in today's money. A target that
// is the amount on the date is brought back at the general inflation rate. A
// target stated as today's cost grows at the goal's own rate, so in today's
// money it moves only by the difference: a villa rising at 8% while prices
// rise at 2.5% costs more of today's money each year it waits. A date already
// past is paid this year. Goals with no date, marked as money kept rather
// than spent (an emergency fund), or marked done stay off the timeline.
export function goalsOnTimeline(goals, startYear, inflationPct) {
  const inflation = inflationPct / 100;
  return goals
    .filter((g) => g.target_date && g.counts_in_life_plan !== false && !isDone(g) && Number(g.target_amount) > 0)
    .map((g) => {
      const year = Math.max(startYear, parseDay(g.target_date).getFullYear());
      const n = year - startYear;
      const target = Number(g.target_amount);
      const amount = g.cost_today ? target * ((1 + goalInflationPct(g, inflationPct) / 100) / (1 + inflation)) ** n : target / (1 + inflation) ** n;
      return { id: g.id, name: g.name, year, amount };
    })
    .sort((a, b) => a.year - b.year);
}

// Lump sums paid in a fixed year -- a policy maturing in 2044 -- in today's
// money. The amount is what will be paid that year, like a goal's amount on
// its date, so it is converted to AED at today's rate and brought back at the
// general inflation rate. The rupee's own drift against the dirham is a stress
// case (rupeeDrift), not the plan. A year already past has been paid, and one
// with no rate yet is left out.
export function datedIncomesOnTimeline(incomes, startYear, inflationPct, household = null) {
  const inflation = inflationPct / 100;
  return incomes
    .filter((r) => r.in_year != null && Number(r.in_year) >= startYear)
    .map((r) => {
      const aed = convertToAed(Number(r.amount) || 0, r.currency ?? 'AED', household);
      if (aed === null) return null;
      const year = Number(r.in_year);
      return { id: r.id, name: r.name, year, amount: aed / (1 + inflation) ** (year - startYear), inr: r.currency === 'INR' };
    })
    .filter(Boolean)
    .sort((a, b) => a.year - b.year);
}

// The costs that start when work stops (after_work_costs rows): health cover,
// which an employer pays until then, and residence visa fees. Each is a year's
// cost in today's money at today's prices and ages, converted to AED at
// today's rate; one in a currency with no rate yet is left out, as other
// income is (incomesWithoutRate names both). `since` is the year their rise is
// counted from, the plan's first, fixed here because potNeededAt starts the
// timeline again at the stop year.
export function costsAfterWork(rows = [], household = null, since = new Date().getFullYear()) {
  return rows
    .map((r) => {
      const amount = convertToAed(Number(r.amount) || 0, r.currency ?? 'AED', household);
      if (amount === null) return null;
      return {
        id: r.id,
        name: r.name,
        amount,
        perPerson: !!r.per_person,
        risePct: Number(r.rise_pct) || 0,
        startsAfterYears: Number(r.starts_after_years) || 0,
        lastsYears: r.lasts_years == null ? null : Number(r.lasts_years),
        since,
        inr: r.currency === 'INR',
      };
    })
    .filter(Boolean);
}

// What those costs come to in `year`, in today's money, for a plan whose work
// stops in `retireYear`. Timing counts from that year, as other income's does.
// Each rises at its own rate above inflation from `since`, so health cover
// priced at today's ages costs more by the time work stops and goes on rising;
// one for each person counts once for each person still planned for, so cover
// for two halves when one remains. `fx` is what a rupee is worth that year
// against today, for the rupee drift case (rupeeDrift); a cost set in rupees
// is multiplied by it.
export function costInYear(costs = [], people = [], year, retireYear, fx = 1) {
  const offset = year - retireYear;
  const planned = plannedCount(people, year);
  return costs.reduce((s, c) => {
    if (offset < c.startsAfterYears || (c.lastsYears != null && offset >= c.startsAfterYears + c.lastsYears)) return s;
    return s + c.amount * (1 + c.risePct / 100) ** Math.max(0, year - c.since) * (c.perPerson ? planned : 1) * (c.inr ? fx : 1);
  }, 0);
}

// The share of this year still to come. The plan starts today, so this year
// is credited with that share of its saving, growth, spending and income, not
// a whole year's: from 2 January or from 30 December the answer was the same.
export function yearLeft(now) {
  const start = new Date(now.getFullYear(), 0, 1);
  const next = new Date(now.getFullYear() + 1, 0, 1);
  return (next - now) / (next - start);
}

// Other income in a year without work, with income set in rupees worth `fx`
// of its value today (rupeeDrift).
function incomeWithDrift(otherIncomes, rupeeIncomes, offset, fx) {
  const other = incomeInYear(otherIncomes, offset);
  if (rupeeIncomes.length === 0) return other;
  const rupee = incomeInYear(rupeeIncomes, offset);
  return { yearly: other.yearly + rupee.yearly * fx, lump: other.lump + rupee.lump * fx };
}

// The timeline itself.
//
// `retireYear` is the first year without work: saving stops and spending from
// the pot starts. `retireSpend` is the household's yearly spending then; once
// only one person is still planned for, it is `survivorPct` of that. Other
// income (independence_income rows) counts from `retireYear`, as its
// starts_after_years does. `inflows` are sums paid in a fixed
// year (datedIncomesOnTimeline), added to the pot at the start of that year
// whether or not work has stopped. `firstYearShare` is the share of the first
// year still to come (yearLeft); a goal or lump sum in it is paid in full.
// `freed` is what loans paid out of spending stop costing once they clear
// (lifePlanBasis): saving rises by it from then, and so does spending after
// work stops fall, when that spending is today's (`freedFromSpend`). `costs`
// are the costs that start when work stops (costsAfterWork), on top of the
// spending: a row's `spend` is everything spent that year, and `costs` the
// part of it they are. `returnFor(year, retireYear)`, when given, is a real
// return for that year in place of the steady one, or null to keep it: the
// market fall the stress test puts the plan through (marketFall).
//
// `cashPot` is the cash held today, kept as cash in today's money, and
// `cashRate` the real return it earns (Planning audit, 4.19): the rest of the
// pot earns the investment return, a fall included, and once the pot is below
// the cash it is all cash. `drift` is how much a rupee loses against the
// dirham each year, 0 in the plan itself: income, lump sums and costs set in
// rupees (`inr`) are worth that much less each year from this one, and so is
// `rupeeShare` of what the pot holds (rupeeDrift).
export function lifePlan({
  startYear,
  people,
  retireYear,
  startPot,
  annualSaving,
  preRate,
  postRate,
  retireSpend,
  survivorPct = 100,
  goals = [],
  incomes = [],
  inflows = [],
  firstYearShare = 1,
  freed = [],
  freedFromSpend = false,
  costs = [],
  returnFor = null,
  cashPot = 0,
  cashRate = 0,
  drift = 0,
  rupeeShare = 0,
}) {
  const endYear = planEndYear(people);
  // What a rupee set today is worth in `year`, in dirhams, against today.
  const fxIn = (year) => (drift > 0 ? (1 - drift) ** (year - startYear) : 1);
  const rupeeIncomes = incomes.filter((i) => i.inr);
  const otherIncomes = incomes.filter((i) => !i.inr);
  // A loan's instalment, from the month after it clears.
  const freedIn = (year) => freed.reduce((s, f) => s + f.perYear * (year > f.year ? 1 : year === f.year ? f.monthsInYear / 12 : 0), 0);
  const rows = [];
  let pot = startPot;
  let shortYear = null;
  let potAtStop = retireYear <= startYear ? startPot : null;
  for (let year = startYear; year <= endYear; year++) {
    const working = year < retireYear;
    if (year === retireYear) potAtStop = pot;
    const start = pot;
    const share = year === startYear ? firstYearShare : 1;
    const forOne = people.length > 1 && plannedCount(people, year) < people.length;
    const fx = fxIn(year);
    const costsNow = working ? 0 : costInYear(costs, people, year, retireYear, fx) * share;
    const spend = (working ? 0 : Math.max(0, (retireSpend * share - (freedFromSpend ? freedIn(year) : 0)) * (forOne ? survivorPct / 100 : 1))) + costsNow;
    const fromIncome = working ? { yearly: 0, lump: 0 } : incomeWithDrift(otherIncomes, rupeeIncomes, year - retireYear, fx);
    const yearly = fromIncome.yearly * share;
    const { lump } = fromIncome;
    const due = goals.filter((g) => g.year === year);
    const goalOutflow = due.reduce((s, g) => s + g.amount, 0);
    const arriving = inflows.filter((i) => i.year === year);
    const inflow = arriving.reduce((s, i) => s + i.amount * (i.inr ? fx : 1), 0);

    // Income beyond the year's spending, and any lump sum, goes into the pot.
    const balance = pot + lump + inflow + Math.max(0, yearly - spend);
    const needed = Math.max(0, spend - yearly) + goalOutflow;
    const paid = Math.min(needed, Math.max(0, balance));
    let short = needed - paid;
    const after = balance - paid;
    const rate = returnFor?.(year, retireYear) ?? (working ? preRate : postRate);
    // The cash kept earns the cash rate; the rest, the return.
    const cash = Math.min(Math.max(after, 0), cashPot);
    const earned = after > 0 ? cash * ((1 + cashRate) ** share - 1) + (after - cash) * ((1 + rate) ** share - 1) : 0;
    // And with the rupee weakening, what is held in rupees loses that much.
    const fxLoss = drift > 0 && after > 0 ? after * rupeeShare * (1 - (1 - drift) ** share) : 0;
    const growth = earned - fxLoss;
    const saving = working ? annualSaving * share + freedIn(year) : 0;
    let end = after + growth + saving;
    if (end < 0 && !working) {
      short += -end;
      end = 0;
    }
    // A shortfall under a thousandth of a unit is float noise.
    if (short < 1e-3) short = 0;
    if (short > 0 && shortYear === null) shortYear = year;
    // What the pot itself pays towards the year's spending, after other income.
    const drawn = Math.max(0, spend - yearly);
    rows.push({ year, working, forOne, start, saving, spend, costs: costsNow, drawn, income: yearly + lump + inflow, inflows: arriving, goals: due, goalOutflow, paid, short, rate, growth, end });
    pot = end;
  }
  return { rows, endYear, shortYear, lasts: shortYear === null, left: pot, potAtStop };
}

// Smallest x >= 0 for which ok(x) holds, for an ok that turns from false to
// true as x grows. Null when nothing below the cap passes.
function smallestPassing(ok, { cap = 1e12, tolerance = 1 } = {}) {
  if (ok(0)) return 0;
  let hi = 1000;
  while (!ok(hi)) {
    hi *= 2;
    if (hi > cap) return null;
  }
  let lo = 0;
  while (hi - lo > tolerance) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

// Largest x >= 0 for which ok(x) holds, for an ok that turns from true to
// false as x grows. Null when even zero fails.
function largestPassing(ok, { cap = 1e12, tolerance = 1 } = {}) {
  if (!ok(0)) return null;
  let hi = 1000;
  while (ok(hi)) {
    hi *= 2;
    if (hi > cap) return cap;
  }
  let lo = 0;
  while (hi - lo > tolerance) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

const lastsWith = (args, overrides) => lifePlan({ ...args, ...overrides }).lasts;

// The pot needed on the day work stops for the money to last to the end of the
// plan: the adviser's "corpus required at retirement", with goals after that
// day and other income counted, in today's money.
export function potNeededAt(args) {
  const from = Math.max(args.retireYear, args.startYear);
  // Only this year is part-gone: a later stop year starts on 1 January.
  const firstYearShare = from === args.startYear ? (args.firstYearShare ?? 1) : 1;
  return smallestPassing((p) => lastsWith(args, { startYear: from, startPot: p, annualSaving: 0, firstYearShare }));
}

// The first year work could stop with the money lasting to the end, or null
// when no year does -- a goal falling short while still working, say, which
// working longer does not fix.
export function earliestStop(args) {
  const endYear = planEndYear(args.people);
  for (let year = args.startYear; year <= endYear; year++) {
    if (lastsWith(args, { retireYear: year })) return year;
  }
  return null;
}

// Why no stop year lasts, for a screen that has to say so in a few words:
//   { kind: 'goal', goal, year }  a goal the pot cannot pay even while working;
//   { kind: 'spending' }          more is spent than earned, so nothing builds;
//   { kind: 'short' }             saving, but not enough to last to the end;
//   { kind: 'ended' }             everyone is past the age the plan runs to.
export function noStopCause(args) {
  if (planEndYear(args.people) < args.startYear) return { kind: 'ended' };
  const working = lifePlan({ ...args, retireYear: planEndYear(args.people) + 1 });
  const goalRow = working.rows.find((r) => r.short > 0 && r.goals.length > 0);
  if (goalRow) return { kind: 'goal', goal: goalRow.goals[0].name, year: goalRow.year };
  if (args.annualSaving <= 0) return { kind: 'spending' };
  return { kind: 'short' };
}

// The extra saving a year it would take for the chosen year to last. Zero when
// it already does; null when there are no working years left to save in, or
// saving cannot help (a shortfall this year, before any saving arrives).
export function extraSavingNeeded(args) {
  if (args.retireYear <= args.startYear) return lastsWith(args, {}) ? 0 : null;
  return smallestPassing((x) => lastsWith(args, { annualSaving: args.annualSaving + x }));
}

// The most the household could spend a year once work stops and still last.
// Null when even spending nothing falls short, because of the goals.
export function maxRetirementSpend(args) {
  return largestPassing((s) => lastsWith(args, { retireSpend: s }));
}
