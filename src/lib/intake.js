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

export function signedAmount(amount, kind) {
  const magnitude = Math.abs(Number(amount) || 0);
  return kind === 'expense' ? -magnitude : magnitude;
}

export function validateApproval(form) {
  if (!form.accountId) return 'Choose the account this belongs to.';
  if (!form.amount || Number(form.amount) === 0) return 'Enter an amount.';
  if (!form.date) return 'Enter a date.';
  if (!INTAKE_KINDS.some((k) => k.id === form.kind)) return 'Choose whether this is an expense, income or a refund.';
  if (!form.isShared && !form.ownerMemberId) return 'Choose whose it is, or mark it shared.';
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
  };
}
