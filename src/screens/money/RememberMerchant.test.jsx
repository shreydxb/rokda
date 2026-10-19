import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, cleanup, within } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

// Every call the editor makes, in order, answered from a small in-memory
// household. Rules written here are kept, so a retry sees what an earlier
// attempt left behind, as it would against the database.
const db = { log: [], rules: [], failures: {}, updatedRows: [{ id: 't1' }] };
const run = (q) => {
  const key = `${q.table}.${q.op ?? 'select'}`;
  db.log.push({ key, payload: q.payload });
  const failure = db.failures[key];
  if (failure) {
    if (failure.once) delete db.failures[key];
    return { data: null, error: { message: failure.message } };
  }
  if (key === 'transactions.update') return { data: db.updatedRows, error: null };
  if (key === 'category_rules.select') return { data: db.rules.map((r) => ({ ...r })), error: null };
  if (key === 'category_rules.insert') {
    const row = { id: `rule-${db.rules.length + 1}`, archived: false, created_at: '2026-10-18T09:00:00Z', ...q.payload };
    db.rules.push(row);
    if (failure === undefined && db.loseInsertAnswer) {
      db.loseInsertAnswer = false;
      return { data: null, error: { message: 'Failed to fetch' } };
    }
    return { data: { id: row.id }, error: null };
  }
  return { data: [], error: null };
};
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => {
      const q = { table, op: null, payload: null };
      const api = {
        select: () => api,
        insert: (payload) => ((q.op = 'insert'), (q.payload = payload), api),
        update: (payload) => ((q.op = 'update'), (q.payload = payload), api),
        delete: () => ((q.op = 'delete'), api),
        eq: () => api,
        order: () => api,
        single: () => api,
        then: (resolve, reject) => Promise.resolve(run(q)).then(resolve, reject),
      };
      return api;
    },
    rpc: (name) => {
      db.log.push({ key: `rpc.${name}` });
      return Promise.resolve({ data: null, error: null });
    },
  },
}));

const { default: TransactionEditor } = await import('./TransactionEditor');

const GROCERIES = 'cat-groceries';
const DINING = 'cat-dining';
const SALARY = 'cat-salary';
const CATEGORIES = [
  { id: GROCERIES, name: 'Groceries', kind: 'expense', parent_id: null, archived: false },
  { id: DINING, name: 'Dining out', kind: 'expense', parent_id: null, archived: false },
  { id: SALARY, name: 'Salary', kind: 'income', parent_id: null, archived: false },
];
const ACCOUNTS = [{ id: 'acc-1', name: 'Bank card', type: 'credit_card', archived_at: null, is_shared: true }];
const MEMBERS = [{ id: 'm1', display_name: 'Partner' }];
const TX = {
  id: 't1',
  household_id: 'hh',
  account_id: 'acc-1',
  category_id: DINING,
  amount: -120,
  kind: 'expense',
  currency: 'AED',
  merchant: 'Corner Market 12',
  occurred_at: '2026-10-10',
  is_shared: true,
  owner_member_id: null,
  needs_review: false,
  note: 'weekly shop',
};

const keys = () => db.log.map((e) => e.key).filter((k) => k !== 'transaction_edits.select');
const writes = (key) => db.log.filter((e) => e.key === key);

function open({ tx = TX, rules = [], links = [], onSaved = vi.fn().mockResolvedValue(undefined) } = {}) {
  db.rules = rules.map((r) => ({ ...r }));
  renderScreen(
    <TransactionEditor
      tx={tx}
      householdId="hh"
      accounts={ACCOUNTS}
      categories={CATEGORIES}
      members={MEMBERS}
      allTransactions={[tx]}
      links={links}
      categoryRules={rules}
      onClose={() => {}}
      onSaved={onSaved}
      onOpenOther={null}
    />,
  );
  return { onSaved };
}

