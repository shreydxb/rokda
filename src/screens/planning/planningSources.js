// The records each Planning tab is built from, by source key (useSources). A
// tab whose source never loaded says so (Withheld.jsx) instead of showing an
// empty list, or a figure worked out without it, as the household's own.
export const GOALS_INPUTS = ['goals', 'goalContributions', 'goalAllocations', 'accounts', 'holdings'];
export const DEBT_INPUTS = ['debts', 'accounts', 'assumptions'];
export const PROJECTION_INPUTS = ['memberLife', 'goals', 'independenceIncome', 'assumptions', 'accounts', 'holdings', 'transactions', 'recurring', 'budgets', 'categories'];
export const NOTES_INPUTS = ['notes'];
