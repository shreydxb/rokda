import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/dom';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

const calls = [];
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    rpc: (name, args) => {
      calls.push({ kind: 'rpc', name, args });
      return Promise.resolve({ data: { transaction_id: 'tx-1', already_approved: false }, error: null });
    },
    from: (table) => ({
      insert: (payload) => {
        calls.push({ kind: 'insert', table, payload });
        return Promise.resolve({ error: null });
      },
      update: (payload) => {
        const chain = {
          eq: () => chain,
          then: (resolve) => resolve({ error: null }),
        };
        calls.push({ kind: 'update', table, payload });
        return chain;
      },
    }),
  },
}));

const { default: Inbox } = await import('./Inbox');

const MEMBERS = [{ id: 'm1', display_name: 'Shreyash' }, { id: 'm2', display_name: 'Tarika' }];
const ACCOUNTS = [{ id: 'acc-1', name: 'ENBD Noon', type: 'credit_card', archived_at: null, is_shared: true }];
const ITEM = {
  id: 'intake-1',
  household_id: 'hh',
  status: 'pending',
  source: 'manual',
  raw_text: 'Carrefour 120',
  parsed_amount: 120,
  parsed_merchant: 'Carrefour',
  parsed_category_id: null,
  parsed_date: '2026-09-05',
  confidence: 0.9,
};

// QA-11 / SHR-252: approval inserted a transaction and then separately updated
// the intake row, so a retry duplicated the transaction.
describe('QA-11: Inbox approval goes through one atomic call', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('calls approve_intake once and never inserts a transaction directly', async () => {
    renderScreen(
      <Inbox
        members={MEMBERS}
        accounts={ACCOUNTS}
        categories={[]}
        loading={false}
        data={{ intake: [ITEM], categoryRules: [], reload: vi.fn().mockResolvedValue(undefined) }}
      />,
    );

    await act(async () => {
      screen.getByRole('button', { name: 'Approve' }).click();
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('rpc');
    expect(calls[0].name).toBe('approve_intake');
    expect(calls[0].args).toMatchObject({
      p_intake_id: 'intake-1',
      p_account_id: 'acc-1',
      p_amount: 120,
      p_kind: 'expense',
      p_occurred_at: '2026-09-05',
    });
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
  });

  it('lets the reviewer say it is income rather than forcing an expense', async () => {
    renderScreen(
      <Inbox
        members={MEMBERS}
        accounts={ACCOUNTS}
        categories={[]}
        loading={false}
        data={{ intake: [ITEM], categoryRules: [], reload: vi.fn().mockResolvedValue(undefined) }}
      />,
    );

    await act(async () => {
      screen.getByRole('button', { name: 'Income' }).click();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Tarika' }).click();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Approve' }).click();
    });

    expect(calls[0].args.p_kind).toBe('income');
    expect(calls[0].args.p_is_shared).toBe(false);
    expect(calls[0].args.p_owner_member_id).toBe('m2');
  });
});
