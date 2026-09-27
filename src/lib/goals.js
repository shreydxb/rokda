import { formatMoney } from './money';
import { parseDay } from './day';
import { accountValueAed } from './accounts';

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The planning default, the same as Forecast's until the household saves its own.
export const DEFAULT_INFLATION_PCT = 2.5;

// Whole months from this month to the target's, as years; never negative.
export function yearsUntil(targetDate, now = new Date()) {
  const target = parseDay(targetDate);
  const months = (target.getFullYear() - now.getFullYear()) * 12 + (target.getMonth() - now.getMonth());
  return Math.max(0, months) / 12;
}

// The goal's own inflation rate, or the household's general one.
export function goalInflationPct(goal, generalInflationPct = DEFAULT_INFLATION_PCT) {
  return goal.inflation_pct != null ? Number(goal.inflation_pct) : generalInflationPct;
}

// What a goal costs on its date. A target stated as today's cost grows at the
// goal's inflation until then -- Rs 5 Cr today at 8% is about Rs 20 Cr in 18
// years. Otherwise the target already is the amount on the date.
export function goalCostAtDate(goal, now = new Date(), generalInflationPct = DEFAULT_INFLATION_PCT) {
  const target = Number(goal.target_amount) || 0;
  if (!goal.cost_today || !goal.target_date) return target;
  return target * (1 + goalInflationPct(goal, generalInflationPct) / 100) ** yearsUntil(goal.target_date, now);
}

// Everything about a goal's progress — saved, last contribution, projected
// date, status — is derived from its contribution log (plus whatever share
// of real accounts/holdings is linked to it), never stored on the goal row,
// so it can't drift out of sync with what was actually logged or with those
// accounts' live balances.
//
// allocatedValue is the sum of each linked account/holding's current value
// times its share_pct -- real money already sitting somewhere (an FD's
// balance including interest, a holding's live value), not a cash movement.
// It's added straight into `saved` but deliberately left out of the
// monthlyRate/eta projection below, which tracks the *contribution* pace --
// a holding's value moving with the market isn't a "contribution" and
// shouldn't be read as one.
export function goalProgress(goal, contributions, now = new Date(), allocatedValue = 0) {
  const target = Number(goal.target_amount) || 0;
  const saved = contributions.reduce((s, c) => s + Number(c.amount), 0) + allocatedValue;
  const pct = target > 0 ? Math.min(1, saved / target) : 0;

  const lastContribution = contributions.reduce((latest, c) => {
    const d = parseDay(c.occurred_at);
    return !latest || d > latest ? d : latest;
  }, null);

  if (target > 0 && saved >= target) {
    return {
      saved,
      target,
      pct: 1,
      status: 'funded',
      statusLabel: 'Funded',
      eta: 'Reached',
      etaWhy: 'Fully funded.',
      lastContribution,
      monthlyRate: null,
    };
  }

  // Date-only comparison: occurred_at has no time component, so comparing
  // against a cutoff that still carries "now"'s hour/minute would silently
  // drop a contribution dated exactly ~90 days ago depending what time of
  // day this runs.
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 90);
  const recentSum = contributions
    .filter((c) => parseDay(c.occurred_at) >= cutoff)
    .reduce((s, c) => s + Number(c.amount), 0);
  const monthlyRate = recentSum / 3;

  if (monthlyRate <= 0) {
    return {
      saved,
      target,
      pct,
      status: 'behind',
      statusLabel: 'Behind',
      eta: 'No date',
      etaWhy: lastContribution
        ? `No date can be given: nothing has been contributed since ${MONTH_LABELS[lastContribution.getMonth()]}.`
        : 'No date can be given: nothing has been contributed yet.',
      lastContribution,
      monthlyRate: 0,
    };
  }

  const monthsNeeded = Math.ceil((target - saved) / monthlyRate);
  const etaDate = new Date(now.getFullYear(), now.getMonth() + monthsNeeded, 1);
  const etaLabel = `${MONTH_LABELS[etaDate.getMonth()]} ${etaDate.getFullYear()}`;

  let status = 'track';
  let statusLabel = 'On track';
  if (goal.target_date) {
    // parseDay, not new Date(): a bare 'YYYY-MM-DD' parses as UTC midnight,
    // which is the previous day -- and on the 1st, the previous month -- west
    // of Greenwich.
    const targetD = parseDay(goal.target_date);
    const targetMonthIdx = targetD.getFullYear() * 12 + targetD.getMonth();
    const etaMonthIdx = etaDate.getFullYear() * 12 + etaDate.getMonth();
    if (etaMonthIdx < targetMonthIdx - 1) {
      status = 'ahead';
      statusLabel = 'Ahead';
    } else if (etaMonthIdx > targetMonthIdx + 1) {
      status = 'behind';
      statusLabel = 'Behind';
    }
  }

  return {
    saved,
    target,
    pct,
    status,
    statusLabel,
    eta: etaLabel,
    etaWhy: `At the current ${formatMoney(monthlyRate)} a month, projected ${etaLabel}.`,
    lastContribution,
    monthlyRate,
  };
}

