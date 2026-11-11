// The transaction editor's form, as data: what it opens with, what its amount
// counts as in AED, the row a save writes, and the history an edit records.
// Moved out of screens/money/TransactionEditor.jsx (the round 2 cleanup,
// SHR-383); its database steps are in screens/money/saveTransaction.js.
import { formatSigned } from './money';
import { signedAmount } from './intake';
import { estimateAed } from './fxHistory';
import { householdToday, parseDay } from './day';

const KIND_LABELS = { expense: 'Expense', income: 'Income', refund: 'Refund' };

// Whether a saved record was made in another currency.
export const foreignOf = (tx) => !!tx && tx.native_amount != null && !!tx.currency && tx.currency !== 'AED';
export const signedNative = (n, type) => (n == null ? null : type === 'expense' ? -Math.abs(n) : Math.abs(n));

export function initialForm(tx, accounts) {
  if (tx) {
    return {
      // A refund is stored positive, like income, but is neither — its own
      // persisted `kind` is what says which it is (SHR-252). Falling back to
      // sign only covers a row from before `kind` existed.
      type: tx.kind ?? (Number(tx.amount) >= 0 ? 'income' : 'expense'),
      amount: String(Math.abs(Number(tx.amount))),
      merchant: tx.merchant ?? '',
      occurred_at: tx.occurred_at,
      account_id: tx.account_id ?? '',
      category_id: tx.category_id ?? '',
      owner: tx.is_shared ? 'shared' : (tx.owner_member_id ?? ''),
      note: tx.note ?? '',
      needs_review: !!tx.needs_review,
      // A payment in another currency opens in that currency, with the AED
      // debited beside it, or blank while the AED is still an estimate
      // (docs/decisions.md, "A payment in rupees keeps both amounts").
      ...(foreignOf(tx)
        ? { entry_currency: tx.currency, amount: String(Math.abs(Number(tx.native_amount))), aed_debited: tx.aed_estimated ? '' : String(Math.abs(Number(tx.amount))) }
        : { entry_currency: 'AED', aed_debited: '' }),
    };
  }
  return {
    type: 'expense',
    amount: '',
    merchant: '',
    occurred_at: householdToday(),
    account_id: accounts[0]?.id ?? '',
    category_id: '',
    owner: 'shared',
    note: '',
    needs_review: false,
    entry_currency: 'AED',
    aed_debited: '',
  };
}

// In another currency, `amount` is what was paid in it, and the AED that
// counts is the AED debited when it is known, otherwise an estimate at the
// payment date's rate (lib/fxHistory.js), marked as one.
export function amountFigures(form, fxHistory, inrPerAed) {
  const foreign = form.entry_currency !== 'AED';
  const typed = Number(form.amount) || 0;
  const debited = foreign && form.aed_debited.trim() !== '' ? Number(form.aed_debited) : null;
  const estimate = foreign ? estimateAed(typed, form.entry_currency, form.occurred_at, fxHistory, inrPerAed) : null;
  const aedEstimated = foreign && debited == null;
  const amountAed = !foreign ? typed : debited != null ? debited : (estimate?.aed ?? null);
  const amountError =
    form.amount.trim() === '' || Number(form.amount) <= 0
      ? 'Enter an amount greater than zero.'
      : debited != null && !(debited > 0)
        ? 'Enter the AED debited as an amount greater than zero, or leave it blank to estimate it.'
        : amountAed === null
          ? `No exchange rate for ${form.entry_currency} on that date. Enter the AED debited.`
          : '';
  return { foreign, typed, debited, estimate, aedEstimated, amountAed, amountError };
}

