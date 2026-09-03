import { createContext, useContext, useState } from 'react';

// Household scope: 'both' | 'me' | 'partner'. Real member names/labels come
// from Settings → Household once that screen exists; 'partner' is a stable
// role, not tied to whichever name is displayed for it.
const ScopeContext = createContext(undefined);

export function ScopeProvider({ children }) {
  const [scope, setScope] = useState('both');
  return <ScopeContext.Provider value={{ scope, setScope }}>{children}</ScopeContext.Provider>;
}

export function useScope() {
  const ctx = useContext(ScopeContext);
  if (ctx === undefined) throw new Error('useScope must be used within a ScopeProvider');
  return ctx;
}
