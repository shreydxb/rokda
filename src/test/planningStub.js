// Planning's records as Overview's tests want them: loaded, and empty. Overview
// reads them for its Plan strip (the revamp, phase 3); a test about
// something else on Overview stubs them with this.
export function emptyPlanning(over = {}) {
  return {
    loading: false,
    refreshing: false,
    errors: {},
    loaded: { goals: true, goalContributions: true, goalAllocations: true, balanceEvents: true, debts: true, independenceIncome: true, afterWorkCosts: true, memberLife: true, notes: true, assumptions: true },
    goals: [],
    goalContributions: [],
    goalAllocations: [],
    balanceEvents: [],
    debts: [],
    independenceIncome: [],
    afterWorkCosts: [],
    memberLife: [],
    notes: [],
    assumptions: null,
    loadedAt: new Date(),
    reload: async () => {},
    ...over,
  };
}