const categorySelect = () => screen.getByDisplayValue('Dining out');
const chooseGroceries = () => fireEvent.change(categorySelect(), { target: { value: GROCERIES } });
const rememberBox = () => screen.queryByRole('checkbox', { name: /Remember this merchant/ });
const save = async () => {
  await act(async () => {
    fireEvent.submit(document.querySelector('form'));
  });
};

beforeEach(() => {
  db.log = [];
  db.rules = [];
  db.failures = {};
  db.updatedRows = [{ id: 't1' }];
  db.loseInsertAnswer = false;
});
afterEach(cleanup);

describe('Remember this merchant: off', () => {
  it('is offered, unticked, only once the category changes', () => {
    open();
    expect(rememberBox()).toBeNull();
    chooseGroceries();
    expect(rememberBox()).not.toBeNull();
    expect(rememberBox().checked).toBe(false);
    expect(screen.queryByRole('group', { name: 'Merchant rule' })).toBeNull();
  });

  it('saves the correction exactly as before, with no rule read or written', async () => {
    const { onSaved } = open();
    chooseGroceries();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
    await save();
    expect(keys()).toEqual(['transactions.update', 'transaction_edits.insert']);
    expect(writes('transactions.update')[0].payload).toMatchObject({ category_id: GROCERIES });
    expect(writes('transaction_edits.insert')[0].payload).toEqual([{ transaction_id: 't1', field: 'category', old_value: 'Dining out', new_value: 'Groceries' }]);
    expect(onSaved).toHaveBeenCalledWith();
  });

  it('is taken back by unticking, keeping everything typed', async () => {
    open();
    fireEvent.change(screen.getByDisplayValue('weekly shop'), { target: { value: 'big shop' } });
    chooseGroceries();
    fireEvent.click(rememberBox());
    expect(screen.getByRole('group', { name: 'Merchant rule' })).toBeTruthy();
    fireEvent.click(rememberBox());
    expect(screen.queryByRole('group', { name: 'Merchant rule' })).toBeNull();
    expect(screen.getByDisplayValue('big shop')).toBeTruthy();
    expect(screen.getByDisplayValue('Groceries')).toBeTruthy();
    await save();
    expect(keys()).toEqual(['transactions.update', 'transaction_edits.insert']);
  });
});

