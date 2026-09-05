import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

const SOURCES = [
  { key: 'goals', empty: [], run: (id) => supabase.from('goals').select('*').eq('household_id', id).order('created_at') },
  // RLS scopes this to the caller's household via a join on goals.
  { key: 'goalContributions', empty: [], run: () => supabase.from('goal_contributions').select('*').order('occurred_at', { ascending: false }) },
  { key: 'debts', empty: [], run: (id) => supabase.from('debts').select('*').eq('household_id', id).order('created_at') },
  { key: 'assumptions', empty: null, run: (id) => supabase.from('planning_assumptions').select('*').eq('household_id', id).maybeSingle() },
];

const EMPTY_STATE = {
  loading: false,
  goals: [],
  goalContributions: [],
  debts: [],
  assumptions: null,
  errors: {},
  loadedAt: null,
};

export function usePlanningData(householdId) {
  const [state, setState] = useState({ ...EMPTY_STATE, loading: true });

  const reload = useCallback(async () => {
    if (!householdId) {
      setState(EMPTY_STATE);
      return;
    }
    setState((s) => ({ ...s, loading: true }));

    const results = await Promise.all(SOURCES.map((source) => source.run(householdId)));

    setState((previous) => {
      const next = { loading: false, errors: {}, loadedAt: previous.loadedAt };
      let anySucceeded = false;
      SOURCES.forEach((source, i) => {
        const { data, error } = results[i];
        if (error) {
          // A failed debts fetch must not look like "no debts" (QA-10).
          next[source.key] = previous[source.key];
          next.errors[source.key] = error;
        } else {
          next[source.key] = data ?? source.empty;
          anySucceeded = true;
        }
      });
      if (anySucceeded) next.loadedAt = new Date();
      return next;
    });
  }, [householdId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kicks off an async fetch; loading flag is the point
    reload();
  }, [reload]);

  return { ...state, reload };
}
