import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

export function useOverviewData(householdId) {
  const [state, setState] = useState({ loading: true, accounts: [], transactions: [], categories: [] });

  const reload = useCallback(async () => {
    if (!householdId) {
      setState({ loading: false, accounts: [], transactions: [], categories: [] });
      return;
    }
    setState((s) => ({ ...s, loading: true }));

    const [
      { data: accounts, error: accErr },
      { data: transactions, error: txErr },
      { data: categories, error: catErr },
    ] = await Promise.all([
      supabase.from('accounts').select('*').eq('household_id', householdId).order('created_at'),
      supabase
        .from('transactions')
        .select('*, categories(id, name, kind)')
        .eq('household_id', householdId)
        .order('occurred_at', { ascending: false }),
      supabase.from('categories').select('*').eq('household_id', householdId).order('name'),
    ]);

    setState({
      loading: false,
      accounts: accErr ? [] : (accounts ?? []),
      transactions: txErr ? [] : (transactions ?? []),
      categories: catErr ? [] : (categories ?? []),
      error: accErr || txErr || catErr || null,
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
