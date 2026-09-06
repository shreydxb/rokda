import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

// One entry per query. Failures are reported per source rather than collapsed
// into a single flag, so a screen can say exactly what is missing (QA-10).
const SOURCES = [
  { key: 'accounts', run: (id) => supabase.from('accounts').select('*').eq('household_id', id).order('created_at') },
  {
    key: 'transactions',
    run: (id) =>
      supabase
        .from('transactions')
        .select('*, categories(id, name, kind)')
        .eq('household_id', id)
        .order('occurred_at', { ascending: false }),
  },
  { key: 'categories', run: (id) => supabase.from('categories').select('*').eq('household_id', id).order('name') },
  { key: 'recurring', run: (id) => supabase.from('recurring').select('*').eq('household_id', id).order('next_due_date') },
  { key: 'budgets', run: (id) => supabase.from('budgets').select('*').eq('household_id', id) },
  { key: 'intake', run: (id) => supabase.from('intake').select('*').eq('household_id', id).order('created_at', { ascending: false }) },
  {
    key: 'netWorthSnapshots',
    run: (id) => supabase.from('net_worth_snapshots').select('*').eq('household_id', id).order('snapshot_date'),
  },
  { key: 'holdings', run: (id) => supabase.from('holdings').select('*').eq('household_id', id).order('created_at') },
  // RLS scopes this to the caller's household via a join on holdings, so no explicit filter needed.
  { key: 'holdingHistory', run: () => supabase.from('holding_value_history').select('*').order('as_of') },
  { key: 'categoryRules', run: (id) => supabase.from('category_rules').select('*').eq('household_id', id).order('created_at') },
];

const EMPTY_STATE = {
  loading: false,
  accounts: [],
  transactions: [],
  categories: [],
  recurring: [],
  budgets: [],
  intake: [],
  netWorthSnapshots: [],
  holdings: [],
  holdingHistory: [],
  categoryRules: [],
  errors: {},
  loadedAt: null,
};

export function useOverviewData(householdId) {
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
          // Keep whatever was last known rather than replacing it with an
          // empty array, which reads as "you have none of these".
          next[source.key] = previous[source.key];
          next.errors[source.key] = error;
        } else {
          next[source.key] = data ?? [];
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

const LIABILITY_TYPES = new Set(['credit_card', 'loan']);
export function isLiabilityAccount(account) {
  return LIABILITY_TYPES.has(account.type);
}

const LIQUID_TYPES = new Set(['checking', 'savings', 'cash']);
export function isLiquidAccount(account) {
  return LIQUID_TYPES.has(account.type);
}
