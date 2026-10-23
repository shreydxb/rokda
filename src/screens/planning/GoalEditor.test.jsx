import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import GoalEditor from './GoalEditor';

// Every write the editor sends, and a way to make one fail.
const calls = vi.hoisted(() => ({ writes: [], fail: {} }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => {
      const write = async (op, payload, id) => {
        calls.writes.push({ table, op, payload, id });
        return { error: calls.fail[`${table}:${op}`] ?? null };
      };
      return {
        insert: (row) => write('insert', row),
        update: (row) => ({ eq: (_column, id) => write('update', row, id) }),
        delete: () => ({ eq: (_column, id) => write('delete', null, id) }),
      };
    },
  },
}));

beforeEach(() => {
  calls.writes.length = 0;
  calls.fail = {};
});

const GOAL = { id: 'g1', name: 'Trip', note: '', target_amount: 5000, target_date: '2027-03-01', funding_source: '', is_shared: true, owner_member_id: null, cost_today: false, inflation_pct: null, priority: null };

function renderEditor(props = {}) {
  const onSaved = vi.fn();
  const onChanged = vi.fn();
  renderScreen(
    <GoalEditor
      goal={null}
      contributions={[]}
      allocations={[]}
      accounts={[]}
      holdings={[]}
      householdId="h"
      members={[]}
      inflationPct={2.5}
      onClose={vi.fn()}
      onSaved={onSaved}
      onChanged={onChanged}
      {...props}
    />,
  );
  return { onSaved, onChanged };
}

const type = (el, value) => fireEvent.change(el, { target: { value } });

describe('GoalEditor: today\'s cost, its rate and a priority', () => {
  it('previews the cost on the date and saves the new fields', async () => {
    const { onSaved } = renderEditor();
    type(screen.getByLabelText('Target, AED'), '1000000');
    type(screen.getByLabelText('Name'), 'Villa');
    type(screen.getByLabelText('Target date'), '2044-09-01');
    fireEvent.click(screen.getByText('Today’s cost'));
    type(screen.getByLabelText('Rises by, percent a year'), '8');
    expect(screen.getByText(/^About [\d,]+ by 2044/)).toBeTruthy();
    type(screen.getByLabelText('Priority'), '1');
    fireEvent.click(screen.getByText(/^(Add goal|Save)/));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.writes[0]).toMatchObject({ table: 'goals', op: 'insert', payload: { name: 'Villa', target_amount: 1000000, cost_today: true, inflation_pct: 8, priority: 1 } });
  });

  it('keeps no rate for an amount on the date, and refuses a priority of zero', () => {
    renderEditor();
    type(screen.getByLabelText('Target, AED'), '5000');
    type(screen.getByLabelText('Name'), 'Trip');
    type(screen.getByLabelText('Priority'), '0');
    fireEvent.click(screen.getByText(/^(Add goal|Save)/));
    expect(screen.getByText('Priority is a whole number from 1.')).toBeTruthy();
    expect(calls.writes).toEqual([]);
  });
});

describe('GoalEditor: fields say what they are, and are marked wrong only after a save is tried', () => {
  it('opens with nothing marked invalid, then marks each field with its own message', () => {
    renderEditor();
    const name = screen.getByLabelText('Name');
    const target = screen.getByLabelText('Target, AED');
    expect([name.getAttribute('aria-invalid'), target.getAttribute('aria-invalid')]).toEqual(['false', 'false']);
    fireEvent.click(screen.getByText('Add goal'));
    expect([name.getAttribute('aria-invalid'), target.getAttribute('aria-invalid')]).toEqual(['true', 'true']);
    const describedBy = (el) => document.getElementById(el.getAttribute('aria-describedby')).textContent;
    expect([describedBy(target), describedBy(name)]).toEqual(['Set a target above zero.', 'Name it.']);
    expect(screen.getByRole('alert').textContent).toBe('Fix the marked field to save.');
    // Focus goes to the first field that stopped the save.
    expect(document.activeElement).toBe(target);
    // A corrected field drops its mark straight away.
    type(name, 'Trip');
    expect(name.getAttribute('aria-invalid')).toBe('false');
    expect(calls.writes).toEqual([]);
  });
});

