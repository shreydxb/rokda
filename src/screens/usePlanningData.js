import { supabase } from '../lib/supabaseClient';
import { readAllPages } from '../lib/pagedRead';
import { useSources } from '../lib/useSources';

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
  // Every recorded balance change, which a goal's pace is measured from
  // (lib/goals.js, goalPace). A few a month per account: the editor and the
  // bot write them, never a transaction.
  {
    key: 'balanceEvents',
    empty: [],
    run: paged((id) => supabase.from('account_balance_events').select('id, account_id, old_balance, new_balance, recorded_at').eq('household_id', id).order('recorded_at').order('id')),
  },
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
  balanceEvents: [],
  debts: [],
  independenceIncome: [],
  memberLife: [],
  notes: [],
  assumptions: null,
  errors: {},
  loadedAt: null,
};

export function usePlanningData(householdId) {
  return useSources(householdId, SOURCES, EMPTY_STATE);
}