// Which rate an estimate used, in words: "1 AED = 23.5 INR, the rate on
// 2 Sept 2026", the dollar peg, or today's rate when history has nothing for
// the date.
export function estimateNote(estimate, currency) {
  if (estimate.source === 'peg') return 'the dollar peg (1 USD = 3.6725 AED)';
  const rate = `1 AED = ${estimate.rate.toLocaleString('en-IN', { maximumFractionDigits: 4 })} ${currency}`;
  if (estimate.source === 'current') return `today's rate, ${rate}, as none is on record for that date`;
  return `${rate}, the rate on ${parseDay(estimate.rateDay).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

// The row a save writes. A split's amount and categories are set with its
// lines, in one call after this one, so the database never sees a total its
// lines don't add up to; a linked refund's category follows its purchase's
// (refund_integrity), so none is sent.
export function transactionPayload(form, { amountAed, typed, foreign, aedEstimated }, { householdId, splitting = false, editing = false, followsPurchase = false }) {
  const payload = {
    household_id: householdId,
    account_id: form.account_id,
    category_id: form.category_id || null,
    amount: signedAmount(amountAed, form.type),
    kind: form.type,
    currency: form.entry_currency,
    native_amount: foreign ? signedNative(typed, form.type) : null,
    aed_estimated: aedEstimated,
    merchant: form.merchant.trim() || null,
    note: form.note.trim() || null,
    occurred_at: form.occurred_at,
    is_shared: form.owner === 'shared',
    owner_member_id: form.owner === 'shared' ? null : form.owner,
    needs_review: form.needs_review,
  };
  if (splitting) {
    payload.category_id = null;
    if (editing) delete payload.amount;
  }
  if (followsPurchase) delete payload.category_id;
  return payload;
}

// Diffs the form against the record as it was loaded, one entry per
// changed field the acceptance criteria calls out. Only meaningful for an
// edit — there's nothing to diff against on a create. `savedAmount` is the
// signed amount the save writes, so the history compares like with like: a
// refund is stored positive, and diffing it as a negative recorded "+75 →
// −75" on a save that changed nothing (QA, 15 Oct).
export function buildEdits(tx, form, savedAmount, { accounts, categories, members, splitChanging = false, savedNative = { currency: 'AED', amount: null } }) {
  const accountName = (id) => accounts.find((a) => a.id === id)?.name ?? 'Unknown account';
  const categoryName = (id) => (id ? (categories.find((c) => c.id === id)?.name ?? 'Unknown category') : 'Uncategorised');
  const scopeLabel = (isShared, ownerId) => (isShared ? 'Shared' : (members.find((m) => m.id === ownerId)?.display_name ?? 'Unknown member'));

  const changes = [];

  // A refund turned into income keeps its sign and amount, so only its type
  // says it changed.
  const oldKind = tx.kind ?? (Number(tx.amount) >= 0 ? 'income' : 'expense');
  if (oldKind !== form.type) {
    changes.push({ field: 'kind', old_value: KIND_LABELS[oldKind] ?? oldKind, new_value: KIND_LABELS[form.type] ?? form.type });
  }

  // Splitting or unsplitting records its own category change (in the
  // database function that does it), so it isn't recorded twice here.
  const oldCategoryId = tx.category_id ?? null;
  const newCategoryId = form.category_id || null;
  if (!splitChanging && oldCategoryId !== newCategoryId) {
    changes.push({ field: 'category', old_value: categoryName(oldCategoryId), new_value: categoryName(newCategoryId) });
  }

  const oldAmount = Number(tx.amount);
  const newAmount = Number(savedAmount);
  if (Math.abs(oldAmount - newAmount) > 0.001) {
    changes.push({ field: 'amount', old_value: formatSigned(oldAmount), new_value: formatSigned(newAmount) });
  }

  // The amount in the currency it was paid in, when that is not AED.
  const paid = (currency, amount) => (amount == null ? 'AED only' : `${currency} ${formatSigned(amount, { decimals: 2 })}`);
  const oldPaid = paid(tx.currency, foreignOf(tx) ? Number(tx.native_amount) : null);
  const newPaid = paid(savedNative.currency, savedNative.amount);
  if (oldPaid !== newPaid) changes.push({ field: 'native_amount', old_value: oldPaid, new_value: newPaid });

  if (tx.occurred_at !== form.occurred_at) {
    const day = (d) => parseDay(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    changes.push({ field: 'date', old_value: day(tx.occurred_at), new_value: day(form.occurred_at) });
  }

  if (tx.account_id !== form.account_id) {
    changes.push({ field: 'account', old_value: accountName(tx.account_id), new_value: accountName(form.account_id) });
  }

  const oldMerchant = (tx.merchant ?? '').trim();
  const newMerchant = form.merchant.trim();
  if (oldMerchant !== newMerchant) {
    changes.push({ field: 'merchant', old_value: oldMerchant || '(none)', new_value: newMerchant || '(none)' });
  }

  const oldShared = tx.is_shared;
  const oldOwner = tx.owner_member_id ?? null;
  const newShared = form.owner === 'shared';
  const newOwner = newShared ? null : form.owner;
  if (oldShared !== newShared || oldOwner !== newOwner) {
    changes.push({ field: 'scope', old_value: scopeLabel(oldShared, oldOwner), new_value: scopeLabel(newShared, newOwner) });
  }

  return changes;
}
