import { createContext, useContext, useState } from 'react';

// Household scope: 'both' | 'me' | 'partner'. 'partner' is a stable role key —
// the display label shown for it (e.g. in AppShell's scope toggle) comes from
// the real second household member's name, not from this key.
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
