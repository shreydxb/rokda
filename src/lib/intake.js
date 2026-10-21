// Intake approval (QA-11, SHR-252).
//
// Approval used to force every item to a shared, AED, expense — the reviewer
// could not say otherwise. The kind is now explicit, and the sign follows from
// it rather than being inferred from whatever the reviewer typed.

export const INTAKE_KINDS = [
  { id: 'expense', label: 'Expense', hint: 'Money left the account' },
  { id: 'income', label: 'Income', hint: 'Money arrived' },
  { id: 'refund', label: 'Refund', hint: 'Money came back on an earlier expense' },
];

// Where an Inbox item came from, as said on screen. A manual row has no
// member, so the queue used to fall back to the raw value "manual".
export const INTAKE_SOURCE_LABELS = { telegram: 'Telegram', manual: 'Added by hand' };

export function signedAmount(amount, kind) {
  const magnitude = Math.abs(Number(amount) || 0);
  return kind === 'expense' ? -magnitude : magnitude;
}

export function validateApproval(form) {
  if (!form.accountId) return 'Choose the account this belongs to.';
  if (!form.amount || Number(form.amount) === 0) return 'Enter an amount.';
  if (!form.date) return 'Enter a date.';
  // A bank SMS or receipt with no date is dated the day it was sent to the
  // bot. That becomes the day it was paid only once someone has picked a date
  // or said the one shown is right; approve_intake refuses it otherwise.
  if (form.dateGuessed && !form.dateConfirmed) return 'The message had no date, so set the day it was paid, or tick “Paid on this day” if the date shown is right.';
  if (!INTAKE_KINDS.some((k) => k.id === form.kind)) return 'Choose whether this is an expense, income or a refund.';
  if (!form.isShared && !form.ownerMemberId) return 'Choose whose it is, or mark it shared.';
  // Every total reads amount as AED, so an entry in another currency needs
  // its own-currency figure as well as the AED, never one passed off as the
  // other (SHR-252, SHR-321). `amount` is then the AED: debited, or estimated.
  if ((form.currency || 'AED').toUpperCase() !== 'AED' && !(Math.abs(Number(form.nativeAmount)) > 0)) {
    return `Enter the amount in ${form.currency.toUpperCase()} as well as the AED.`;
  }
  return null;
}

// Arguments for the approve_intake RPC. One call, one transaction — the
// insert and the status update used to be separate round trips, so a failure
// or retry between them duplicated the transaction.
export function approvalArgs(item, form) {
  return {
    p_intake_id: item.id,
    p_account_id: form.accountId,
    p_amount: Math.abs(Number(form.amount) || 0),
    p_occurred_at: form.date,
    p_kind: form.kind,
    p_category_id: form.categoryId || null,
    p_currency: form.currency || 'AED',
    p_merchant: form.merchant?.trim() || null,
    p_is_shared: Boolean(form.isShared),
    p_owner_member_id: form.isShared ? null : (form.ownerMemberId ?? null),
    // True only when a person picked the date, or ticked that the one shown
    // is right, in the editor. Approving as read, singly or in bulk, never
    // says so, and the database checks its own copy of the entry, so a screen
    // showing an older copy cannot approve a guess past it.
    p_date_confirmed: form.dateConfirmed === true,
    // Only for a payment in another currency: the amount in it, and whether
    // the AED above is an estimate. An AED entry sends neither.
    ...((form.currency || 'AED').toUpperCase() !== 'AED'
      ? { p_native_amount: Math.abs(Number(form.nativeAmount) || 0), p_aed_estimated: form.aedEstimated === true }
      : {}),
  };
}
