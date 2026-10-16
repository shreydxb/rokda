import { supabase } from '../lib/supabaseClient';
import { readAllPages } from '../lib/pagedRead';
import { useSources } from '../lib/useSources';

// One entry per query. Failures are reported per source rather than collapsed
// into a single flag, so a screen can say exactly what is missing (QA-10).
//
// Every source is read a page at a time (readAllPages): the API stops at
// 1,000 rows without saying so. Each query ends in a unique column, so the
// pages cannot overlap or skip a row.
const SOURCES = [
  { key: 'accounts', query: (id) => supabase.from('accounts').select('*').eq('household_id', id).order('created_at').order('id') },
  {
    key: 'transactions',
    query: (id) =>
      supabase
        .from('transactions')
        .select('*, categories(id, name, kind)')
        .eq('household_id', id)
        .order('occurred_at', { ascending: false })
        .order('id'),
  },
  { key: 'categories', query: (id) => supabase.from('categories').select('*').eq('household_id', id).order('name').order('id') },
  { key: 'recurring', query: (id) => supabase.from('recurring').select('*').eq('household_id', id).order('next_due_date').order('id') },
  { key: 'budgets', query: (id) => supabase.from('budgets').select('*').eq('household_id', id).order('id') },
  { key: 'intake', query: (id) => supabase.from('intake').select('*').eq('household_id', id).order('created_at', { ascending: false }).order('id') },
  {
    key: 'netWorthSnapshots',
    query: (id) => supabase.from('net_worth_snapshots').select('*').eq('household_id', id).order('snapshot_date').order('id'),
  },
  { key: 'holdings', query: (id) => supabase.from('holdings').select('*').eq('household_id', id).order('created_at').order('id') },
  // RLS scopes this to the caller's household via a join on holdings, so no explicit filter needed.
  { key: 'holdingHistory', query: () => supabase.from('holding_value_history').select('*').order('as_of').order('id') },
  { key: 'categoryRules', query: (id) => supabase.from('category_rules').select('*').eq('household_id', id).order('created_at').order('id') },
  {
    key: 'statementReconciliations',
    query: (id) => supabase.from('statement_reconciliations').select('*').eq('household_id', id).order('statement_date', { ascending: false }).order('id'),
  },
  { key: 'backupRecords', query: (id) => supabase.from('backup_records').select('*').eq('household_id', id).order('done_on', { ascending: false }).order('id') },
].map((source) => ({ ...source, run: (id) => readAllPages(() => source.query(id)) }));

// The sources this hook loads, so a test can check each has a name to fail with.
export const OVERVIEW_SOURCE_KEYS = SOURCES.map((source) => source.key);

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
  statementReconciliations: [],
  backupRecords: [],
  errors: {},
  loadedAt: null,
};

export function useOverviewData(householdId) {
  return useSources(householdId, SOURCES, EMPTY_STATE);
}

const LIABILITY_TYPES = new Set(['credit_card', 'loan']);
export function isLiabilityAccount(account) {
  return LIABILITY_TYPES.has(account.type);
}

const LIQUID_TYPES = new Set(['checking', 'savings', 'cash']);
export function isLiquidAccount(account) {
  return LIQUID_TYPES.has(account.type);
}
