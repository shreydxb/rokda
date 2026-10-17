import { createContext, useContext, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

// Household scope: 'both' | 'me' | 'partner'. 'partner' is a stable role key —
// the display label shown for it (e.g. in AppShell's scope toggle) comes from
// the real second household member's name, not from this key.
//
// The choice is remembered in this browser, so a reload keeps the person
// whose totals are on screen (QA re-review, 17 October: it went back to
// Both). A link can choose it with `?who=both` (ScopeFromLink, below): the
// monthly review counts the whole household, so its links open the records
// for Both whoever was selected.
export const SCOPES = ['both', 'me', 'partner'];
const STORAGE_KEY = 'rokda.scope';

function storedScope() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return SCOPES.includes(value) ? value : 'both';
  } catch {
    return 'both';
  }
}

const ScopeContext = createContext(undefined);

export function ScopeProvider({ children }) {
  const [scope, setScopeState] = useState(storedScope);
  const setScope = (next) => {
    setScopeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // A private window may refuse storage; the choice still holds until reload.
    }
  };
  return <ScopeContext.Provider value={{ scope, setScope }}>{children}</ScopeContext.Provider>;
}

export function useScope() {
  const ctx = useContext(ScopeContext);
  if (ctx === undefined) throw new Error('useScope must be used within a ScopeProvider');
  return ctx;
}

// Applies a link's `?who=` and takes it out of the address, so the selector
// stays the one control for it from then on.
export function ScopeFromLink() {
  const { setScope } = useScope();
  const [params, setParams] = useSearchParams();
  const who = params.get('who');
  useEffect(() => {
    if (!who) return;
    if (SCOPES.includes(who)) setScope(who);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('who');
        return next;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [who]);
  return null;
}
