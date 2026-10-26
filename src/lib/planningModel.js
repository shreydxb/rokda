import { incompleteNote, netWorthSummary, startingNetWorth } from '../screens/overviewMath';
import { accountValueAed, isArchived, isLiabilityAccount } from './accounts';
import { isAwaitingFirstValuation } from './valuation';
import { unconfirmedAccounts } from './balance';
import { basisChoice, budgetInputs, budgetPlan, forecastInputs, spendThatStops } from './forecast';
import { lifePlanBasis, lifePlanStop, loansInSpending, planPeople } from './lifePlan';

// The planning model: the figures every Planning tab rests on, worked out in
// one place (Planning audit, 3.12). Plan, Goals, the Life plan and the two
// tabs since retired each built the same inputs on their own, and two of them
// worked out the Life plan's answer again; a change made to one, like the
// chosen basis (2.9) or a loan counted once (2.10), had to be made five times
// over, and any tab it missed told a different story.
//
//   startNetWorth  what the plan starts from (startingNetWorth);
//   start          the part of it held in cash and the part in rupees
//                  (planStart), for the cash rate and the rupee drift case;
//   startGaps      what that start leaves out (`incomplete`, accounts with
//                  no AED value and holdings never valued) and the open
//                  accounts whose balance was never entered, counted as 0
//                  (`unentered`): said on every tab that projects, the same
//                  way, now that Forecast, which said most of it, has gone
//                  (Planning audit, 3.15);
//   plan           the budget's month (budgetPlan);
//   inputs         spending and saving on the chosen basis (forecastInputs);
//   stopping       what stops when work does (spendThatStops);
//   budgetBasis    the budget's figures, while the records are the basis, for
//                  its answer beside theirs (1.2), and `budgetStopping`;
//   loans          the loans paid out of spending (loansInSpending);
//   people         the people planned for (planPeople);
//   basis(whatIfs) the Life plan's basis (lifePlanBasis), with a tab's what-ifs
//                  (fcSet, stopOverride, spendKind) or the budget's figures
//                  (`budget: true`);
//   stop(whatIfs)  the saved plan's answer (lifePlanStop), likewise.
export function planningModel({ accounts = [], holdings = [], transactions = [], recurring = [], budgets = [], categories = [], data = {}, members = [], household = null, now = new Date() }) {
  const startNetWorth = startingNetWorth(accounts, holdings);
  const start = planStart(accounts, holdings);
  const summary = netWorthSummary(accounts, null, holdings);
  const startGaps = {
    incomplete: incompleteNote({ accounts: summary.unvalued, holdings: summary.unpricedHoldings }, { capitalised: false, sentence: false }),
    unentered: unconfirmedAccounts(accounts.filter((a) => !isArchived(a))),
  };
  const plan = budgetPlan(budgets, categories, now);
  const inputs = forecastInputs(transactions, startNetWorth, now, plan, recurring, basisChoice(data.assumptions));
  const stopping = spendThatStops({ inputs, transactions, budgets, categories, now });
  const budgetBasis = inputs.source === 'actual' ? budgetInputs(plan, startNetWorth, inputs.monthCount) : null;
  const budgetStopping = budgetBasis ? spendThatStops({ inputs: budgetBasis, transactions, budgets, categories, now }) : null;
  const loans = loansInSpending({ debts: data.debts ?? [], accounts, transactions, now });
  const people = planPeople(members, data.memberLife ?? []);
  const shared = {
    assumptions: data.assumptions,
    startNetWorth,
    start,
    goals: data.goals ?? [],
    incomes: data.independenceIncome ?? [],
    costs: data.afterWorkCosts ?? [],
    household,
    loans,
    startYear: now.getFullYear(),
    now,
  };
  const on = (budget) => (budget ? { inputs: budgetBasis, stopping: budgetStopping } : { inputs, stopping });
  return {
    startNetWorth,
    start,
    startGaps,
    plan,
    inputs,
    stopping,
    budgetBasis,
    budgetStopping,
    loans,
    people,
    basis: ({ budget = false, ...whatIfs } = {}) => lifePlanBasis({ people, ...shared, ...on(budget), ...whatIfs }),
    stop: ({ budget = false, ...whatIfs } = {}) => (budget && !budgetBasis ? null : lifePlanStop({ members, memberLife: data.memberLife ?? [], ...shared, ...on(budget), ...whatIfs })),
  };
}

// What the plan starts from that is cash, and what is in rupees, household-wide
// and in AED (Planning audit, 4.19). Cash is the current, savings, cash and
// fixed-deposit accounts and holdings in cash: the plan keeps it as cash at a
// cash rate, where it used to earn the investment return. Rupees are the open
// accounts and holdings in rupees, for the rupee drift case; a rupee debt is
// left out, so the case errs towards harm. An account or holding with no
// value yet counts nothing, as it does in net worth.
const CASH_ACCOUNT_TYPES = new Set(['checking', 'savings', 'cash', 'fd']);
export function planStart(accounts = [], holdings = []) {
  let cash = 0;
  let rupees = 0;
  for (const a of accounts) {
    if (isArchived(a) || isLiabilityAccount(a)) continue;
    const aed = accountValueAed(a);
    if (!(aed > 0)) continue;
    if (CASH_ACCOUNT_TYPES.has(a.type)) cash += aed;
    if (String(a.currency ?? 'AED').toUpperCase() === 'INR') rupees += aed;
  }
  for (const h of holdings) {
    if (isAwaitingFirstValuation(h)) continue;
    const aed = Number(h.value_aed) || 0;
    if (!(aed > 0)) continue;
    if (h.asset_class === 'cash') cash += aed;
    if (String(h.currency ?? 'AED').toUpperCase() === 'INR') rupees += aed;
  }
  return { cash, rupees };
}
