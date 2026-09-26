import { formatMoney } from './money';
import { parseDay } from './day';
import { accountValueAed } from './accounts';

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
export function scopedGoalRows({ goals = [], contributions = [], allocations = [], accounts = [], holdings = [], scopeMemberId = null, now = new Date() }) {
  return goals
    .filter((g) => scopeMemberId === null || g.is_shared || g.owner_member_id === scopeMemberId)
    .map((g) => {
      const factor = scopeMemberId === null || !g.is_shared ? 1 : 0.5;
      const scopedGoal = { ...g, target_amount: Number(g.target_amount) * factor };
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
