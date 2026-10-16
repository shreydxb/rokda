import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/dom';
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

const MEMBERS = [{ id: 'm1', display_name: 'Partner A' }, { id: 'm2', display_name: 'Partner B' }];
const ACCOUNTS = [{ id: 'acc-1', name: 'Bank card', type: 'credit_card', archived_at: null, is_shared: true }];
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

    // The fixture has no parsed_account_id, so the review panel's direct
    // Approve is unavailable (nothing to approve onto) -- same as a real
    // ambiguous-account intake row, this needs the edit form to pick one.
    await act(async () => {
      screen.getByRole('button', { name: 'Edit first' }).click();
    });
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

  it('remembers "both are real" against the record it was said about, once approved', async () => {
    const earlier = { id: 'old', account_id: 'acc-1', merchant: 'Carrefour', amount: -120, kind: 'expense', occurred_at: '2026-09-04' };
    renderScreen(
      <Inbox
        members={MEMBERS}
        accounts={ACCOUNTS}
        categories={[]}
        loading={false}
        data={{ intake: [ITEM], transactions: [earlier], categoryRules: [], reload: vi.fn().mockResolvedValue(undefined) }}
      />,
    );
    await act(async () => {
      screen.getByRole('button', { name: 'Edit first' }).click();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Both are real' }).click();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Approve' }).click();
    });
    expect(calls.map((c) => c.kind)).toEqual(['rpc', 'insert']);
    expect(calls[1]).toEqual({ kind: 'insert', table: 'transaction_links', payload: { household_id: 'hh', kind: 'duplicate_confirmed', from_transaction_id: 'old', to_transaction_id: 'tx-1' } });
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
      screen.getByRole('button', { name: 'Edit first' }).click();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Income' }).click();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Partner B' }).click();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Approve' }).click();
    });

    expect(calls[0].args.p_kind).toBe('income');
    expect(calls[0].args.p_is_shared).toBe(false);
    expect(calls[0].args.p_owner_member_id).toBe('m2');
  });

  // SHR-282: Telegram's own parser can classify a message as income/refund
  // now, and that classification must not be silently discarded the moment
  // a human opens the review form -- the whole point is to save the reviewer
  // from having to notice and re-select something the parser already knew.
  it('pre-fills the kind selector from the parser\'s own classification instead of always starting at Expense', async () => {
    const parsedAsIncome = { ...ITEM, parsed_kind: 'income' };
    renderScreen(
      <Inbox
        members={MEMBERS}
        accounts={ACCOUNTS}
        categories={[]}
        loading={false}
        data={{ intake: [parsedAsIncome], categoryRules: [], reload: vi.fn().mockResolvedValue(undefined) }}
      />,
    );

    await act(async () => {
      screen.getByRole('button', { name: 'Edit first' }).click();
    });
    // No click on "Income" here -- it should already be the active choice.
    await act(async () => {
      screen.getByRole('button', { name: 'Approve' }).click();
    });

    expect(calls[0].args.p_kind).toBe('income');
  });
});

