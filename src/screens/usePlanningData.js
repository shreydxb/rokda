import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

const EMPTY_STATE = {
  loading: false,
  goals: [],
  goalContributions: [],
  debts: [],
  assumptions: null,
};

export function usePlanningData(householdId) {
  const [state, setState] = useState({ ...EMPTY_STATE, loading: true });

  const reload = useCallback(async () => {
    if (!householdId) {
      setState(EMPTY_STATE);
      return;
    }
    setState((s) => ({ ...s, loading: true }));

    const [
      { data: goals, error: goalsErr },
      { data: goalContributions, error: contribErr },
      { data: debts, error: debtsErr },
      { data: assumptionsRows, error: assumErr },
    ] = await Promise.all([
      supabase.from('goals').select('*').eq('household_id', householdId).order('created_at'),
      // RLS scopes this to the caller's household via a join on goals.
      supabase.from('goal_contributions').select('*').order('occurred_at', { ascending: false }),
      supabase.from('debts').select('*').eq('household_id', householdId).order('created_at'),
      supabase.from('planning_assumptions').select('*').eq('household_id', householdId).maybeSingle(),
    ]);

    setState({
      loading: false,
      goals: goalsErr ? [] : (goals ?? []),
      goalContributions: contribErr ? [] : (goalContributions ?? []),
      debts: debtsErr ? [] : (debts ?? []),
      assumptions: assumErr ? null : (assumptionsRows ?? null),
      error: goalsErr || contribErr || debtsErr || assumErr || null,
    });
  }, [householdId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kicks off an async fetch; loading flag is the point
    reload();
  }, [reload]);

  return { ...state, reload };
}
