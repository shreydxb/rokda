import { incomeInYear, realReturn, scenarioSets } from './forecast';
import { parseDay } from './day';
import { goalInflationPct } from './goals';

// The life plan: one year-by-year timeline from this year to the end of the
// longest life expectancy, the calculation a financial adviser's "cash
// adequacy" sheet does. While working, the pot grows and the year's saving is
// added; each goal is paid out of the pot in its year; once work stops,
// spending comes out of the pot after any other income. The question it
// answers is the one the sheet exists for: does the money last, and if not,
// in which year does it run out.
//
// Everything is in today's money, like Forecast and Drawdown: the pot grows at
// the real return, saving and spending keep their buying power. It is one
// formula applied to every year, so no year can be computed differently from
// its neighbours -- the adviser's sheets had exactly that fault.
//
// The conventions match the other two screens, so the three agree where they
// overlap. As in Forecast, a working year's saving is added at the end of the
// year and the pot grows on what it held. As in Drawdown, a retired year's
// spending is taken at the start of the year, other income first, and only the
// rest from the pot; a goal is paid at the start of its year either way. The
// pot never goes below zero: what it cannot pay is a shortfall, and the first
// year with one is the year the plan runs out.

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
// past is paid this year. Goals with no date, or marked as money kept rather
// than spent (an emergency fund), stay off the timeline.
export function goalsOnTimeline(goals, startYear, inflationPct) {
  const inflation = inflationPct / 100;
  return goals
    .filter((g) => g.target_date && g.counts_in_life_plan !== false && Number(g.target_amount) > 0)
    .map((g) => {
      const year = Math.max(startYear, parseDay(g.target_date).getFullYear());
      const n = year - startYear;
      const target = Number(g.target_amount);
      const amount = g.cost_today ? target * ((1 + goalInflationPct(g, inflationPct) / 100) / (1 + inflation)) ** n : target / (1 + inflation) ** n;
      return { id: g.id, name: g.name, year, amount };
    })
    .sort((a, b) => a.year - b.year);
}

