import { incomeInYear, incomesFromStop, MARKET_FALL, realReturn, scenarioSets } from './forecast';
import { convertToAed } from './currency';
import { parseDay } from './day';
import { goalInflationPct, isDone } from './goals';
import { andList } from './words';
import { debtsWithAccounts, minimumOnlyPayoff, payoffMonthLabel } from './debt';

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
// general inflation rate. The rupee's own drift against the dirham is not
// modelled. A year already past has been paid, and one with no rate yet is
// left out.
export function datedIncomesOnTimeline(incomes, startYear, inflationPct, household = null) {
  const inflation = inflationPct / 100;
  return incomes
    .filter((r) => r.in_year != null && Number(r.in_year) >= startYear)
    .map((r) => {
      const aed = convertToAed(Number(r.amount) || 0, r.currency ?? 'AED', household);
      if (aed === null) return null;
      const year = Number(r.in_year);
      return { id: r.id, name: r.name, year, amount: aed / (1 + inflation) ** (year - startYear) };
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
      };
    })
    .filter(Boolean);
}

// What those costs come to in `year`, in today's money, for a plan whose work
// stops in `retireYear`. Timing counts from that year, as other income's does.
// Each rises at its own rate above inflation from `since`, so health cover
// priced at today's ages costs more by the time work stops and goes on rising;
// one for each person counts once for each person still planned for, so cover
// for two halves when one remains.
export function costInYear(costs = [], people = [], year, retireYear) {
  const offset = year - retireYear;
  const planned = plannedCount(people, year);
  return costs.reduce((s, c) => {
    if (offset < c.startsAfterYears || (c.lastsYears != null && offset >= c.startsAfterYears + c.lastsYears)) return s;
    return s + c.amount * (1 + c.risePct / 100) ** Math.max(0, year - c.since) * (c.perPerson ? planned : 1);
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
}) {
  const endYear = planEndYear(people);
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
    const costsNow = working ? 0 : costInYear(costs, people, year, retireYear) * share;
    const spend = (working ? 0 : Math.max(0, (retireSpend * share - (freedFromSpend ? freedIn(year) : 0)) * (forOne ? survivorPct / 100 : 1))) + costsNow;
    const fromIncome = working ? { yearly: 0, lump: 0 } : incomeInYear(incomes, year - retireYear);
    const yearly = fromIncome.yearly * share;
    const { lump } = fromIncome;
    const due = goals.filter((g) => g.year === year);
    const goalOutflow = due.reduce((s, g) => s + g.amount, 0);
    const arriving = inflows.filter((i) => i.year === year);
    const inflow = arriving.reduce((s, i) => s + i.amount, 0);

    // Income beyond the year's spending, and any lump sum, goes into the pot.
    const balance = pot + lump + inflow + Math.max(0, yearly - spend);
    const needed = Math.max(0, spend - yearly) + goalOutflow;
    const paid = Math.min(needed, Math.max(0, balance));
    let short = needed - paid;
    const after = balance - paid;
    const rate = returnFor?.(year, retireYear) ?? (working ? preRate : postRate);
    const growth = after > 0 ? after * ((1 + rate) ** share - 1) : 0;
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

// Members the plan leaves out, for want of a birth year and an age to plan
// to. A partner left out dropped out quietly, and if they were the younger,
// the money could seem to last when it runs out years before their plan ends
// (Planning audit, 1.1).
export function membersLeftOut(members = [], memberLife = []) {
  const planned = new Set(memberLife.map((r) => r.member_id));
  return members.filter((m) => !planned.has(m.id));
}

// "Partner B isn't in the plan: ...", for the screens that give the answer.
export function leftOutText(leftOut) {
  const names = leftOut.map((m) => m.display_name);
  return `${andList(names)} ${names.length === 1 ? "isn't" : "aren't"} in the plan: no birth year and age to plan to yet.`;
}

// Whose 60th birthday the stop year is until one is saved: the eldest person
// planned for, the first by name if two were born the same year. It was the
// first in the roster, an order the database doesn't fix, so it could change
// when a partner linked Telegram (Planning audit, 1.1).
export function defaultStopPerson(people) {
  return [...people].sort((a, b) => a.birthYear - b.birthYear || a.name.localeCompare(b.name))[0];
}

// The loans whose instalments are inside the spending the plan is worked out
// on, so that they are counted there and not a second time as a balance owed
// (Planning audit, 2.10): each with what it owes, its instalment and the
// months until it clears at that. A card is left alone, since its purchases
// are the spending, and so is a loan paid by transfers into its own account in
// the last twelve months: the records count those as saving, not spending. A
// loan its instalment never clears has no date for saving to rise from.
export function loansInSpending({ debts = [], accounts = [], transactions = [], now = new Date() }) {
  const since = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  const paidByTransfer = new Set(transactions.filter((t) => t.kind === 'transfer' && t.account_id && parseDay(t.occurred_at) >= since).map((t) => t.account_id));
  const loans = debtsWithAccounts(debts, accounts).filter(
    (d) => d.account?.type !== 'credit_card' && Number(d.minimum_payment) > 0 && !(d.account_id && paidByTransfer.has(d.account_id))
  );
  return minimumOnlyPayoff(loans)
    .byDebt.filter((r) => Number.isFinite(r.months) && r.months > 0)
    .map(({ debt, months }) => ({ id: debt.id, name: debt.name, balance: debt.balance, monthly: Number(debt.minimum_payment), months, inNetWorth: debt.inNetWorth }));
}

// What the plan takes the loans paid out of spending to do, said under the
// Life plan's timeline (Planning audit, 2.10). `loans` is lifePlanBasis'
// (each with the month it clears); `fmt` formats an amount, currency code
// included. Null with none.
export function loansText(loans, owedOnLoans, fmt) {
  if (!loans?.length) return null;
  const one = loans.length === 1;
  const owes = owedOnLoans > 0 ? ` The plan starts from what you own before the ${fmt(owedOnLoans)} ${one ? 'it owes' : 'they owe'}, which ${one ? 'its instalment repays' : 'their instalments repay'}.` : '';
  if (one) return `${loans[0].name}'s ${fmt(loans[0].monthly)} a month is in today's spending until it clears about ${loans[0].clears}, and saving rises by it after that.${owes}`;
  const last = loans.reduce((a, l) => (l.months > a.months ? l : a));
  return `The instalments on ${andList(loans.map((l) => l.name))} are in today's spending until each clears, the last about ${last.clears}, and saving rises by each after that.${owes}`;
}

// The return once work stops, before inflation. A pot being spent is usually
// held more cautiously than one being built, so unless the household sets its
// own, it is the working return less AFTER_WORK_RETURN_GAP: assuming the same
// return either side of the stop year flattered every plan (Planning audit,
// 3.13). Either way it moves with the scenario, by as much as the working
// return does, so Conservative lowers both returns together.
export const AFTER_WORK_RETURN_GAP = 1;
export function afterWorkReturn(assumptions, sets, selected) {
  const shift = selected.nominalPct - sets.baseline.nominalPct;
  const own = assumptions?.retirement_return_pct != null ? Number(assumptions.retirement_return_pct) : null;
  return (own ?? sets.baseline.nominalPct - AFTER_WORK_RETURN_GAP) + shift;
}

// Everything the life plan runs on, built from the household's saved data one
// way for every screen that shows it -- the Life plan tab, the Plan summary and
// Goals -- so they cannot disagree about when work can stop. `fcSet`,
// `stopOverride` and `spendKind` are the Life plan tab's what-ifs; the other
// screens leave them unset and so read the saved plan.
//
// `stopping` is spendThatStops: when some of today's spending will have
// stopped by then, spending after work stops leaves it out unless a figure has
// been saved for the plan.
//
// `loans` is loansInSpending. Each one's instalment is in today's spending
// until it clears, so the plan starts from what the household owns before
// what is owed on them, and saving rises by the instalment once it clears,
// in today's money then. Net worth used to take the balance off the start
// while the whole instalment stayed in spending until work stopped: the
// principal counted twice, and saving never rose (Planning audit, 2.10).
//
// `costs` are after_work_costs rows (costsAfterWork), counted on top of the
// spending once work stops.
export function lifePlanBasis({ people, assumptions, inputs, startNetWorth, goals = [], incomes = [], costs = [], household = null, stopping = null, loans = [], startYear, now = null, fcSet = 'baseline', stopOverride = null, spendKind = null }) {
  const endYear = planEndYear(people);
  const sets = scenarioSets(assumptions);
  const selected = sets[fcSet] ?? sets.baseline;
  const inflationPct = selected.inflationPct;
  const preRate = realReturn(selected.nominalPct, inflationPct);
  const postNominal = afterWorkReturn(assumptions, sets, selected);
  const postRate = realReturn(postNominal, inflationPct);

  const clampYear = (y) => Math.min(endYear, Math.max(startYear, y));
  const savedStop = assumptions?.retirement_year != null ? clampYear(Number(assumptions.retirement_year)) : null;
  const stopBy = defaultStopPerson(people);
  const defaultStop = clampYear(stopBy.birthYear + DEFAULT_STOP_AGE);
  const stopYear = stopOverride ?? savedStop ?? defaultStop;

  const plannedSpend = assumptions?.retirement_annual_spend != null ? Number(assumptions.retirement_annual_spend) : null;
  const leanSpend = assumptions?.lean_annual_spend != null ? Number(assumptions.lean_annual_spend) : null;
  const spendOptions = [
    ...(plannedSpend != null ? [{ key: 'planned', label: 'Planned', value: plannedSpend }] : []),
    ...(stopping?.annual > 0 ? [{ key: 'less', label: 'Less what stops', value: Math.max(0, inputs.annualSpend - stopping.annual) }] : []),
    { key: 'today', label: inputs.source === 'budget' ? 'Budgeted' : "Today's", value: inputs.annualSpend },
    ...(leanSpend ? [{ key: 'lean', label: 'Essentials', value: leanSpend }] : []),
  ];
  const spendChoice = spendOptions.find((o) => o.key === spendKind) ?? spendOptions[0];
  const survivorPct = assumptions?.survivor_spend_pct != null ? Number(assumptions.survivor_spend_pct) : 100;
  const timelineGoals = goalsOnTimeline(goals, startYear, inflationPct);
  const fromStop = incomesFromStop(incomes, household);
  const inflows = datedIncomesOnTimeline(incomes, startYear, inflationPct, household);
  const from = now ?? new Date(startYear, 0, 1);
  const freed = loans.map((loan) => {
    // The month after its last instalment.
    const free = new Date(from.getFullYear(), from.getMonth() + loan.months + 1, 1);
    const year = free.getFullYear();
    return {
      ...loan,
      clears: payoffMonthLabel(loan.months, from),
      year,
      monthsInYear: 12 - free.getMonth(),
      perYear: (loan.monthly * 12) / (1 + inflationPct / 100) ** Math.max(0, year - startYear),
    };
  });
  const owedOnLoans = loans.filter((l) => l.inNetWorth).reduce((s, l) => s + l.balance, 0);
  const afterWork = costsAfterWork(costs, household, startYear);

  return {
    endYear,
    sets,
    selected,
    inflationPct,
    postNominal,
    savedStop,
    stopYear,
    // A stop year nobody chose is an assumption, and says whose 60th it is.
    stopAssumed: stopOverride === null && savedStop === null ? stopBy : null,
    spendOptions,
    spendChoice,
    survivorPct,
    stopping,
    goals: timelineGoals,
    incomes: fromStop,
    inflows,
    loans: freed,
    owedOnLoans,
    costs: afterWork,
    // What the costs come to in the year work stops, in today's money.
    costsAtStop: costInYear(afterWork, people, stopYear, stopYear),
    args: {
      startYear,
      people,
      retireYear: stopYear,
      startPot: startNetWorth + owedOnLoans,
      annualSaving: inputs.monthlySaving * 12,
      preRate,
      postRate,
      retireSpend: spendChoice.value,
      survivorPct,
      goals: timelineGoals,
      incomes: fromStop,
      inflows,
      firstYearShare: now ? yearLeft(now) : 1,
      freed,
      // Only today's spending still holds the instalments once work stops.
      freedFromSpend: spendChoice.key === 'today',
      costs: afterWork,
    },
  };
}

// The year work stops under Baseline and Conservative side by side, the range
// every headline gives rather than one zero-margin year at one return
// (Planning audit, 3.12): whether the money lasts to the end and what is left
// then, or the year it runs short, and the earliest year that lasts with
// nothing to spare. `basisFor(fcSet)` is lifePlanBasis for that scenario with
// everything else held as it is, the stop year included.
export const RANGE_SETS = ['baseline', 'conservative'];
export function stopRange(basisFor) {
  return RANGE_SETS.map((key) => {
    const basis = basisFor(key);
    const result = lifePlan(basis.args);
    const shortRow = result.shortYear !== null ? result.rows.find((r) => r.year === result.shortYear) : null;
    return {
      key,
      label: basis.selected.label,
      stopYear: basis.stopYear,
      endYear: basis.endYear,
      lasts: result.lasts,
      shortYear: result.shortYear,
      // Short while still working: a goal the pot cannot pay.
      shortWorking: shortRow?.working ?? false,
      left: result.left,
      earliest: earliestStop(basis.args),
    };
  });
}

// The stress test (Planning audit, 3.14): the same market fall after work
// stops, early or late, put through the Life plan itself rather than a
// simpler drawdown of its own, so it counts what the plan counts -- spending
// for one, goals after work stops, other income, the costs that start then.
// The fall is MARKET_FALL, about what a mixed pot lost after inflation in a
// bad stretch such as 2008: sized for the more cautious mix the plan assumes
// once work stops (AFTER_WORK_RETURN_GAP), not today's all-equity one, which
// fell about twice as far in 1973-74.
//
// marketFall(after) is a return override for lifePlan: the fall starts in
// year `after` of not working (1 is the year work stops), and moves with the
// stop year, so earliestStop finds the first year that weathers it.
export function marketFall(after) {
  return (year, retireYear) => {
    const k = year - retireYear + 1 - after;
    return k >= 0 && k < MARKET_FALL.length ? MARKET_FALL[k] : null;
  };
}

export const STRESS_FALLS = [
  { key: 'steady', label: 'Steady', after: null },
  { key: 'early', label: 'Fall the year work stops', after: 1 },
  { key: 'late', label: 'Fall ten years in', after: 10 },
];

// The plan at its stop year with a steady return, and with the fall early and
// late. `basis` is lifePlanBasis on Baseline: a fall stacked on Conservative
// would count caution twice. Each outcome says whether the money lasts and
// what is left, or the year it runs out, its years from the stop year on, and
// the earliest year work could stop and weather it. A fall that would come
// after the plan ends is left out. `firstDraw` is what the pot pays towards
// spending in the year work stops, after other income, and that as a share of
// what it holds then.
export function stressTest(basis) {
  const { stopYear, endYear } = basis;
  const outcomes = STRESS_FALLS.filter((f) => f.after === null || stopYear + f.after - 1 <= endYear).map((f) => {
    const returnFor = f.after === null ? null : marketFall(f.after);
    const result = lifePlan({ ...basis.args, returnFor });
    return {
      key: f.key,
      label: f.label,
      fallYear: f.after === null ? null : stopYear + f.after - 1,
      lasts: result.lasts,
      shortYear: result.shortYear,
      left: result.left,
      rows: result.rows.filter((r) => r.year >= stopYear),
      earliest: earliestStop({ ...basis.args, returnFor }),
    };
  });
  const first = outcomes[0].rows[0];
  return {
    stopYear,
    endYear,
    outcomes,
    firstDraw: first ? { year: first.year, drawn: first.drawn, pot: first.start, share: first.start > 0 ? first.drawn / first.start : null } : null,
  };
}

// "Baseline lasts to 2080 with AED 2.1M left · Conservative runs out in 2071":
// the range in words, for the screens that quote it. `fmt` formats an amount
// in today's money, currency code included.
export function rangeText(range, fmt) {
  return range
    .map((r) =>
      r.lasts
        ? `${r.label} lasts to ${r.endYear} with ${fmt(r.left)} left`
        : `${r.label} ${r.shortWorking ? 'falls short for a goal' : 'runs out'} in ${r.shortYear}`
    )
    .join(' · ');
}

// The household's one answer to "when could we stop working": the first year
// the saved life plan lasts to the end. The Plan summary shows it rather than
// a rule of its own, so it agrees with the Life plan tab. Null
// until someone's age is set, or while there is nothing to project from.
export function lifePlanStop({ members, memberLife, inputs, ...rest }) {
  const people = planPeople(members, memberLife);
  if (people.length === 0 || !inputs?.ready) return null;
  const basis = lifePlanBasis({ people, inputs, ...rest });
  const earliest = earliestStop(basis.args);
  const saved = lifePlan(basis.args);
  return {
    people,
    // Baseline and Conservative at the plan's own stop year (stopRange).
    range: stopRange((fcSet) => lifePlanBasis({ people, inputs, ...rest, fcSet })),
    stopAges: agesIn(people, basis.stopYear),
    endYear: basis.endYear,
    earliest,
    whyNone: earliest === null ? noStopCause(basis.args) : null,
    ages: earliest !== null ? agesIn(people, earliest) : null,
    // Whether the plan's own stop year lasts, and the year it runs short if not.
    lasts: saved.lasts,
    shortYear: saved.shortYear,
    // Its year-by-year timeline, which Goals reads each later goal's state from.
    rows: saved.rows,
    // The loans counted in spending until they clear, and what they owe.
    loans: basis.loans,
    owedOnLoans: basis.owedOnLoans,
    // The costs that start when work stops, and what they come to then.
    costs: basis.costs,
    costsAtStop: basis.costsAtStop,
    stopYear: basis.stopYear,
    stopAssumed: basis.stopAssumed,
    leftOut: membersLeftOut(members, memberLife),
    // Spending once work stops, in today's money, and which choice it is, so a
    // screen that gives the answer can say what the answer assumes.
    spend: basis.spendChoice.value,
    spendKey: basis.spendChoice.key,
    spendLabel: basis.spendChoice.label,
  };
}

// "spending AED 90,000 a year after work stops (today's, less what stops)":
// the spending a stop year rests on, for the screens that lead with one, and
// the costs that start then on top of it. `fmt` formats an amount in today's
// money, currency code included.
export function spendAfterText(stop, fmt) {
  const costs = stop.costsAtStop > 0 ? `, plus ${fmt(stop.costsAtStop)} a year of costs that start then` : '';
  return `spending ${fmt(stop.spend)} a year after work stops (${spendHow(stop)})${costs}`;
}

// What the plan takes the costs that start when work stops to be, said under
// the Life plan's timeline: "Health cover AED 12,000 a year for each person,
// rising 3% a year above inflation from now; Visa fees AED 2,000 a year."
// `costs` is lifePlanBasis'; `fmt` formats an amount, currency code included.
// Null with none.
export function costsText(costs, fmt) {
  if (!costs?.length) return null;
  const one = (c) => {
    const parts = [`${c.name} ${fmt(c.amount)} a year${c.perPerson ? ' for each person' : ''}`];
    if (c.risePct > 0) parts.push(`rising ${c.risePct}% a year above inflation from now`);
    if (c.startsAfterYears > 0) parts.push(`from ${c.startsAfterYears} year${c.startsAfterYears === 1 ? '' : 's'} after work stops`);
    if (c.lastsYears != null) parts.push(`for ${c.lastsYears} year${c.lastsYears === 1 ? '' : 's'}`);
    return parts.join(', ');
  };
  return `Costs that start when work stops, on top of the spending: ${costs.map(one).join('; ')}.`;
}

// How that spending was chosen, in a few words. Only a figure saved for the
// plan is "your plan"; one the app works out says how (Planning audit, 1.3).
export function spendHow(stop) {
  return (
    {
      planned: 'your plan',
      less: "today's, less what stops",
      lean: 'essentials only',
    }[stop.spendKey] ?? (stop.spendLabel === 'Budgeted' ? 'as budgeted' : 'as today')
  );
}

// Why no year lasts, in a few words, for the screens that lead with the
// answer. They used to blame a goal whatever the cause.
export function noStopText(stop) {
  const why = stop.whyNone;
  if (why?.kind === 'goal') return `${why.goal} in ${why.year} falls short, even while still working`;
  if (why?.kind === 'spending') return 'More is spent than earned, so no stop year lasts';
  if (why?.kind === 'ended') return 'Everyone is past the age the plan runs to: plan to a later age';
  return `No stop year lasts to ${stop.endYear} on today's saving`;
}

// "Partner A 60 · Partner B 60": the ages of everyone still planned for.
export function agesLabel(ages) {
  return ages
    .filter((a) => a.planned)
    .map((a) => `${a.name} ${a.age}`)
    .join(' · ');
}
