import { HouseholdContext, useHouseholdLoader } from './useHousehold';

// Loads the signed-in member's household once, for everything inside it
// (useHousehold.js says why).
export function HouseholdProvider({ children }) {
  const value = useHouseholdLoader();
  return <HouseholdContext.Provider value={value}>{children}</HouseholdContext.Provider>;
}