describe('Remember this merchant: on', () => {
  it('shows the rule for review: the whole merchant, its match, its category and what it covers', () => {
    open();
    chooseGroceries();
    fireEvent.click(rememberBox());
    const panel = screen.getByRole('group', { name: 'Merchant rule' });
    expect(within(panel).getByLabelText('Merchant pattern').value).toBe('Corner Market 12');
    expect(within(panel).getByRole('button', { name: 'Contains' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(panel).getByRole('button', { name: 'Starts with' }).getAttribute('aria-pressed')).toBe('false');
    expect(panel.textContent).toContain('Groceries');
    expect(panel.textContent).toContain('whose merchant contains “Corner Market 12”');
    expect(panel.textContent).toContain('whatever the letter case');
    expect(panel.textContent).toContain('household’s');
    expect(panel.textContent.toLowerCase()).not.toContain('exact');
    fireEvent.click(within(panel).getByRole('button', { name: 'Starts with' }));
    expect(panel.textContent).toContain('whose merchant starts with “Corner Market 12”');
    expect(screen.getByRole('button', { name: 'Save and add rule' })).toBeTruthy();
  });

  it('saves the record first, then adds the rule after reading the rules again', async () => {
    const { onSaved } = open();
    chooseGroceries();
    fireEvent.click(rememberBox());
    fireEvent.change(screen.getByLabelText('Merchant pattern'), { target: { value: ' corner market ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Starts with' }));
    await save();
    expect(keys()).toEqual(['transactions.update', 'transaction_edits.insert', 'category_rules.select', 'category_rules.insert']);
    expect(writes('category_rules.insert')[0].payload).toEqual({ household_id: 'hh', pattern: 'corner market', match_type: 'starts_with', category_id: GROCERIES });
    expect(onSaved).toHaveBeenCalledWith({ notice: { text: expect.stringContaining('future entries whose merchant starts with “corner market” go to Groceries'), ruleId: 'rule-1' } });
  });

  it('follows the merchant field into the pattern until the pattern is edited', () => {
    open();
    chooseGroceries();
    fireEvent.click(rememberBox());
    fireEvent.change(screen.getByPlaceholderText('Type a merchant name'), { target: { value: 'Corner Market Mall' } });
    expect(screen.getByLabelText('Merchant pattern').value).toBe('Corner Market Mall');
  });

  it('refuses a pattern that would not match the merchant, before writing anything', async () => {
    const { onSaved } = open();
    chooseGroceries();
    fireEvent.click(rememberBox());
    fireEvent.change(screen.getByLabelText('Merchant pattern'), { target: { value: 'Market' } });
    fireEvent.click(screen.getByRole('button', { name: 'Starts with' }));
    await save();
    expect(keys()).toEqual([]);
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').map((a) => a.textContent).join(' ')).toContain('doesn’t start with “Market”');
  });
});

describe('Existing rules', () => {
  it('adds no duplicate of a rule that already files the merchant there', async () => {
    const rules = [{ id: 'r-old', pattern: 'corner market', match_type: 'contains', category_id: GROCERIES, archived: false }];
    const { onSaved } = open({ rules });
    chooseGroceries();
    fireEvent.click(rememberBox());
    expect(screen.getByRole('group', { name: 'Merchant rule' }).textContent).toContain('Already remembered');
    await save();
    expect(keys()).toEqual(['transactions.update', 'transaction_edits.insert']);
    expect(onSaved).toHaveBeenCalledWith({ notice: { text: expect.stringContaining('already files'), ruleId: 'r-old' } });
  });

  it('adds no duplicate of a rule added since the page loaded', async () => {
    const { onSaved } = open();
    chooseGroceries();
    fireEvent.click(rememberBox());
    db.rules = [{ id: 'r-new', pattern: 'Corner Market 12', match_type: 'contains', category_id: GROCERIES, archived: false }];
    await save();
    expect(writes('category_rules.insert')).toHaveLength(0);
    expect(onSaved).toHaveBeenCalledWith({ notice: expect.objectContaining({ ruleId: 'r-new' }) });
  });

  it('explains a rule that files the merchant elsewhere, links to it, and saves the correction without a rule', async () => {
    const rules = [{ id: 'r-dining', pattern: 'corner', match_type: 'contains', category_id: DINING, archived: false }];
    const { onSaved } = open({ rules });
    chooseGroceries();
    fireEvent.click(rememberBox());
    const panel = screen.getByRole('group', { name: 'Merchant rule' });
    expect(panel.textContent).toContain('Contains “corner” already files “Corner Market 12” under Dining out');
    expect(panel.textContent).toContain('without adding a rule');
    // Nothing new would be filed anywhere, so the panel doesn't say it would.
    expect(panel.textContent).not.toContain('Future entries');
    const link = within(panel).getByRole('link', { name: 'Open that rule in Settings' });
    expect(link.getAttribute('href')).toBe('/settings?tab=categories&rule=r-dining');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
    await save();
    expect(keys()).toEqual(['transactions.update', 'transaction_edits.insert']);
    expect(writes('transactions.update')[0].payload).toMatchObject({ category_id: GROCERIES });
    expect(onSaved).toHaveBeenCalledWith({ notice: { text: expect.stringContaining('Saved without a merchant rule'), ruleId: 'r-dining' } });
  });

  it('leaves an archived rule archived and adds the new one', async () => {
    const rules = [{ id: 'r-archived', pattern: 'corner', match_type: 'contains', category_id: DINING, archived: true }];
    open({ rules });
    chooseGroceries();
    fireEvent.click(rememberBox());
    await save();
    expect(writes('category_rules.insert')).toHaveLength(1);
    expect(writes('category_rules.update')).toHaveLength(0);
  });
});

describe('Failures', () => {
  it('adds no rule when the record fails to save', async () => {
    db.failures['transactions.update'] = { message: 'permission denied' };
    const { onSaved } = open();
    chooseGroceries();
    fireEvent.click(rememberBox());
    await save();
    expect(keys()).toEqual(['transactions.update']);
    expect(screen.getByRole('alert').textContent).toContain('permission denied');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('adds no rule when the update changed no row', async () => {
    db.updatedRows = [];
    const { onSaved } = open();
    chooseGroceries();
    fireEvent.click(rememberBox());
    await save();
    expect(keys()).toEqual(['transactions.update']);
    expect(screen.getByRole('alert').textContent).toContain("This record wasn't saved");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('says the record saved and the rule did not, and retries only the rule', async () => {
    db.failures['category_rules.insert'] = { message: 'network down', once: true };
    const { onSaved } = open();
    chooseGroceries();
    fireEvent.click(rememberBox());
    await save();
    expect(screen.getByRole('alert').textContent).toContain('Transaction saved; merchant rule wasn’t saved.');
    expect(screen.getByRole('alert').textContent).toContain('network down');
    expect(onSaved).not.toHaveBeenCalled();
    // The transaction's own fields are gone: nothing here can save it again.
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try the rule again' }));
    });
    expect(keys()).toEqual(['transactions.update', 'transaction_edits.insert', 'category_rules.select', 'category_rules.insert', 'category_rules.select', 'category_rules.insert']);
    expect(writes('transactions.update')).toHaveLength(1);
    expect(writes('transaction_edits.insert')).toHaveLength(1);
    expect(db.rules).toHaveLength(1);
    expect(onSaved).toHaveBeenCalledWith({ notice: expect.objectContaining({ ruleId: 'rule-1' }) });
  });

  it('says so when the rules cannot be read, and the retry adds the rule', async () => {
    db.failures['category_rules.select'] = { message: 'statement timeout', once: true };
    open();
    chooseGroceries();
    fireEvent.click(rememberBox());
    await save();
    expect(screen.getByRole('alert').textContent).toContain('Transaction saved; merchant rule wasn’t saved.');
    expect(writes('category_rules.insert')).toHaveLength(0);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try the rule again' }));
    });
    expect(writes('transactions.update')).toHaveLength(1);
    expect(db.rules).toHaveLength(1);
  });

  it('does not add the rule twice when a retry follows an attempt whose answer was lost', async () => {
    db.loseInsertAnswer = true;
    const { onSaved } = open();
    chooseGroceries();
    fireEvent.click(rememberBox());
    await save();
    expect(screen.getByRole('alert').textContent).toContain('Transaction saved; merchant rule wasn’t saved.');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try the rule again' }));
    });
    expect(db.rules).toHaveLength(1);
    expect(writes('category_rules.insert')).toHaveLength(1);
    expect(writes('transactions.update')).toHaveLength(1);
    expect(writes('transaction_edits.insert')).toHaveLength(1);
    expect(onSaved).toHaveBeenCalledWith({ notice: expect.objectContaining({ ruleId: 'rule-1' }) });
  });

  it('closes after a failed rule with the record saved, saying the rule was not', async () => {
    db.failures['category_rules.insert'] = { message: 'network down' };
    const { onSaved } = open();
    chooseGroceries();
    fireEvent.click(rememberBox());
    await save();
    fireEvent.click(screen.getByText('Close', { selector: 'button' }));
    expect(onSaved).toHaveBeenCalledWith({ notice: { text: expect.stringContaining('Transaction saved; merchant rule wasn’t saved.') } });
    expect(writes('transactions.update')).toHaveLength(1);
  });

  it('turns to retrying the rule when the edit history fails, without saving the record again', async () => {
    db.failures['transaction_edits.insert'] = { message: 'history down' };
    open();
    chooseGroceries();
    fireEvent.click(rememberBox());
    await save();
    expect(screen.getByRole('alert').textContent).toContain('Transaction saved; merchant rule wasn’t saved.');
    expect(screen.getByRole('alert').textContent).toContain('history down');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try the rule again' }));
    });
    expect(writes('transactions.update')).toHaveLength(1);
    expect(writes('transaction_edits.insert')).toHaveLength(1);
    expect(db.rules).toHaveLength(1);
  });
});

