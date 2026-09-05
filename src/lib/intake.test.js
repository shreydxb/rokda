import { describe, it, expect } from 'vitest';
import { approvalArgs, signedAmount, validateApproval } from './intake';

const ITEM = { id: 'intake-1', parsed_amount: 120, parsed_merchant: 'Carrefour' };
const BASE_FORM = {
  accountId: 'acc-1',
  amount: '120',
  date: '2026-09-05',
  kind: 'expense',
  categoryId: 'cat-1',
  currency: 'AED',
  merchant: '  Carrefour  ',
  isShared: true,
  ownerMemberId: null,
};

// QA-11 / SHR-252: approval forced every item to a shared AED expense.
describe('QA-11: the reviewer states what the item is', () => {
  it('signs an expense negative and income positive', () => {
    expect(signedAmount(120, 'expense')).toBe(-120);
    expect(signedAmount(120, 'income')).toBe(120);
    expect(signedAmount(-120, 'income')).toBe(120);
    expect(signedAmount(120, 'refund')).toBe(120);
  });

  it('passes the magnitude to the RPC and lets the kind decide the sign', () => {
    // The database applies the sign, so a reviewer typing "-120" for an
    // expense cannot accidentally record income.
    expect(approvalArgs(ITEM, { ...BASE_FORM, amount: '-120' }).p_amount).toBe(120);
    expect(approvalArgs(ITEM, BASE_FORM).p_kind).toBe('expense');
  });

  it('carries currency, ownership and merchant through explicitly', () => {
    const args = approvalArgs(ITEM, { ...BASE_FORM, currency: 'INR', isShared: false, ownerMemberId: 'm2' });
    expect(args).toMatchObject({
      p_intake_id: 'intake-1',
      p_account_id: 'acc-1',
      p_currency: 'INR',
      p_is_shared: false,
      p_owner_member_id: 'm2',
      p_merchant: 'Carrefour',
      p_occurred_at: '2026-09-05',
    });
  });

  it('drops the owner when the item is shared', () => {
    expect(approvalArgs(ITEM, { ...BASE_FORM, isShared: true, ownerMemberId: 'm2' }).p_owner_member_id).toBeNull();
  });

  it('refuses an approval that is missing something', () => {
    expect(validateApproval(BASE_FORM)).toBeNull();
    expect(validateApproval({ ...BASE_FORM, accountId: '' })).toMatch(/account/i);
    expect(validateApproval({ ...BASE_FORM, amount: '' })).toMatch(/amount/i);
    expect(validateApproval({ ...BASE_FORM, kind: 'transfer' })).toMatch(/expense, income or a refund/i);
    expect(validateApproval({ ...BASE_FORM, isShared: false, ownerMemberId: null })).toMatch(/whose/i);
  });
});

// The contract that approve_intake (20260905183000_intake_atomic_approval.sql)
// implements, encoded here so the intended behaviour is pinned and reviewable.
//
// This models the SQL; it does not execute it. Verifying the function itself
// needs a database to run against, and no isolated one exists yet — see
// docs/environments.md. That limitation is stated in the handoff.
function approveIntakeContract(store, args) {
  const row = store.intake.get(args.p_intake_id);
  if (!row) throw new Error('not found');
  if (row.status === 'approved') return { transaction_id: row.transaction_id, already_approved: true };
  if (row.status === 'rejected') throw new Error('already rejected');
  const id = `tx-${store.transactions.length + 1}`;
  store.transactions.push({ id, amount: signedAmount(args.p_amount, args.p_kind), account_id: args.p_account_id });
  store.intake.set(args.p_intake_id, { ...row, status: 'approved', transaction_id: id });
  return { transaction_id: id, already_approved: false };
}

describe('QA-11: approval happens exactly once', () => {
  const freshStore = () => ({
    intake: new Map([['intake-1', { id: 'intake-1', status: 'pending', transaction_id: null }]]),
    transactions: [],
  });
  const args = approvalArgs(ITEM, BASE_FORM);

  it('yields one transaction when the caller retries', () => {
    const store = freshStore();
    const first = approveIntakeContract(store, args);
    const retry = approveIntakeContract(store, args);
    expect(store.transactions).toHaveLength(1);
    expect(retry.transaction_id).toBe(first.transaction_id);
    expect(retry.already_approved).toBe(true);
  });

  it('yields one transaction when the first response was lost', () => {
    // The caller never saw the result, so it calls again with the same args.
    const store = freshStore();
    approveIntakeContract(store, args);
    const afterLostResponse = approveIntakeContract(store, args);
    expect(store.transactions).toHaveLength(1);
    expect(afterLostResponse.transaction_id).toBe('tx-1');
  });

  it('yields one transaction when two reviewers approve', () => {
    // `for update` serialises them: the second sees an approved row.
    const store = freshStore();
    const a = approveIntakeContract(store, args);
    const b = approveIntakeContract(store, args);
    expect(store.transactions).toHaveLength(1);
    expect(b.transaction_id).toBe(a.transaction_id);
  });

  it('refuses to approve a row someone rejected', () => {
    const store = freshStore();
    store.intake.set('intake-1', { id: 'intake-1', status: 'rejected', transaction_id: null });
    expect(() => approveIntakeContract(store, args)).toThrow(/rejected/);
    expect(store.transactions).toHaveLength(0);
  });
});
