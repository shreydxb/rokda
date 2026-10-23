import { formatMoney } from './money';
import { parseDay } from './day';
import { accountValueAed, isArchived, isLiabilityAccount } from './accounts';
import { PLANNING_DEFAULTS } from './planningDefaults';

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The planning default, until the household saves its own.
export const DEFAULT_INFLATION_PCT = PLANNING_DEFAULTS.inflation_pct;

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

// Only an open account the household holds money in can back a goal. A loan
// or card's balance is what is owed, so a linked one counted debt as saved,
// and a closed account holds nothing. The goal editor offers only these, and
// a link made before that rule counts as nothing.
export function accountCanBackGoal(account) {
  return !!account && !isArchived(account) && !isLiabilityAccount(account);
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
      const account = a.account_id ? accounts.find((acc) => acc.id === a.account_id) : null;
      const value = a.account_id
        ? accountCanBackGoal(account)
          ? (accountValueAed(account) ?? 0)
          : 0
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

// Goals due within three years are paid from cash: what is logged to them
// and the current, savings and cash accounts linked to them, never holdings,
// with no growth. A trip months away read as covered by equities. Later
// goals are the Life plan's to pay, from everything, in their year, so their
// state is the Life plan's and the two tabs can't disagree (Planning audit,
// 1.5). Kept money, an emergency fund, is held in cash whatever its date.
export const NEAR_TERM_MONTHS = 36;
// The accounts Overview's cash cover counts (overviewMath.js).
const CASH_TYPES = new Set(['checking', 'savings', 'cash']);

// Whole calendar months from this one to the target's; negative once past.
export function monthsUntil(targetDate, now = new Date()) {
  const target = parseDay(targetDate);
  return (target.getFullYear() - now.getFullYear()) * 12 + (target.getMonth() - now.getMonth());
}

// What is set aside for a goal in cash: contributions logged to it, and the
// current, savings and cash accounts linked to it at their share.
export function cashSetAside(goalId, contributions = [], allocations = [], accounts = []) {
  const logged = contributions.filter((c) => c.goal_id === goalId).reduce((s, c) => s + Number(c.amount), 0);
  const linked = allocations
    .filter((a) => a.goal_id === goalId && a.account_id)
    .reduce((sum, a) => {
      const account = accounts.find((acc) => acc.id === a.account_id);
      if (!accountCanBackGoal(account) || !CASH_TYPES.has(account.type)) return sum;
      return sum + ((accountValueAed(account) ?? 0) * Number(a.share_pct)) / 100;
    }, 0);
  return logged + linked;
}

// Each goal in a scope with one status, from the one rule for its kind:
//   near:    dated within three years; covered, saving (so much a month in
//            cash to its date), or due with cash still missing;
//   kept:    money kept rather than spent; covered or saving, in cash;
//   later:   dated three years or more ahead; covered or short in its year
//            on the Life plan's timeline, or unchecked without one;
//   undated: no date, so nothing plans for it.
// `timeline` is the Life plan's rows (lifePlanStop), or null. Amounts follow
// the scope, as scopedGoalRows' do; the timeline is the household's.
export function goalStatuses({ timeline = null, ...args }) {
  const { contributions = [], allocations = [], accounts = [], scopeMemberId = null, now = new Date() } = args;
  return scopedGoalRows(args).map((row) => {
    const { goal, progress } = row;
    const factor = scopeMemberId === null || !goal.is_shared ? 1 : 0.5;
    const cost = progress.target;
    const dated = !!goal.target_date;
    const months = dated ? monthsUntil(goal.target_date, now) : null;
    const kept = goal.counts_in_life_plan === false;
    const kind = kept ? 'kept' : !dated ? 'undated' : months < NEAR_TERM_MONTHS ? 'near' : 'later';
    const byLabel = dated ? row.need?.byLabel ?? monthLabel(parseDay(goal.target_date)) : null;
    if (kind === 'near' || kind === 'kept') {
      const cash = cashSetAside(goal.id, contributions, allocations, accounts) * factor;
      const remaining = Math.max(0, cost - cash);
      const monthsLeft = dated ? Math.max(0, months) : null;
      const state = remaining <= 0 ? 'covered' : dated && monthsLeft <= 0 ? 'due' : 'saving';
      const perMonth = state === 'saving' && dated ? remaining / monthsLeft : null;
      return { ...row, kind, state, cost, cash, remaining, monthsLeft, perMonth, byLabel };
    }
    if (kind === 'later') {
      const year = Math.max(now.getFullYear(), parseDay(goal.target_date).getFullYear());
      const inYear = timeline?.find((r) => r.year === year);
      const state = !timeline ? 'unchecked' : inYear?.short > 0 ? 'short' : 'covered';
      return { ...row, kind, state, cost, year, short: inYear?.short ?? 0, byLabel };
    }
    return { ...row, kind, state: 'undated', cost };
  });
}

function monthLabel(d) {
  return `${MONTH_LABELS[d.getMonth()]} ${d.getFullYear()}`;
}

// The cash the near-term goals and dated reserves still need each month, the
// way it really falls: every goal's remainder spread to its own date, so the
// total drops as each date passes. `now` is the monthly figure today, and
// `after` what it falls to once the first of them is due, `until`.
export function cashPerMonth(statuses) {
  const saving = statuses.filter((r) => (r.kind === 'near' || r.kind === 'kept') && r.perMonth > 0);
  if (!saving.length) return null;
  const first = Math.min(...saving.map((r) => r.monthsLeft));
  return {
    now: saving.reduce((s, r) => s + r.perMonth, 0),
    until: saving.find((r) => r.monthsLeft === first).byLabel,
    after: saving.filter((r) => r.monthsLeft > first).reduce((s, r) => s + r.perMonth, 0),
  };
}