describe('Records it is not offered for', () => {
  // Opens the record, moves it to another category, and says whether the
  // control appeared.
  const offeredAfterChange = (tx, { pick = GROCERIES } = {}) => {
    open({ tx });
    fireEvent.change(screen.getByRole('option', { name: 'Uncategorised' }).closest('select'), { target: { value: pick } });
    return rememberBox() !== null;
  };

  it('is offered for an ordinary expense moved from no category', () => {
    expect(offeredAfterChange({ ...TX, category_id: null })).toBe(true);
  });

  it('is not offered when the category is cleared', () => {
    open();
    fireEvent.change(categorySelect(), { target: { value: '' } });
    expect(rememberBox()).toBeNull();
  });

  it('is not offered for a split record, which keeps its lines', () => {
    const split = { ...TX, category_id: null, is_split: true, transaction_splits: [{ category_id: DINING, amount: -60 }, { category_id: GROCERIES, amount: -60 }] };
    open({ tx: split });
    expect(screen.getByRole('group', { name: 'Split across categories' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Category 1'), { target: { value: GROCERIES } });
    expect(rememberBox()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'One category instead' }));
    fireEvent.change(screen.getByDisplayValue('Uncategorised'), { target: { value: GROCERIES } });
    expect(rememberBox()).toBeNull();
  });

  it('is not offered while a record is being split', () => {
    open();
    chooseGroceries();
    expect(rememberBox()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Split across categories' }));
    expect(rememberBox()).toBeNull();
  });

  it('is not offered for a refund, linked or not', () => {
    const refund = { ...TX, kind: 'refund', amount: 40 };
    expect(offeredAfterChange(refund)).toBe(false);
    cleanup();
    const linked = [{ id: 'l1', kind: 'refund', from_transaction_id: 'p1', to_transaction_id: 't1' }];
    open({ tx: refund, links: linked });
    expect(screen.queryByDisplayValue('Dining out')).toBeNull();
    expect(rememberBox()).toBeNull();
  });

  it('is not offered for income, or for an expense turned into income', () => {
    expect(offeredAfterChange({ ...TX, kind: 'income', amount: 500, category_id: null }, { pick: SALARY })).toBe(false);
    cleanup();
    open();
    chooseGroceries();
    fireEvent.click(screen.getByRole('button', { name: 'Income' }));
    expect(rememberBox()).toBeNull();
  });

  it('is not offered for one side of a transfer opened here', async () => {
    const side = { ...TX, kind: 'transfer', category_id: null };
    open({ tx: side });
    expect(rememberBox()).toBeNull();
    await save();
    expect(screen.getByRole('alert').textContent).toContain('one side of a transfer');
    expect(keys()).toEqual([]);
  });

  it('is not offered for a record with no merchant', () => {
    expect(offeredAfterChange({ ...TX, merchant: null })).toBe(false);
  });

  it('is not offered for a new entry', () => {
    renderScreen(
      <TransactionEditor tx={null} householdId="hh" accounts={ACCOUNTS} categories={CATEGORIES} members={MEMBERS} allTransactions={[]} categoryRules={[]} onClose={() => {}} onSaved={async () => {}} onOpenOther={null} />,
    );
    fireEvent.change(screen.getByPlaceholderText('Type a merchant name'), { target: { value: 'Corner Market' } });
    fireEvent.change(screen.getByDisplayValue('Uncategorised'), { target: { value: GROCERIES } });
    expect(rememberBox()).toBeNull();
  });
});
