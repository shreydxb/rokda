import { supabase } from '../../lib/supabaseClient';

// A month's limit typed in place on Budget (the revamp, phase 4b;
// design/prototype bud-limit). Changes that one month's budget, as the
// editor's "This month" does; the editor is still where a budget is set for
// the whole year or deleted. Returns { error } when nothing was saved.
export async function setBudgetLimit(budget, amount) {
  const { data, error } = await supabase.from('budgets').update({ amount }).eq('id', budget.id).select('id');
  if (error) return { error: error.message };
  if ((data?.length ?? 0) !== 1) return { error: 'This budget was changed elsewhere, so its limit wasn’t saved. Refresh to see it as it is now.' };
  return {};
}
