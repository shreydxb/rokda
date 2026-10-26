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
        // A split record's lines come with it (lib/splits.js).
        .select('*, categories(id, name, kind), transaction_splits(id, category_id, amount)')
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
  // Notes the household checks once a year, for Needs attention (lib/yearlyChecks.js).
  {
    key: 'yearlyChecks',
    query: (id) => supabase.from('household_notes').select('id, title, check_yearly, checked_on').eq('household_id', id).eq('check_yearly', true).order('position').order('id'),
  },
  // Which transactions are two sides of one transfer (docs/decisions.md,
  // "Transfers are neither income nor spending").
  { key: 'transactionLinks', query: (id) => supabase.from('transaction_links').select('*').eq('household_id', id).order('created_at').order('id') },
  // Rupees per dirham by day, so a payment in rupees is estimated at its own
  // date's rate (docs/decisions.md, "A payment in rupees keeps both amounts").
  // The same for every household. One pair, so the day is unique.
  {
    key: 'fxRateHistory',
    query: () => supabase.from('fx_rate_history').select('base, quote, day, rate').eq('base', 'AED').eq('quote', 'INR').order('day'),
  },
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
  yearlyChecks: [],
  transactionLinks: [],
  fxRateHistory: [],
  errors: {},
  loadedAt: null,
};

export function useOverviewData(householdId) {
  return useSources(householdId, SOURCES, EMPTY_STATE);
}

// The six of these that Planning's tabs read. Planning used to load all
// fourteen, wait for every one before showing anything, and name a failed
// backup or rule read in its own banner.
export const PLANNING_INPUT_KEYS = ['accounts', 'transactions', 'categories', 'recurring', 'budgets', 'holdings'];
const PLANNING_INPUT_SOURCES = SOURCES.filter((source) => PLANNING_INPUT_KEYS.includes(source.key));
const PLANNING_INPUT_EMPTY = { loading: false, accounts: [], transactions: [], categories: [], recurring: [], budgets: [], holdings: [], errors: {}, loadedAt: null };

export function usePlanningInputs(householdId) {
  return useSources(householdId, PLANNING_INPUT_SOURCES, PLANNING_INPUT_EMPTY);
}

export { isLiabilityAccount } from '../lib/accounts';

const LIQUID_TYPES = new Set(['checking', 'savings', 'cash']);
export function isLiquidAccount(account) {
  return LIQUID_TYPES.has(account.type);
}
