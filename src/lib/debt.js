import { accountValueAed, amountOwed, isArchived } from './accounts';
import { formatMoney } from './money';
import { andList } from './words';

// Simulates paying a single debt at its minimum only: interest accrues on
// the balance each month, then the minimum is applied. Returns the months it
// takes; 0 when nothing is owed; null when the minimum doesn't even cover a
// month's interest, so the balance never clears; and Infinity when it does
// clear, but not within maxMonths (50 years). A paid-off debt used to read as
// clearing in a month, and a very long one as never clearing.
export function amortizeMinimumOnly(balance, aprPct, minimumPayment, maxMonths = 600) {
  return atMinimum(balance, aprPct, minimumPayment, maxMonths).months;
}

// The same, with the interest paid along the way; null when there is no date
// to add it up to.
function atMinimum(balance, aprPct, minimumPayment, maxMonths = 600) {
  let bal = Number(balance);
  if (!(bal > 0)) return { months: 0, interest: 0 };
  const monthlyRate = Number(aprPct) / 100 / 12;
  const payment = Number(minimumPayment);
  let paid = 0;
  for (let m = 1; m <= maxMonths; m++) {
    const interest = bal * monthlyRate;
    if (payment <= interest) return { months: null, interest: null };
    paid += interest;
    bal = bal + interest - payment;
    if (bal <= 0) return { months: m, interest: paid };
  }
  return { months: Infinity, interest: null };
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// When the debts clear if each is paid only its own minimum: the date the
// household is on before any extra payment is committed (Planning audit,
// 1.1). A minimum freed when one debt clears is not assumed to move on to the
// next. Nothing commits it there, and assuming it can bring the last date
// years closer; Debt payoff projects that once an extra payment is set.
//
// `months` is how long the last of them takes and `last` is that debt; a debt
// owing nothing is left out, and `owed` counts the rest. `never` holds the
// debts whose minimum doesn't cover their interest and `tooLong` those taking
// more than 50 years. Neither has a date, and while there is one, the debts
// as a whole have none. `interest` is what the minimums pay in interest until
// they clear, null without a date; `byDebt` gives each debt's months and
// interest (Planning audit, 1.4).
export function minimumOnlyPayoff(debts) {
  const rows = debts.map((debt) => ({ debt, ...atMinimum(debt.balance, debt.apr_pct, debt.minimum_payment) })).filter((r) => r.months !== 0);
  const dated = rows.filter((r) => Number.isFinite(r.months));
  const latest = dated.reduce((a, r) => (!a || r.months > a.months ? r : a), null);
  const never = rows.filter((r) => r.months === null).map((r) => r.debt);
  const tooLong = rows.filter((r) => r.months === Infinity).map((r) => r.debt);
  return {
    owed: rows.length,
    months: latest?.months ?? null,
    last: latest?.debt ?? null,
    never,
    tooLong,
    interest: never.length || tooLong.length ? null : dated.reduce((s, r) => s + r.interest, 0),
    byDebt: rows,
  };
}

// The debts in words, from minimumOnlyPayoff: "Clears about Aug 2030 at the
// minimum payment", or why there is no date. Plan and Debt payoff say it the
// same way.
export function minimumOnlyText(atMinimums, now = new Date()) {
  if (atMinimums.owed === 0) return 'Nothing owed';
  if (atMinimums.never.length > 0) {
    const names = atMinimums.never.map((d) => d.name);
    return `No payoff date: the minimum on ${andList(names)} doesn't cover ${names.length === 1 ? 'its' : 'their'} interest`;
  }
  if (atMinimums.tooLong.length > 0) {
    const names = atMinimums.tooLong.map((d) => d.name);
    return `${andList(names)} ${names.length === 1 ? 'takes' : 'take'} more than 50 years at the minimum`;
  }
  const when = payoffMonthLabel(atMinimums.months, now);
  return atMinimums.owed === 1 ? `Clears about ${when} at the minimum payment` : `All clear about ${when} at the minimums, ${atMinimums.last.name} last`;
}

// "AED 2,140 of interest still to pay": what the minimums cost until the debts
// clear, or nothing to say without a date.
export function interestText(atMinimums) {
  return atMinimums.interest === null || atMinimums.owed === 0 ? null : `AED ${formatMoney(Math.round(atMinimums.interest))} of interest still to pay`;
}

// "Aug 2030": the month a payoff `months` from now lands in.
export function payoffMonthLabel(months, now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth() + months, 1);
  return `${MONTH_LABELS[d.getMonth()]} ${d.getFullYear()}`;
}

