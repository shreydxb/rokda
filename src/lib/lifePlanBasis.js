import { incomesFromStop, MARKET_FALL, realReturn, scenarioSets } from './forecast';
import { parseDay } from './day';
import { andList } from './words';
import { debtsWithAccounts, minimumOnlyPayoff, payoffMonthLabel } from './debt';
import { agesIn, costInYear, costsAfterWork, datedIncomesOnTimeline, earliestStop, goalsOnTimeline, lifePlan, noStopCause, planEndYear, yearLeft } from './lifePlan';

// The life plan's basis: who it is for, the loans in its spending, the
// returns it uses, the stop it gives, and how sure that is (the range, the
// stress test, the rupee). lifePlan.js is the year-by-year projection these
// run; split from it with the round 2 cleanup (SHR-383).

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

// What cash held today earns a year, before inflation, until the household
// sets its own: about what a UAE savings account or short deposit pays
// (Planning audit, 4.19). Cash used to earn the investment return.
export const CASH_RETURN_DEFAULT = 3;
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
//
// `start` is planStart: the cash held today, which stays cash at the cash
// rate (Planning audit, 4.19), and what is held in rupees, for the rupee
// drift case.
export function lifePlanBasis({ people, assumptions, inputs, startNetWorth, start = { cash: 0, rupees: 0 }, goals = [], incomes = [], costs = [], household = null, stopping = null, loans = [], startYear, now = null, fcSet = 'baseline', stopOverride = null, spendKind = null }) {
  const endYear = planEndYear(people);
  const sets = scenarioSets(assumptions);
  const selected = sets[fcSet] ?? sets.baseline;
  const inflationPct = selected.inflationPct;
  const preRate = realReturn(selected.nominalPct, inflationPct);
  const postNominal = afterWorkReturn(assumptions, sets, selected);
  const postRate = realReturn(postNominal, inflationPct);
  // The same in every scenario: a scenario is about markets, and cash does
  // not move with them.
  const cashNominal = assumptions?.cash_return_pct != null ? Number(assumptions.cash_return_pct) : CASH_RETURN_DEFAULT;

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
  const fromStop = incomesFromStop(incomes, household).map((r) => ({ ...r, inr: r.currency === 'INR' }));
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
  const startPot = startNetWorth + owedOnLoans;

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
    cashNominal,
    cashPot: Math.max(0, start.cash),
    // What is set in rupees, for the rupee drift case: what the pot holds in
    // them and its share, and the income and costs.
    rupees: {
      held: Math.max(0, start.rupees),
      share: startPot > 0 ? Math.min(1, Math.max(0, start.rupees) / startPot) : 0,
      incomes: [...fromStop, ...inflows].filter((r) => r.inr).length,
      costs: afterWork.filter((c) => c.inr).length,
    },
    args: {
      startYear,
      people,
      retireYear: stopYear,
      startPot,
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
      cashPot: Math.max(0, start.cash),
      cashRate: realReturn(cashNominal, inflationPct),
      rupeeShare: startPot > 0 ? Math.min(1, Math.max(0, start.rupees) / startPot) : 0,
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

// The rupee drift case (Planning audit, 4.19): the plan on Baseline with the
// rupee losing RUPEE_DRIFT of its value against the dirham every year from
// this one, beyond what prices do, against the plan as it is. It is a stress,
// like the market fall, not a forecast: about the rupee's pace against the
// dollar, and so the dirham, over the past twenty years, with nothing in
// rupees making up for it. Everything set in rupees moves: other income and
// sums paid in a set year (a policy maturing) are worth less, costs in rupees
// cost less, and the share of the pot held in rupees loses value. Null when
// nothing is in rupees. `basis` is lifePlanBasis on Baseline.
export const RUPEE_DRIFT = 0.03;
export function rupeeDrift(basis) {
  const { rupees, stopYear, endYear } = basis;
  if (!(rupees.held > 0) && rupees.incomes === 0 && rupees.costs === 0) return null;
  const outcome = (drift) => {
    const args = { ...basis.args, drift };
    const result = lifePlan(args);
    return { lasts: result.lasts, shortYear: result.shortYear, left: result.left, earliest: earliestStop(args) };
  };
  return { drift: RUPEE_DRIFT, stopYear, endYear, rupees, steady: outcome(0), weaker: outcome(RUPEE_DRIFT) };
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

// "Partner A 60 · Partner B 60": the ages of everyone still planned for.
export function agesLabel(ages) {
  return ages
    .filter((a) => a.planned)
    .map((a) => `${a.name} ${a.age}`)
    .join(' · ');
}
