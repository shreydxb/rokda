export function utilisation(account) {
  if (!account.credit_limit) return null;
  return Number(account.balance) / Number(account.credit_limit);
}

// statement_day is a day-of-month (1-31). Returns the most recently closed
// statement date and the next (still-open) close date, straddling "now".
export function billingCycle(statementDay, now = new Date()) {
  const thisMonthClose = new Date(now.getFullYear(), now.getMonth(), statementDay);
  const lastClose = thisMonthClose > now ? new Date(now.getFullYear(), now.getMonth() - 1, statementDay) : thisMonthClose;
  const cycleStart = new Date(lastClose.getFullYear(), lastClose.getMonth() - 1, statementDay);
  const nextClose = new Date(lastClose.getFullYear(), lastClose.getMonth() + 1, statementDay);
  return { cycleStart, lastClose, nextClose };
}

// Spend on this account since the last statement closed — a running
// estimate of what the next statement will total, not a real posted vs.
// authorised distinction (we don't track pending/cleared status).
export function estimatedStatement(transactions, accountId, statementDay, now = new Date()) {
  if (!statementDay) return null;
  const { lastClose, nextClose } = billingCycle(statementDay, now);
  const amount = transactions
    .filter((t) => t.account_id === accountId)
    .filter((t) => {
      const d = new Date(t.occurred_at);
      return d >= lastClose && d < nextClose;
    })
    .reduce((sum, t) => sum + Math.max(0, -Number(t.amount)), 0);
  return { amount, since: lastClose, closes: nextClose };
}
