// The records each Planning tab is built from, by source key (useSources;
// `household` is the household lookup itself). A tab whose source never
// loaded says so (Withheld.jsx) instead of showing an empty list, or a figure
// worked out without it, as the household's own.
export const GOALS_INPUTS = ['household', 'goals', 'goalContributions', 'goalAllocations', 'accounts', 'holdings', 'assumptions'];
// The debts and their balances. The payoff projection also rests on the
// saved extra payment, so only it waits for the assumptions.
export const DEBT_INPUTS = ['household', 'debts', 'accounts'];
export const DEBT_PLAN_INPUTS = ['assumptions'];
export const NOTES_INPUTS = ['household', 'notes'];

// The debts too: a loan paid out of spending is counted there, once, and read
// as none it would be counted twice again (Planning audit, 2.10). And the
// costs that start when work stops (3.13), which read as none would pass a
// plan that leaves them out as the household's.
const PROJECTION_INPUTS = ['household', 'memberLife', 'goals', 'independenceIncome', 'afterWorkCosts', 'debts', 'assumptions', 'accounts', 'holdings', 'transactions', 'recurring', 'categories'];

// What a projection rests on. The budget is the basis when the household
// chose it, and otherwise stands in only until three months have ended
// (forecastInputs), so only then is a budget that never loaded a reason to
// withhold it: read as no budget, it would pass the records off as standing
// in for one.
export function projectionInputs(inputs) {
  return inputs?.monthCount >= 3 && inputs?.basis !== 'budget' ? PROJECTION_INPUTS : [...PROJECTION_INPUTS, 'budgets'];
}
