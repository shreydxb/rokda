import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';

// The Money screen announces the Inbox's count whenever its own data changes
// (an item approved or rejected), so the sidebar follows without asking again.
export const INBOX_COUNT_EVENT = 'rokda:inbox-count';

// How many Inbox items wait, for the sidebar (the revamp, review N1). Read
// again on every move between screens; past 99 the badge says no more.
export function useInboxCount(householdId) {
  const [count, setCount] = useState(0);
  const location = useLocation();

  useEffect(() => {
    if (!householdId) return undefined;
    let live = true;
    supabase
      .from('intake')
      .select('id')
      .eq('household_id', householdId)
      .eq('status', 'pending')
      .limit(100)
      .then(({ data, error }) => {
        // A failed count leaves the last one; the Inbox itself says what failed.
        if (live && !error) setCount(data?.length ?? 0);
      });
    return () => {
      live = false;
    };
  }, [householdId, location.pathname, location.search]);

  useEffect(() => {
    const onCount = (e) => {
      if (Number.isFinite(e.detail)) setCount(e.detail);
    };
    window.addEventListener(INBOX_COUNT_EVENT, onCount);
    return () => window.removeEventListener(INBOX_COUNT_EVENT, onCount);
  }, []);

  return householdId ? count : 0;
}
