import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/dom';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

const calls = [];
const stored = { rules: [] };
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    rpc: (name, args) => {
      calls.push({ kind: 'rpc', name, args });
      return Promise.resolve({ data: { transaction_id: 'tx-1', already_approved: false }, error: null });
    },
    from: (table) => ({
      insert: (payload) => {
        calls.push({ kind: 'insert', table, payload });
        const done = Promise.resolve({ error: null });
        done.select = () => ({ single: () => Promise.resolve({ data: { id: 'rule-1' }, error: null }) });
        return done;
      },
      // The household's rules, read again just before one is added.
      select: () => ({ eq: () => ({ order: () => ({ order: () => Promise.resolve({ data: stored.rules, error: null }) }) }) }),
      update: (payload) => {
        const call = { kind: 'update', table, payload };
        const chain = {
          // The filters an update is made under, for a test to check.
          eq: (column, value) => {
            call.where = { ...call.where, [column]: value };
            return chain;
          },
          then: (resolve) => resolve({ error: null }),
        };
        calls.push(call);
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

// "Nothing to bulk-approve" was a disabled button standing in for a sentence,
// and an entry added by hand read "manual" in the queue and "via Telegram"
// under the message (layout audit, 21 Oct).
describe('Inbox: what it offers and where an entry came from', () => {
  const render = (intake) =>
    renderScreen(<Inbox members={MEMBERS} accounts={ACCOUNTS} categories={[]} loading={false} data={{ intake, categoryRules: [], reload: vi.fn() }} />);

  it('offers bulk approval only when something read cleanly, and the count says why not', () => {
    render([ITEM]);
    expect(screen.queryByRole('button', { name: /Approve \d+ confident|bulk-approve/ })).toBeNull();
    expect(screen.getByText(/1 waiting · 0 read cleanly/)).toBeTruthy();
  });

  it('names an entry added by hand as that, not as its stored source or as Telegram', () => {
    render([{ ...ITEM, member_id: null }]);
    expect(screen.getByText(/^Added by hand · /)).toBeTruthy();
    expect(screen.queryByText(/via Telegram/)).toBeNull();
    expect(screen.getByText(/added by hand$/)).toBeTruthy();
    expect(screen.getByText('5 Sept 2026')).toBeTruthy();
  });
});

// Round 2 of the outside review, E2-3: an inbox that never loaded is not an
// empty one. It read "Inbox zero", so captures waiting on review were missed.
describe('Inbox: an inbox that never loaded', () => {
  it('says it could not load instead of "Inbox zero", and offers to try again', () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    renderScreen(
      <Inbox members={MEMBERS} accounts={ACCOUNTS} categories={[]} loading={false} data={{ intake: [], categoryRules: [], transactions: [], errors: { intake: 'network' }, loaded: {}, reload }} />,
    );
    expect(screen.getByText('Couldn’t load the inbox.')).toBeTruthy();
    expect(screen.queryByText('Inbox zero')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reload).toHaveBeenCalled();
  });
});

// Rules were offered only when a saved record was moved to another category,
// which nobody did: with 78 merchants seen three times or more, the household
// had no rule (the feature review, November 2026). The Inbox is where a
// category is chosen, so it is offered there.
describe('Inbox: remembering a merchant while approving', () => {
  const FOOD = { id: 'food', name: 'Groceries', kind: 'expense', archived: false, is_savings: false };
  const render = (rules = []) => {
    stored.rules = rules;
    renderScreen(
      <Inbox members={MEMBERS} accounts={ACCOUNTS} categories={[FOOD]} loading={false} data={{ intake: [ITEM], categoryRules: rules, transactions: [], reload: vi.fn().mockResolvedValue(undefined) }} />,
    );
    return act(async () => {
      screen.getByRole('button', { name: 'Edit first' }).click();
    });
  };
  beforeEach(() => {
    calls.length = 0;
  });

  it('offers it, unticked, once a category is chosen, and adds the rule after the approval', async () => {
    await render();
    expect(screen.queryByLabelText(/Remember this merchant/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Groceries' }));
    const tick = screen.getByLabelText(/Remember this merchant/);
    expect(tick.checked).toBe(false);
    fireEvent.click(tick);
    expect(screen.getByLabelText('Merchant pattern').value).toBe('Carrefour');
    await act(async () => {
      screen.getByRole('button', { name: 'Approve and add rule' }).click();
    });
    expect(calls.map((c) => c.kind)).toEqual(['rpc', 'insert']);
    expect(calls[1]).toEqual({ kind: 'insert', table: 'category_rules', payload: { household_id: 'hh', pattern: 'Carrefour', match_type: 'contains', category_id: 'food' } });
  });

  it('adds nothing unless it is ticked', async () => {
    await render();
    fireEvent.click(screen.getByRole('button', { name: 'Groceries' }));
    await act(async () => {
      screen.getByRole('button', { name: 'Approve' }).click();
    });
    expect(calls.map((c) => c.kind)).toEqual(['rpc']);
  });

  it('is not offered for a merchant a rule already covers', async () => {
    await render([{ id: 'r1', pattern: 'carrefour', match_type: 'contains', category_id: 'food', archived: false }]);
    expect(screen.queryByLabelText(/Remember this merchant/)).toBeNull();
  });

  it('is not offered for income', async () => {
    await render();
    fireEvent.click(screen.getByRole('button', { name: 'Groceries' }));
    expect(screen.getByLabelText(/Remember this merchant/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Income' }));
    expect(screen.queryByLabelText(/Remember this merchant/)).toBeNull();
  });

  // The entry is approved by then, so nothing more can be done to it here:
  // Approve and Reject go, and Done closes it (the fresh review).
  it('says when the rule could not be added, and leaves only Done on the approved entry', async () => {
    await render();
    stored.rules = [{ id: 'r9', pattern: 'carre', match_type: 'contains', category_id: 'other', archived: false }];
    fireEvent.click(screen.getByRole('button', { name: 'Groceries' }));
    fireEvent.click(screen.getByLabelText(/Remember this merchant/));
    await act(async () => {
      screen.getByRole('button', { name: 'Approve and add rule' }).click();
    });
    expect(calls.map((c) => c.kind)).toEqual(['rpc']);
    expect(screen.getByText(/Approved, but the merchant rule wasn’t added: Contains “carre” already files this merchant/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  it('refuses a pattern that would not match the merchant, before approving anything', async () => {
    await render();
    fireEvent.click(screen.getByRole('button', { name: 'Groceries' }));
    fireEvent.click(screen.getByLabelText(/Remember this merchant/));
    fireEvent.change(screen.getByLabelText('Merchant pattern'), { target: { value: 'Lulu' } });
    await act(async () => {
      screen.getByRole('button', { name: /^Approve/ }).click();
    });
    expect(calls).toEqual([]);
    // Said beside the pattern, and again by the button that was pressed.
    expect(screen.getAllByRole('alert').every((el) => /doesn’t contain “Lulu”/.test(el.textContent))).toBe(true);
  });
});

// Bank SMS pasted a week's worth at a time carry no dates, so each entry
// waited for its own: 19 of 55 approvals (the feature review, November 2026).
// One date, said once by a person, now covers the entries of one message.
describe('Inbox: one date for the undated entries of one message', () => {
  const batchItem = (id, ref, over = {}) => ({ ...ITEM, id, source: 'telegram', source_ref: ref, parsed_account_id: 'acc-1', parsed_category_id: 'cat-1', parsed_date: '2026-10-04', date_guessed: true, confidence: 1, ...over });
  const render = (items) =>
    renderScreen(
      <Inbox members={MEMBERS} accounts={ACCOUNTS} categories={[{ id: 'cat-1', name: 'Groceries', kind: 'expense' }]} loading={false} data={{ intake: items, categoryRules: [], transactions: [], reload: vi.fn().mockResolvedValue(undefined) }} />,
    );
  beforeEach(() => {
    calls.length = 0;
  });

  it('approves them on the date given, each marked as confirmed by a person', async () => {
    render([batchItem('i1', '500'), batchItem('i2', '500#1'), batchItem('other', '501')]);
    expect(screen.getByText(/2 entries from one message, sent 4 Oct, have no date/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Paid on, for these 2 entries'), { target: { value: '2026-10-02' } });
    await act(async () => {
      screen.getByRole('button', { name: 'Approve 2 on this date' }).click();
    });
    const rpcs = calls.filter((c) => c.kind === 'rpc');
    expect(rpcs.map((c) => [c.args.p_intake_id, c.args.p_occurred_at, c.args.p_date_confirmed])).toEqual([['i1', '2026-10-02', true], ['i2', '2026-10-02', true]]);
  });

  it('asks for the date first: nothing is approved on the day the message was sent unless that day is chosen', () => {
    render([batchItem('i1', '500'), batchItem('i2', '500#1')]);
    expect(screen.getByLabelText('Paid on, for these 2 entries').value).toBe('');
    expect(screen.getByRole('button', { name: 'Approve 2 on this date' }).disabled).toBe(true);
  });

  it('takes no day that has not come yet', () => {
    render([batchItem('i1', '500'), batchItem('i2', '500#1')]);
    fireEvent.change(screen.getByLabelText('Paid on, for these 2 entries'), { target: { value: '2999-01-01' } });
    expect(screen.getByRole('button', { name: 'Approve 2 on this date' }).disabled).toBe(true);
  });

  it('is not offered for a single undated entry', () => {
    render([batchItem('i1', '500')]);
    expect(screen.queryByText(/have no date/)).toBeNull();
  });
});

// A paste a week after the first repeated 14 entries already recorded, and
// each was rejected by hand (the feature review, November 2026).
describe('Inbox: undated entries already recorded', () => {
  const pasted = (id, ref, merchant, amount) => ({ ...ITEM, id, source: 'telegram', source_ref: ref, parsed_merchant: merchant, parsed_amount: amount, parsed_account_id: 'acc-1', parsed_category_id: 'cat-1', parsed_date: '2026-10-04', date_guessed: true, confidence: 1 });
  const recorded = { id: 'tx-old', account_id: 'acc-1', merchant: 'CITY TAXI, DUBAI', amount: -20, occurred_at: '2026-09-27', kind: 'expense' };
  const render = (items) =>
    renderScreen(
      <Inbox members={MEMBERS} accounts={ACCOUNTS} categories={[{ id: 'cat-1', name: 'Transport', kind: 'expense' }]} loading={false} data={{ intake: items, categoryRules: [], transactions: [recorded], reload: vi.fn().mockResolvedValue(undefined) }} />,
    );
  beforeEach(() => {
    calls.length = 0;
  });

  it('marks it, names the record it repeats, and leaves it out of the batch date', () => {
    render([pasted('dup', '700', 'CITY TAXI', 20), pasted('new1', '700#1', 'Lulu', 50), pasted('new2', '700#2', 'Careem', 30)]);
    const dupRow = [...document.querySelectorAll('.ib-queue-row')].find((r) => r.textContent.includes('CITY TAXI'));
    expect(dupRow.textContent).toMatch(/Recorded/);
    fireEvent.click(dupRow);
    expect(screen.getByText(/Looks already recorded: CITY TAXI, DUBAI, AED 20.00 on 27 Sep/)).toBeTruthy();
    expect(screen.getByText(/2 entries from one message, sent 4 Oct, have no date/)).toBeTruthy();
    expect(screen.getByText(/1 more looks already recorded and is left out/)).toBeTruthy();
  });

  it('sets them all aside at once, each only if still waiting', async () => {
    render([pasted('dup', '700', 'CITY TAXI', 20), pasted('new1', '700#1', 'Lulu', 50)]);
    await act(async () => {
      screen.getByRole('button', { name: 'Set aside 1 already recorded' }).click();
    });
    expect(calls).toEqual([{ kind: 'update', table: 'intake', payload: { status: 'rejected' }, where: { id: 'dup', status: 'pending' } }]);
  });
});


// The feature review (November 2026): a group picked where a subcategory was
// meant was half the categories changed on approval.
describe('the editor offers subcategories, not the groups they are in', () => {
  const TREE = [
    { id: 'food', name: 'Food & Dining', kind: 'expense', parent_id: null },
    { id: 'out', name: 'Eating Out', kind: 'expense', parent_id: 'food' },
    { id: 'shop', name: 'Shopping', kind: 'expense', parent_id: null },
  ];

  it('lists Food & Dining › Eating Out and Shopping, never Food & Dining alone', async () => {
    renderScreen(<Inbox members={MEMBERS} accounts={ACCOUNTS} categories={TREE} loading={false} data={{ intake: [ITEM], categoryRules: [], reload: vi.fn() }} />);
    await act(async () => {
      screen.getByRole('button', { name: 'Edit first' }).click();
    });
    expect(screen.getByRole('button', { name: 'Food & Dining › Eating Out' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Shopping' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Food & Dining' })).toBeNull();
  });
});