describe('GoalEditor: contributions and links are their own forms and keep the drawer open', () => {
  it('Enter in the contribution amount logs it, and the goal and its unsaved edits stay', async () => {
    const { onSaved, onChanged } = renderEditor({ goal: GOAL });
    const name = screen.getByLabelText('Name');
    type(name, 'Trip to the coast');
    const amount = screen.getByLabelText('Amount (AED)');
    type(amount, '500');
    // Enter submits the form a field belongs to: the contribution's, not the goal's.
    expect(amount.form).not.toBe(name.form);
    fireEvent.submit(amount.form);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls.writes).toEqual([{ table: 'goal_contributions', op: 'insert', payload: { goal_id: 'g1', amount: 500, occurred_at: expect.any(String) }, id: undefined }]);
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Name').value).toBe('Trip to the coast');
    expect(screen.getByText('Unsaved')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/^Logged 500 on /);
    expect(amount.value).toBe('');
  });

  it('asks before removing a contribution, and says so when the remove fails', async () => {
    const { onChanged } = renderEditor({ goal: GOAL, contributions: [{ id: 'c1', goal_id: 'g1', amount: 300, occurred_at: '2026-09-01' }] });
    expect(screen.getByText('1 Sept 2026')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Remove the contribution of 300/ }));
    expect(calls.writes).toEqual([]);
    calls.fail['goal_contributions:delete'] = { message: 'permission denied for table goal_contributions' };
    fireEvent.click(screen.getByText('Confirm remove'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('permission denied for table goal_contributions'));
    expect(calls.writes).toEqual([{ table: 'goal_contributions', op: 'delete', payload: null, id: 'c1' }]);
    expect(onChanged).not.toHaveBeenCalled();
    // Keep leaves it as it was.
    fireEvent.click(screen.getByText('Keep'));
    expect(screen.getByRole('button', { name: /^Remove the contribution of 300/ })).toBeTruthy();
  });
});

describe('GoalEditor: nothing typed is lost or sent twice', () => {
  it('clears the amount as soon as it is logged, and a second press during the reload sends nothing', async () => {
    let finishReload;
    const onChanged = vi.fn(() => new Promise((resolve) => (finishReload = resolve)));
    renderEditor({ goal: GOAL, onChanged });
    const amount = screen.getByLabelText('Amount (AED)');
    type(amount, '500');
    fireEvent.submit(amount.form);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(amount.value).toBe('');
    // Typed again and pressed while the records reload: held, not sent.
    type(amount, '500');
    fireEvent.submit(amount.form);
    finishReload();
    await waitFor(() => expect(screen.getByText('Log contribution').getAttribute('aria-disabled')).toBe('false'));
    expect(calls.writes.filter((w) => w.table === 'goal_contributions')).toHaveLength(1);
    expect(amount.value).toBe('500');
  });

  it('counts a typed share as unsaved: Save refuses until it is updated or undone, and Escape asks first', () => {
    const onClose = vi.fn();
    renderEditor({ goal: GOAL, accounts: [{ id: 'sav', name: 'Savings', type: 'savings', currency: 'AED', archived_at: null }], allocations: [{ id: 'a1', goal_id: 'g1', account_id: 'sav', holding_id: null, share_pct: 50 }], onClose });
    type(screen.getByLabelText('Share of Savings, percent'), '60');
    expect(screen.getByText('Unsaved')).toBeTruthy();
    fireEvent.click(screen.getByText('Save changes'));
    expect(screen.getByRole('alert').textContent).toBe('Update or undo the share on Savings first.');
    expect(calls.writes).toEqual([]);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Discard changes?')).toBeTruthy();
  });

  it('Escape steps back out of a pending remove before it closes anything, and focus stays on the Remove button', () => {
    const onClose = vi.fn();
    renderEditor({ goal: GOAL, contributions: [{ id: 'c1', goal_id: 'g1', amount: 300, occurred_at: '2026-09-01' }], onClose });
    const remove = screen.getByRole('button', { name: /^Remove the contribution of 300/ });
    remove.focus();
    fireEvent.click(remove);
    // The same button now asks to confirm, so focus has not moved.
    expect(document.activeElement).toBe(remove);
    expect(remove.textContent).toBe('Confirm remove');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(remove.textContent).toBe('Remove');
    expect(calls.writes).toEqual([]);
  });
});

