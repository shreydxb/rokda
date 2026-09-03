import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

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
};

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
      { data: budgets, error: budErr },
      { data: intake, error: intakeErr },
      { data: netWorthSnapshots, error: nwErr },
      { data: holdings, error: holdErr },
      { data: holdingHistory, error: histErr },
      { data: categoryRules, error: ruleErr },
    ] = await Promise.all([
      supabase.from('accounts').select('*').eq('household_id', householdId).order('created_at'),
      supabase
        .from('transactions')
        .select('*, categories(id, name, kind)')
        .eq('household_id', householdId)
        .order('occurred_at', { ascending: false }),
      supabase.from('categories').select('*').eq('household_id', householdId).order('name'),
      supabase.from('recurring').select('*').eq('household_id', householdId).order('next_due_date'),
      supabase.from('budgets').select('*').eq('household_id', householdId),
      supabase.from('intake').select('*').eq('household_id', householdId).order('created_at', { ascending: false }),
      supabase.from('net_worth_snapshots').select('*').eq('household_id', householdId).order('snapshot_date'),
      supabase.from('holdings').select('*').eq('household_id', householdId).order('created_at'),
      // RLS scopes this to the caller's household via a join on holdings, so no explicit filter needed.
      supabase.from('holding_value_history').select('*').order('as_of'),
      supabase.from('category_rules').select('*').eq('household_id', householdId).order('created_at'),
    ]);

    setState({
      loading: false,
      accounts: accErr ? [] : (accounts ?? []),
      transactions: txErr ? [] : (transactions ?? []),
      categories: catErr ? [] : (categories ?? []),
      recurring: recErr ? [] : (recurring ?? []),
      budgets: budErr ? [] : (budgets ?? []),
      intake: intakeErr ? [] : (intake ?? []),
      netWorthSnapshots: nwErr ? [] : (netWorthSnapshots ?? []),
      holdings: holdErr ? [] : (holdings ?? []),
      holdingHistory: histErr ? [] : (holdingHistory ?? []),
      categoryRules: ruleErr ? [] : (categoryRules ?? []),
      error: accErr || txErr || catErr || recErr || budErr || intakeErr || nwErr || holdErr || histErr || ruleErr || null,
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
