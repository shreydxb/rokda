import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { readAllPages } from '../lib/pagedRead';

// One entry per query, failures reported per source (QA-10). Every list is
// read a page at a time, as the other screens' are (docs/decisions.md, "A
// screen reads every row, a page at a time"): this hook was missed, so goal
// contributions past 1,000 would have dropped off without a word. Each query
// ends in a unique column so pages cannot overlap or skip a row.
const paged = (query) => (id) => readAllPages(() => query(id));
const SOURCES = [
  { key: 'goals', empty: [], run: paged((id) => supabase.from('goals').select('*').eq('household_id', id).order('created_at').order('id')) },
  // RLS scopes this to the caller's household via a join on goals.
  { key: 'goalContributions', empty: [], run: paged(() => supabase.from('goal_contributions').select('*').order('occurred_at', { ascending: false }).order('id')) },
  { key: 'goalAllocations', empty: [], run: paged((id) => supabase.from('goal_allocations').select('*').eq('household_id', id).order('created_at').order('id')) },
  { key: 'debts', empty: [], run: paged((id) => supabase.from('debts').select('*').eq('household_id', id).order('created_at').order('id')) },
  { key: 'independenceIncome', empty: [], run: paged((id) => supabase.from('independence_income').select('*').eq('household_id', id).order('created_at').order('id')) },
  { key: 'memberLife', empty: [], run: paged((id) => supabase.from('member_life').select('*').eq('household_id', id).order('member_id')) },
  { key: 'notes', empty: [], run: paged((id) => supabase.from('household_notes').select('*').eq('household_id', id).order('position').order('created_at').order('id')) },
  // One row per household, so one request.
  { key: 'assumptions', empty: null, run: (id) => supabase.from('planning_assumptions').select('*').eq('household_id', id).maybeSingle() },
];

// The sources this hook loads, so a test can check each has a name to fail with.
export const PLANNING_SOURCE_KEYS = SOURCES.map((source) => source.key);

const EMPTY_STATE = {
  loading: false,
  goals: [],
  goalContributions: [],
  goalAllocations: [],
  debts: [],
  independenceIncome: [],
  memberLife: [],
  notes: [],
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