describe('GoalEditor: what a goal can be linked to', () => {
  const ACCOUNTS = [
    { id: 'cur', name: 'Current', type: 'checking', currency: 'AED', archived_at: null },
    { id: 'sav', name: 'Savings', type: 'savings', currency: 'AED', archived_at: null },
    { id: 'card', name: 'Bank card', type: 'credit_card', currency: 'AED', archived_at: null },
    { id: 'loan', name: 'Car loan', type: 'loan', currency: 'AED', archived_at: null },
    { id: 'old', name: 'Old savings', type: 'savings', currency: 'AED', archived_at: '2026-01-01T00:00:00Z' },
  ];
  const LINKED = [{ id: 'a1', goal_id: 'g1', account_id: 'sav', holding_id: null, share_pct: 50 }];

  it('offers only open accounts that hold money, and not one already linked', () => {
    renderEditor({ goal: GOAL, accounts: ACCOUNTS, allocations: LINKED });
    const options = within(screen.getByLabelText('Account / holding')).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Current']);
  });

  it('changes a linked share on its own row', async () => {
    const { onChanged } = renderEditor({ goal: GOAL, accounts: ACCOUNTS, allocations: LINKED });
    const share = screen.getByLabelText('Share of Savings, percent');
    expect(share.value).toBe('50');
    type(share, '60');
    fireEvent.click(screen.getByText('Update'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls.writes).toEqual([{ table: 'goal_allocations', op: 'update', payload: { share_pct: 60 }, id: 'a1' }]);
  });

  it('says a card linked before the rule counts as nothing, with no share to change', () => {
    renderEditor({ goal: GOAL, accounts: ACCOUNTS, allocations: [...LINKED, { id: 'a2', goal_id: 'g1', account_id: 'card', holding_id: null, share_pct: 100 }] });
    expect(screen.getByText('Counts as nothing: a card is owed, not saved.')).toBeTruthy();
    expect(screen.queryByLabelText('Share of Bank card, percent')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove the link to Bank card' })).toBeTruthy();
  });

  it('links a fractional share, which the database accepts', async () => {
    const { onChanged } = renderEditor({ goal: GOAL, accounts: ACCOUNTS, allocations: LINKED });
    type(screen.getByLabelText('Share %'), '33.5');
    fireEvent.click(screen.getByText('Link'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls.writes[0]).toMatchObject({ table: 'goal_allocations', op: 'insert', payload: { account_id: 'cur', share_pct: 33.5 } });
  });

  it('explains a link that would pass 100% in words', async () => {
    renderEditor({ goal: GOAL, accounts: ACCOUNTS, allocations: LINKED });
    calls.fail['goal_allocations:insert'] = { code: '23514', message: 'allocations for this account/holding would exceed 100% (already 60 allocated)' };
    fireEvent.click(screen.getByText('Link'));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('That would link more than 100% of it to goals: 60% is already linked to other goals. Lower the share.'),
    );
    expect(calls.writes[0]).toMatchObject({ table: 'goal_allocations', op: 'insert', payload: { account_id: 'cur', share_pct: 100 } });
  });
});

// Planning audit, 1.6: only the Life plan could say a goal's money is kept.
describe('GoalEditor: spent or kept', () => {
  it('saves a new goal as spent on its date unless marked kept', async () => {
    const { onSaved } = renderEditor();
    type(screen.getByLabelText('Target, AED'), '20000');
    type(screen.getByLabelText('Name'), 'Emergency fund');
    expect(screen.getByRole('button', { name: 'Spent on its date' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Kept, not spent' }));
    expect(screen.getByText(/^Like an emergency fund: held in cash/)).toBeTruthy();
    fireEvent.click(screen.getByText(/^(Add goal|Save)/));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.writes[0]).toMatchObject({ table: 'goals', op: 'insert', payload: { name: 'Emergency fund', counts_in_life_plan: false } });
  });

  it('opens a kept goal as kept, and saves it spent once changed back', async () => {
    const { onSaved } = renderEditor({ goal: { ...GOAL, counts_in_life_plan: false } });
    expect(screen.getByRole('button', { name: 'Kept, not spent' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Spent on its date' }));
    fireEvent.click(screen.getByText(/^Save/));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.writes.find((w) => w.table === 'goals')).toMatchObject({ op: 'update', payload: { counts_in_life_plan: true } });
  });
});
