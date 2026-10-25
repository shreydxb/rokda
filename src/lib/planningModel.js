import { startingNetWorth } from '../screens/overviewMath';
import { basisChoice, budgetInputs, budgetPlan, forecastInputs, spendThatStops } from './forecast';
import { lifePlanBasis, lifePlanStop, loansInSpending, planPeople } from './lifePlan';

// The planning model: the figures every Planning tab rests on, worked out in
// one place (Planning audit, 3.12). Plan, Goals, the Life plan, Forecast and
// Drawdown each built the same inputs on their own, and Plan and Forecast
// worked out the Life plan's answer again; a change made to one, like the
// chosen basis (2.9) or a loan counted once (2.10), had to be made five times
// over, and any tab it missed told a different story.
//
//   startNetWorth  what the plan starts from (startingNetWorth);
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