// SHR-310: a bank SMS with no date is dated the day it was sent to the bot.
// The Inbox must say so, and must not approve it as read.
describe('SHR-310: a guessed date is checked before approval', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  const GUESSED = { ...ITEM, parsed_account_id: 'acc-1', parsed_category_id: 'cat-1', date_guessed: true, confidence: 1 };
  const renderGuessed = () =>
    renderScreen(
      <Inbox
        members={MEMBERS}
        accounts={ACCOUNTS}
        categories={[{ id: 'cat-1', name: 'Groceries', kind: 'expense' }]}
        loading={false}
        data={{ intake: [GUESSED], categoryRules: [], reload: vi.fn().mockResolvedValue(undefined) }}
      />,
    );

  it('flags the date as not in the message', () => {
    renderGuessed();
    expect(screen.getByText('Not in the message; check it')).toBeTruthy();
    expect(screen.getByText('Check the flagged rows')).toBeTruthy();
  });

  it('opens the editor instead of approving the guessed date', async () => {
    renderGuessed();
    await act(async () => {
      screen.getByRole('button', { name: 'Approve' }).click();
    });
    expect(calls.filter((c) => c.kind === 'rpc')).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toMatch(/had no date/);
  });

  it('marks each undated entry in the queue and counts them', () => {
    renderGuessed();
    const row = document.querySelector('.ib-queue-row');
    expect(row.textContent).toMatch(/No date/);
    expect(screen.getByText(/1 waiting · 0 read cleanly · 1 with no date/)).toBeTruthy();
  });

  it('approves with the date picked in the editor, marked as confirmed', async () => {
    renderGuessed();
    await act(async () => {
      screen.getByRole('button', { name: 'Edit first' }).click();
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-09-01' } });
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Approve' }).click();
    });
    const rpc = calls.filter((c) => c.kind === 'rpc');
    expect(rpc).toHaveLength(1);
    expect(rpc[0].args).toMatchObject({ p_intake_id: 'intake-1', p_occurred_at: '2026-09-01', p_date_confirmed: true });
  });

  it('keeps the date shown only once it is ticked as the day it was paid', async () => {
    renderGuessed();
    await act(async () => {
      screen.getByRole('button', { name: 'Edit first' }).click();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Approve' }).click();
    });
    expect(calls.filter((c) => c.kind === 'rpc')).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toMatch(/had no date/);

    await act(async () => {
      screen.getByLabelText('Paid on this day').click();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Approve' }).click();
    });
    const rpc = calls.filter((c) => c.kind === 'rpc');
    expect(rpc).toHaveLength(1);
    expect(rpc[0].args).toMatchObject({ p_occurred_at: '2026-09-05', p_date_confirmed: true });
  });

  // The database checks its own copy of the entry. A dated entry approved
  // from the editor with its date untouched says nothing was confirmed, so a
  // correction that made the date a guess since this screen loaded still
  // stops the approval there.
  it('does not claim a confirmation for a dated entry nobody re-dated', async () => {
    renderScreen(
      <Inbox
        members={MEMBERS}
        accounts={ACCOUNTS}
        categories={[]}
        loading={false}
        data={{ intake: [ITEM], categoryRules: [], reload: vi.fn().mockResolvedValue(undefined) }}
      />,
    );
    expect(screen.queryByText(/with no date/)).toBeNull();
    await act(async () => {
      screen.getByRole('button', { name: 'Edit first' }).click();
    });
    expect(screen.queryByLabelText('Paid on this day')).toBeNull();
    await act(async () => {
      screen.getByRole('button', { name: 'Approve' }).click();
    });
    const rpc = calls.filter((c) => c.kind === 'rpc');
    expect(rpc).toHaveLength(1);
    expect(rpc[0].args).toMatchObject({ p_occurred_at: '2026-09-05', p_date_confirmed: false });
  });

  it('leaves undated entries out of bulk approval', async () => {
    const CONFIDENT = { ...ITEM, id: 'intake-2', parsed_account_id: 'acc-1', parsed_category_id: 'cat-1', confidence: 0.9 };
    renderScreen(
      <Inbox
        members={MEMBERS}
        accounts={ACCOUNTS}
        categories={[{ id: 'cat-1', name: 'Groceries', kind: 'expense' }]}
        loading={false}
        data={{ intake: [GUESSED, CONFIDENT], categoryRules: [], reload: vi.fn().mockResolvedValue(undefined) }}
      />,
    );
    await act(async () => {
      screen.getByRole('button', { name: 'Approve 1 confident' }).click();
    });
    const rpc = calls.filter((c) => c.kind === 'rpc');
    expect(rpc).toHaveLength(1);
    expect(rpc[0].args).toMatchObject({ p_intake_id: 'intake-2', p_date_confirmed: false });
  });
});
