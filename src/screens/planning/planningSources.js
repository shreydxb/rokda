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

const PROJECTION_INPUTS = ['household', 'memberLife', 'goals', 'independenceIncome', 'assumptions', 'accounts', 'holdings', 'transactions', 'recurring', 'categories'];

// What a projection rests on. The budget stands in for spending and saving
// only until three months have closed (forecastInputs), so only until then is
// a budget that never loaded a reason to withhold it.
export function projectionInputs(inputs) {
  return inputs?.monthCount >= 3 ? PROJECTION_INPUTS : [...PROJECTION_INPUTS, 'budgets'];
}