export function lastContributionLabel(date) {
  if (!date) return 'never';
  return `${MONTH_LABELS[date.getMonth()]} ${date.getFullYear()}`;
}

// The value of the accounts and holdings earmarked for a goal, at each one's
// share. An account with no AED conversion counts as nothing rather than as
// its native amount read as dirhams (QA #4): an INR 20,000 savings account was
// crediting a goal with AED 20,000. Zero understates; the old fallback
// overstated by the exchange rate and looked authoritative.
export function allocatedValue(goalId, allocations = [], accounts = [], holdings = []) {
  return allocations
    .filter((a) => a.goal_id === goalId)
    .reduce((sum, a) => {
      const value = a.account_id
        ? (accountValueAed(accounts.find((acc) => acc.id === a.account_id)) ?? 0)
        : Number(holdings.find((h) => h.id === a.holding_id)?.value_aed ?? 0);
      return sum + (value * Number(a.share_pct)) / 100;
    }, 0);
}

// Every goal visible in a scope, with its progress. Goals and the Plan
// summary both show these figures, and used to derive them separately: the
// summary left out linked accounts and holdings, so its "saved" total and its
// count of goals behind pace disagreed with the Goals tab for any goal funded
// from an account. One derivation now feeds both.
//
// A shared goal counts half toward each individual scope, same as every other
// joint figure in the app, so "Me" plus the partner reconciles to "Both".
export function scopedGoalRows({ goals = [], contributions = [], allocations = [], accounts = [], holdings = [], scopeMemberId = null, now = new Date(), inflationPct = DEFAULT_INFLATION_PCT }) {
  return goals
    .filter((g) => scopeMemberId === null || g.is_shared || g.owner_member_id === scopeMemberId)
    .map((g) => {
      const factor = scopeMemberId === null || !g.is_shared ? 1 : 0.5;
      // Progress and the monthly figure are measured against what the goal
      // will cost on its date, so a goal stated at today's cost is not shown
      // as funded when it only has today's price saved.
      const scopedGoal = { ...g, target_amount: goalCostAtDate(g, now, inflationPct) * factor };
      const goalContributions = contributions.filter((c) => c.goal_id === g.id).map((c) => ({ ...c, amount: Number(c.amount) * factor }));
      const allocated = allocatedValue(g.id, allocations, accounts, holdings) * factor;
      const progress = goalProgress(scopedGoal, goalContributions, now, allocated);
      return { goal: g, contributions: goalContributions, progress, need: monthlyNeed(scopedGoal, progress, now) };
    });
}

