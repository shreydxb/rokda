import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

const EMPTY_STATE = { loading: false, accounts: [], transactions: [], categories: [], recurring: [] };

export function useOverviewData(householdId) {
  const [state, setState] = useState({ ...EMPTY_STATE, loading: true });

  const reload = useCallback(async () => {
    if (!householdId) {
      setState(EMPTY_STATE);
      return;
    }
    setState((s) => ({ ...s, loading: true }));

    const [
      { data: accounts, error: accErr },
      { data: transactions, error: txErr },
      { data: categories, error: catErr },
      { data: recurring, error: recErr },
    ] = await Promise.all([
      supabase.from('accounts').select('*').eq('household_id', householdId).order('created_at'),
      supabase
        .from('transactions')
        .select('*, categories(id, name, kind)')
        .eq('household_id', householdId)
        .order('occurred_at', { ascending: false }),
      supabase.from('categories').select('*').eq('household_id', householdId).order('name'),
      supabase.from('recurring').select('*').eq('household_id', householdId).order('next_due_date'),
    ]);

    setState({
      loading: false,
      accounts: accErr ? [] : (accounts ?? []),
      transactions: txErr ? [] : (transactions ?? []),
      categories: catErr ? [] : (categories ?? []),
      recurring: recErr ? [] : (recurring ?? []),
      error: accErr || txErr || catErr || recErr || null,
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
