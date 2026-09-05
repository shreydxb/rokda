import { formatMoney } from './money';
import { parseDay } from './day';

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Everything about a goal's progress — saved, last contribution, projected
// date, status — is derived from its contribution log, never stored on the
// goal row, so it can't drift out of sync with what was actually logged.
export function goalProgress(goal, contributions, now = new Date()) {
  const target = Number(goal.target_amount) || 0;
  const saved = contributions.reduce((s, c) => s + Number(c.amount), 0);
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
    const targetD = new Date(goal.target_date);
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
