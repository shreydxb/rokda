// Load outcomes, told honestly (QA-10, SHR-251).
//
// The data hooks used to turn a failed query into an empty array. A failed
// holdings fetch then looked exactly like "no investments", and a failed debts
// fetch like "no debts" — a network error produced a confident zero. These
// helpers keep the three outcomes distinct: loaded, empty, failed.

export const SOURCE_LABELS = {
  accounts: 'accounts',
  transactions: 'transactions',
  categories: 'categories',
  recurring: 'recurring bills',
  budgets: 'budgets',
  intake: 'the inbox',
  netWorthSnapshots: 'net-worth history',
  holdings: 'investments',
  holdingHistory: 'holding history',
  categoryRules: 'category rules',
  goals: 'goals',
  goalContributions: 'goal contributions',
  debts: 'debts',
  assumptions: 'planning assumptions',
  household: 'your household',
};

export function labelFor(key) {
  return SOURCE_LABELS[key] ?? key;
}

// Which sources failed on the most recent attempt.
export function failedSources(errors = {}) {
  return Object.entries(errors)
    .filter(([, error]) => error)
    .map(([key]) => key);
}

// True when any of the named inputs failed — a figure that depends on them
// must be withheld rather than shown as a total that happens to omit them.
export function anyFailed(errors = {}, keys = []) {
  return keys.some((key) => Boolean(errors?.[key]));
}

export function failureMessage(errors = {}) {
  const failed = failedSources(errors);
  if (failed.length === 0) return null;
  const names = failed.map(labelFor);
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `Couldn’t load ${list}.`;
}
