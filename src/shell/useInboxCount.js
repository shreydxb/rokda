import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';

// The Money screen announces the Inbox's count whenever its own data is read
// (an item approved or rejected, a refresh), so the sidebar follows without
// asking again.
export const INBOX_COUNT_EVENT = 'rokda:inbox-count';

// How many Inbox items wait, for the sidebar (the revamp, review N1). Read
// again on a move to another screen -- not on a change of filter, which
// Activity writes into the address on every keystroke. Past 99 the badge says
// no more.
export function useInboxCount(householdId) {
  const [state, setState] = useState({ householdId, count: 0 });
  const location = useLocation();
  // Each read and each announcement takes a number; a read lands only if
  // nothing newer has, so a read that set out before Money announced a newer
  // count cannot put the older one back.
  const seq = useRef(0);
  const landed = useRef(0);

  useEffect(() => {
    if (!householdId) return undefined;
    const mine = ++seq.current;
    let live = true;
    supabase
      .from('intake')
      .select('id')
      .eq('household_id', householdId)
      .eq('status', 'pending')
      .limit(100)
      .then(({ data, error }) => {
        // A failed count leaves the last one; the Inbox itself says what failed.
        if (!live || error || mine < landed.current) return;
        landed.current = mine;
        setState({ householdId, count: data?.length ?? 0 });
      });
    return () => {
      live = false;
    };
  }, [householdId, location.pathname]);

  useEffect(() => {
    const onCount = (e) => {
      if (!Number.isFinite(e.detail)) return;
      landed.current = ++seq.current;
      setState({ householdId, count: e.detail });
    };
    window.addEventListener(INBOX_COUNT_EVENT, onCount);
    return () => window.removeEventListener(INBOX_COUNT_EVENT, onCount);
  }, [householdId]);

  // Another household's count is never shown, even before its own is read.
  return householdId && state.householdId === householdId ? state.count : 0;
}