// The timeline itself.
//
// `retireYear` is the first year without work: saving stops and spending from
// the pot starts. `retireSpend` is the household's yearly spending then; once
// only one person is still planned for, it is `survivorPct` of that. Other
// income (independence_income rows) counts from `retireYear`, the same way
// Drawdown counts it from independence.
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
}) {
  const endYear = planEndYear(people);
  const rows = [];
  let pot = startPot;
  let shortYear = null;
  let potAtStop = retireYear <= startYear ? startPot : null;
  for (let year = startYear; year <= endYear; year++) {
    const working = year < retireYear;
    if (year === retireYear) potAtStop = pot;
    const start = pot;
    const forOne = people.length > 1 && plannedCount(people, year) < people.length;
    const spend = working ? 0 : retireSpend * (forOne ? survivorPct / 100 : 1);
    const { yearly, lump } = working ? { yearly: 0, lump: 0 } : incomeInYear(incomes, year - retireYear);
    const due = goals.filter((g) => g.year === year);
    const goalOutflow = due.reduce((s, g) => s + g.amount, 0);

    // Income beyond the year's spending, and any lump sum, goes into the pot.
    const balance = pot + lump + Math.max(0, yearly - spend);
    const needed = Math.max(0, spend - yearly) + goalOutflow;
    const paid = Math.min(needed, Math.max(0, balance));
    let short = needed - paid;
    const after = balance - paid;
    const growth = after > 0 ? after * (working ? preRate : postRate) : 0;
    const saving = working ? annualSaving : 0;
    let end = after + growth + saving;
    // Spending more than is earned while working draws on the pot too.
    if (end < 0) {
      short += -end;
      end = 0;
    }
    // A shortfall under a thousandth of a unit is float noise.
    if (short < 1e-3) short = 0;
    if (short > 0 && shortYear === null) shortYear = year;
    rows.push({ year, working, forOne, start, saving, spend, income: yearly + lump, goals: due, goalOutflow, paid, short, growth, end });
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
  return smallestPassing((p) => lastsWith(args, { startYear: from, startPot: p, annualSaving: 0 }));
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

// The planning defaults every screen falls back to, the same as Forecast's.
export const LIFE_PLAN_DEFAULTS = { nominal_return_pct: 6.0, inflation_pct: 2.5, safe_withdrawal_pct: 4.0 };
// When no stop-work year is saved: the first person's 60th year.
export const DEFAULT_STOP_AGE = 60;

// The people planned for: household members with a birth year and an age to
// plan to (member_life), in roster order.
export function planPeople(members = [], memberLife = []) {
  const byMember = new Map(memberLife.map((r) => [r.member_id, r]));
  return members
    .filter((m) => byMember.has(m.id))
    .map((m) => ({ id: m.id, name: m.display_name, birthYear: byMember.get(m.id).birth_year, lifeExpectancy: byMember.get(m.id).life_expectancy }));
}

// Everything the life plan runs on, built from the household's saved data one
// way for every screen that shows it -- the Life plan tab, the Plan summary and
// Forecast -- so they cannot disagree about when work can stop. `fcSet`,
// `stopOverride` and `spendKind` are the Life plan tab's what-ifs; the other
// screens leave them unset and so read the saved plan.
export function lifePlanBasis({ people, assumptions, inputs, startNetWorth, goals = [], incomes = [], startYear, fcSet = 'baseline', stopOverride = null, spendKind = null }) {
  const endYear = planEndYear(people);
  const sets = scenarioSets(assumptions, LIFE_PLAN_DEFAULTS);
  const selected = sets[fcSet] ?? sets.baseline;
  const inflationPct = selected.inflationPct;
  const preRate = realReturn(selected.nominalPct, inflationPct);
  // A return set for after work stops moves with the scenario, like the one before.
  const postNominal =
    assumptions?.retirement_return_pct != null ? Number(assumptions.retirement_return_pct) + (selected.nominalPct - sets.baseline.nominalPct) : selected.nominalPct;
  const postRate = realReturn(postNominal, inflationPct);

  const clampYear = (y) => Math.min(endYear, Math.max(startYear, y));
  const savedStop = assumptions?.retirement_year != null ? clampYear(Number(assumptions.retirement_year)) : null;
  const defaultStop = clampYear(people[0].birthYear + DEFAULT_STOP_AGE);
  const stopYear = stopOverride ?? savedStop ?? defaultStop;

  const plannedSpend = assumptions?.retirement_annual_spend != null ? Number(assumptions.retirement_annual_spend) : null;
  const leanSpend = assumptions?.lean_annual_spend != null ? Number(assumptions.lean_annual_spend) : null;
  const spendOptions = [
    ...(plannedSpend != null ? [{ key: 'planned', label: 'Planned', value: plannedSpend }] : []),
    { key: 'today', label: inputs.source === 'budget' ? 'Budgeted' : "Today's", value: inputs.annualSpend },
    ...(leanSpend ? [{ key: 'lean', label: 'Essentials', value: leanSpend }] : []),
  ];
  const spendChoice = spendOptions.find((o) => o.key === spendKind) ?? spendOptions[0];
  const survivorPct = assumptions?.survivor_spend_pct != null ? Number(assumptions.survivor_spend_pct) : 100;
  const timelineGoals = goalsOnTimeline(goals, startYear, inflationPct);

  return {
    endYear,
    sets,
    selected,
    inflationPct,
    postNominal,
    savedStop,
    stopYear,
    spendOptions,
    spendChoice,
    survivorPct,
    goals: timelineGoals,
    incomes,
    args: {
      startYear,
      people,
      retireYear: stopYear,
      startPot: startNetWorth,
      annualSaving: inputs.monthlySaving * 12,
      preRate,
      postRate,
      retireSpend: spendChoice.value,
      survivorPct,
      goals: timelineGoals,
      incomes,
    },
  };
}

// The household's one answer to "when could we stop working": the first year
// the saved life plan lasts to the end. The Plan summary and Forecast show it
// rather than a rule of their own, so they agree with the Life plan tab. Null
// until someone's age is set, or while there is nothing to project from.
export function lifePlanStop({ members, memberLife, inputs, ...rest }) {
  const people = planPeople(members, memberLife);
  if (people.length === 0 || !inputs?.ready) return null;
  const basis = lifePlanBasis({ people, inputs, ...rest });
  const earliest = earliestStop(basis.args);
  return {
    people,
    endYear: basis.endYear,
    earliest,
    ages: earliest !== null ? agesIn(people, earliest) : null,
    lasts: lifePlan(basis.args).lasts,
    stopYear: basis.stopYear,
  };
}

// "Shreyash 60 · Tarika 60": the ages of everyone still planned for.
export function agesLabel(ages) {
  return ages
    .filter((a) => a.planned)
    .map((a) => `${a.name} ${a.age}`)
    .join(' · ');
}
