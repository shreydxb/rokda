// Simulates paying a single debt at its minimum only: interest accrues on
// the balance each month, then the minimum is applied. If the minimum
// doesn't even cover a month's interest the balance never clears — that
// returns null (revolves indefinitely) rather than looping forever.
export function amortizeMinimumOnly(balance, aprPct, minimumPayment, maxMonths = 600) {
  let bal = Number(balance);
  const monthlyRate = Number(aprPct) / 100 / 12;
  const payment = Number(minimumPayment);
  for (let m = 1; m <= maxMonths; m++) {
    const interest = bal * monthlyRate;
    if (payment <= interest) return null;
    bal = bal + interest - payment;
    if (bal <= 0) return m;
  }
  return null;
}

export function orderDebts(debts, strategy) {
  const rows = [...debts];
  if (strategy === 'avalanche') rows.sort((a, b) => Number(b.apr_pct) - Number(a.apr_pct));
  else if (strategy === 'snowball') rows.sort((a, b) => Number(a.balance) - Number(b.balance));
  else rows.sort((a, b) => (a.custom_rank ?? 999) - (b.custom_rank ?? 999));
  return rows;
}

// Rolling payoff: pay every debt's minimum, then dump the extra payment
// (plus the minimums freed up by any debt that's already cleared) onto the
// highest-priority debt still open, in the order given.
export function simulatePayoffPlan(orderedDebts, extraPayment, maxMonths = 600) {
  const balances = orderedDebts.map((d) => Number(d.balance));
  const rates = orderedDebts.map((d) => Number(d.apr_pct) / 100 / 12);
  const minimums = orderedDebts.map((d) => Number(d.minimum_payment));
  let totalInterest = 0;

  for (let m = 1; m <= maxMonths; m++) {
    if (balances.every((b) => b <= 0)) return { months: m - 1, totalInterest };

    for (let i = 0; i < balances.length; i++) {
      if (balances[i] <= 0) continue;
      const interest = balances[i] * rates[i];
      totalInterest += interest;
      balances[i] += interest;
    }

    let pool = Number(extraPayment) || 0;
    for (let i = 0; i < balances.length; i++) {
      if (balances[i] <= 0) pool += minimums[i];
    }

    for (let i = 0; i < balances.length; i++) {
      if (balances[i] <= 0) continue;
      balances[i] -= Math.min(balances[i], minimums[i]);
    }

    for (let i = 0; i < balances.length && pool > 0; i++) {
      if (balances[i] <= 0) continue;
      const pay = Math.min(balances[i], pool);
      balances[i] -= pay;
      pool -= pay;
    }
  }
  return null;
}
