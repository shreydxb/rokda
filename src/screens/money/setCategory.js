import { supabase } from '../../lib/supabaseClient';

// A category chosen for a record that had none, from a list rather than the
// editor: Activity's rows (the revamp, phase 4; review S-activity-4) and
// Month end's tidy step. Only a record still without one is changed, so a
// category set elsewhere meanwhile is never overwritten, and the change goes
// into the record's history as the editor's would (lib/transactionForm.js
// buildEdits). Returns { error } when nothing was saved, { historyError } when
// the category is saved and its history line is not, or {}.
export async function setCategory(tx, category) {
  const { data, error } = await supabase.from('transactions').update({ category_id: category.id }).eq('id', tx.id).is('category_id', null).select('id');
  if (error) return { error: error.message };
  if ((data?.length ?? 0) !== 1) return { error: 'This record was changed elsewhere, so its category wasn’t set. Refresh to see it as it is now.' };
  const { error: historyError } = await supabase
    .from('transaction_edits')
    .insert([{ transaction_id: tx.id, field: 'category', old_value: 'Uncategorised', new_value: category.name }]);
  return historyError ? { historyError: historyError.message } : {};
}