// What a goal needs put in each month, from now, to be funded by its target
// date -- the "solve for the payment" direction. goalProgress answers the
// other one (at the current pace, when?), and the two together say whether
// the pace is enough.
//
// Deliberately no investment growth: a goal carries no return assumption, and
// a monthly figure that quietly counted on one would be a promise the app
// cannot keep. What is already saved (including linked accounts at today's
// value) is taken as it stands.
//
// null when there is nothing to solve: no target date, or already funded.
// Months are counted as whole calendar months from this one to the target's,
// so a target in December seen in September leaves three: October, November
// and December. A target this month or earlier is `due`: the whole remainder
// is needed now.
export function monthlyNeed(goal, progress, now = new Date()) {
  if (!goal.target_date || progress.status === 'funded') return null;
  const target = parseDay(goal.target_date);
  const monthsLeft = (target.getFullYear() - now.getFullYear()) * 12 + (target.getMonth() - now.getMonth());
  const remaining = Math.max(0, progress.target - progress.saved);
  const due = monthsLeft <= 0;
  const perMonth = due ? remaining : remaining / monthsLeft;
  const pace = progress.monthlyRate ?? 0;
  return {
    monthsLeft: Math.max(0, monthsLeft),
    remaining,
    perMonth,
    due,
    byLabel: `${MONTH_LABELS[target.getMonth()]} ${target.getFullYear()}`,
    // Positive: the recent pace falls short of what the date needs by this
    // much a month.
    shortfall: perMonth - pace,
  };
}

// Goals funded in priority order, the way a financial plan does it: each goal
// needs its cost on its date, less what that much would grow to by then at the
// expected return -- the "current value needed". What is already set aside for
// a goal counts first; the household's other money (net worth not already
// earmarked for a goal) then covers goals in order, priority 1 first and
// unnumbered goals after, earliest date first, until it runs out. Whatever is
// left uncovered is the top-up a goal needs today.
//
// Only dated goals: without a date there is nothing to discount to today.
export function fundInPriority({ rows, freeMoney, returnPct, now = new Date() }) {
  const rate = returnPct / 100;
  const ordered = rows
    .filter((r) => r.goal.target_date)
    .slice()
    .sort((a, b) => {
      const pa = a.goal.priority ?? Infinity;
      const pb = b.goal.priority ?? Infinity;
      if (pa !== pb) return pa - pb;
      return String(a.goal.target_date).localeCompare(String(b.goal.target_date));
    });
  let left = Math.max(0, freeMoney);
  const monthlyRate = (1 + rate) ** (1 / 12) - 1;
  const goals = ordered.map((r) => {
    const years = yearsUntil(r.goal.target_date, now);
    const target = parseDay(r.goal.target_date);
    const monthsLeft = Math.max(0, (target.getFullYear() - now.getFullYear()) * 12 + (target.getMonth() - now.getMonth()));
    const costAtDate = r.progress.target;
    const neededToday = costAtDate / (1 + rate) ** years;
    const saved = Math.min(r.progress.saved, neededToday);
    const fromFree = Math.min(left, neededToday - saved);
    left -= fromFree;
    const covered = saved + fromFree;
    const topUp = Math.max(0, neededToday - covered);
    return {
      goal: r.goal,
      years,
      costAtDate,
      neededToday,
      saved,
      fromFree,
      covered,
      pct: neededToday > 0 ? covered / neededToday : 1,
      topUp,
      monthsLeft,
      // The same top-up as a saving each month to the goal's date, invested
      // at the same return: what closes the gap, spread out. A goal due this
      // month or earlier needs the whole top-up now.
      monthly: topUp <= 0 ? 0 : monthsLeft <= 0 ? topUp : monthlyRate > 0 ? (topUp * monthlyRate) / (1 - (1 + monthlyRate) ** -monthsLeft) : topUp / monthsLeft,
    };
  });
  return {
    goals,
    neededToday: goals.reduce((s, g) => s + g.neededToday, 0),
    covered: goals.reduce((s, g) => s + g.covered, 0),
    topUp: goals.reduce((s, g) => s + g.topUp, 0),
    monthly: goals.filter((g) => g.monthsLeft > 0).reduce((s, g) => s + g.monthly, 0),
    freeLeft: left,
  };
}
