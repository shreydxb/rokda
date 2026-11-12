import { supabase } from '../../lib/supabaseClient';
import { confirmedPairRow } from '../../lib/duplicates';

// The database steps of saving one record from the transaction editor, in
// order (moved out of TransactionEditor.jsx, the round 2 cleanup, SHR-383).
// The editor checks the form first, and handles what comes after: the
// merchant rule, and what the person is told.
//
// Returns { error } when a step failed and nothing after it ran;
// { historyError } when the record is saved but its edit history is not;
// or {} once every step is done.
//
// `memory` lasts as long as the editor: a new record saved before a step
// after it failed (its split, its link to the purchase, "both are real") is
// not inserted again, as it once was (outside review, E-02). A retry writes
// the form as it now stands to that record, so what was changed since is
// saved (the fresh review of group 4), then runs the steps not yet done. The
// split replaces its lines, so it is safe to run again; linking the refund
// is not, and runs once.
export async function saveTransaction(
  { tx, householdId, payload, lines, amountAed, unlinkId, unsplit, linkTo, keptAlongside, edits },
  memory,
) {
  // A linked refund stops being one only once it is unlinked from its
  // purchase; the database refuses the change otherwise.
  if (unlinkId) {
    const { error } = await supabase.rpc('unlink_refund', { p_link_id: unlinkId });
    if (error) return { error: error.message };
  }

  // Was split and no longer is: one category again first, so the update
  // below can set it.
  if (unsplit) {
    const { error } = await supabase.rpc('unsplit_transaction', { p_transaction_id: tx.id, p_category_id: payload.category_id });
    if (error) return { error: error.message };
  }

  const splitting = lines != null;
  const savedBefore = !tx ? memory.savedNewId : null;
  let inserted;
  if (savedBefore) {
    const { data: rewritten, error } = await supabase.from('transactions').update(payload).eq('id', savedBefore).select('id');
    if (error) return { error: error.message };
    if ((rewritten?.length ?? 0) !== 1) return { error: "This record wasn't saved: it may have been deleted elsewhere. Close it, refresh, and open it again." };
    inserted = { id: savedBefore };
  } else {
    const query = tx
      ? supabase.from('transactions').update(payload).eq('id', tx.id).select('id')
      : splitting || linkTo || keptAlongside
        ? supabase.from('transactions').insert(payload).select('id').single()
        : supabase.from('transactions').insert(payload);
    const { data, error } = await query;
    if (error) return { error: error.message };
    inserted = data;
    if (!tx && inserted?.id) memory.savedNewId = inserted.id;
  }
  // An update that changed no row was not a save: the record was deleted
  // elsewhere, or the change wasn't allowed. Nothing after it (the split,
  // the history) runs, and the editor stays open (QA re-review, 17 October).
  if (tx && (inserted?.length ?? 0) !== 1) {
    return { error: "This record wasn't saved: it may have been deleted or changed elsewhere. Close it, refresh, and open it again." };
  }
  // A plain new record is inserted without reading it back, so it has no id
  // here; only the steps after a split, a link or "both are real" need one.
  const id = tx ? tx.id : inserted?.id;

  if (splitting) {
    const { error } = await supabase.rpc('split_transaction', { p_transaction_id: id, p_lines: lines, p_amount: amountAed });
    if (error) return { error: tx ? error.message : `Saved, but not split: ${error.message}. Press Add transaction to try the split again; the record itself is saved.` };
  }

  if (linkTo && !memory.stepsDone.has('link')) {
    const { error } = await supabase.rpc('link_refund', { p_purchase_id: linkTo, p_refund_id: id });
    if (error) {
      return { error: tx ? error.message : `Saved, but not linked to the purchase: ${error.message}. Press Add transaction to try linking it again; the record itself is saved.` };
    }
  }
  if (linkTo && !tx) memory.stepsDone.add('link');

  if (!tx && keptAlongside && !memory.stepsDone.has('pair')) {
    const { error } = await supabase.from('transaction_links').insert(confirmedPairRow(householdId, { id }, keptAlongside));
    if (error) return { error: `Saved, but "both are real" wasn't remembered: ${error.message}. The monthly review will ask about the pair again.` };
  }

  if (tx && edits.length > 0) {
    const { error } = await supabase.from('transaction_edits').insert(
      edits.map((c) => ({ transaction_id: tx.id, field: c.field, old_value: c.old_value, new_value: c.new_value })),
    );
    if (error) return { historyError: error.message };
  }
  return {};
}