// The payoff order the household picked on Debt payoff (planning_assumptions
// .debt_order), avalanche until it picks. Plan follows the same one.
export const DEBT_ORDERS = ['avalanche', 'snowball'];
export function debtOrder(assumptions) {
  return DEBT_ORDERS.includes(assumptions?.debt_order) ? assumptions.debt_order : 'avalanche';
}

// An account's owner in a debt's terms: shared, or one member's.
export function accountOwner(account) {
  const shared = account.is_shared ?? !account.owner_member_id;
  return { is_shared: shared, owner_member_id: shared ? null : (account.owner_member_id ?? null) };
}

export function orderDebts(debts, strategy) {
  const rows = [...debts];
  if (strategy === 'avalanche') rows.sort((a, b) => Number(b.apr_pct) - Number(a.apr_pct));
  else if (strategy === 'snowball') rows.sort((a, b) => Number(a.balance) - Number(b.balance));
  else rows.sort((a, b) => (a.custom_rank ?? 999) - (b.custom_rank ?? 999));
  return rows;
}

// Rolling payoff: pay every debt's minimum, then dump the extra payment
// (plus whatever of this month's minimum budget went unused — a debt that's
// already cleared, or one that pays off with less than its full minimum)
// onto the highest-priority debt still open, in the order given.
export function simulatePayoffPlan(orderedDebts, extraPayment, maxMonths = 600) {
  const balances = orderedDebts.map((d) => Number(d.balance));
  const rates = orderedDebts.map((d) => Number(d.apr_pct) / 100 / 12);
  const minimums = orderedDebts.map((d) => Number(d.minimum_payment));
  let totalInterest = 0;

  // Debts already paid off before the simulation starts need no month at all.
  if (balances.every((b) => b <= 0)) return { months: 0, totalInterest };

  for (let m = 1; m <= maxMonths; m++) {
    for (let i = 0; i < balances.length; i++) {
      if (balances[i] <= 0) continue;
      const interest = balances[i] * rates[i];
      totalInterest += interest;
      balances[i] += interest;
    }

    // Every minimum's budget is committed this month, whether or not the
    // debt it belongs to actually needs all of it: a debt already cleared
    // frees its whole minimum, and one that clears with less than its
    // minimum frees the remainder — both join the pool in the SAME month,
    // not the next one.
    let pool = Number(extraPayment) || 0;
    for (let i = 0; i < balances.length; i++) {
      if (balances[i] <= 0) {
        pool += minimums[i];
        continue;
      }
      const pay = Math.min(balances[i], minimums[i]);
      balances[i] -= pay;
      pool += minimums[i] - pay;
    }

    for (let i = 0; i < balances.length && pool > 0; i++) {
      if (balances[i] <= 0) continue;
      const pay = Math.min(balances[i], pool);
      balances[i] -= pay;
      pool -= pay;
    }

    // Checked at the end of the month that pays it off, not the top of the
    // next one — otherwise a payoff that lands exactly on maxMonths is never
    // detected, since there is no maxMonths + 1 iteration to notice it.
    if (balances.every((b) => b <= 0)) return { months: m, totalInterest };
  }
  return null;
}

// A debt linked to a loan or card account owes what that account says: the
// account is the one balance, and it is what net worth counts. A debt with no
// account, or whose account is closed or has no AED value, keeps the balance
// last entered on it, and `inNetWorth` says net worth does not see it. A card
// in credit owes nothing (amountOwed), and `inCredit` says so. A linked debt
// belongs to whoever the account does: Debt payoff gave a loan to one partner
// while net worth gave it to the other.
export function debtsWithAccounts(debts, accounts = []) {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return debts.map((d) => {
    const account = d.account_id ? (byId.get(d.account_id) ?? null) : null;
    const value = account && !isArchived(account) ? accountValueAed(account) : null;
    return {
      ...d,
      ...(account ? accountOwner(account) : {}),
      balance: value !== null ? amountOwed(account, value) : Number(d.balance),
      account,
      inNetWorth: value !== null,
      inCredit: value !== null && account.type === 'credit_card' && value < 0,
    };
  });
}
