import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, cleanup } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

const calls = { inserts: [], updates: [], savedRows: [{ id: 'saved' }] };
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: () => ({
      insert: (payload) => {
        calls.inserts.push(payload);
        return Promise.resolve({ error: null });
      },
      update: (payload) => ({
        eq: () => {
          calls.updates.push(payload);
          const done = Promise.resolve({ error: null });
          // The editor reads back the row it changed.
          done.select = () => Promise.resolve({ data: calls.savedRows, error: null });
          return done;
        },
      }),
      // SHR-235: edit history is fetched on mount for an existing
      // transaction. No history rows are needed for these SHR-252 cases,
      // so this just resolves empty rather than exercising a real fetch.
      select: () => ({
        eq: () => ({
          order: () => Promise.resolve({ data: [] }),
        }),
      }),
    }),
  },
}));

const { default: TransactionEditor } = await import('./TransactionEditor');

const ACCOUNTS = [{ id: 'acc-1', name: 'ENBD Noon', type: 'credit_card', archived_at: null, is_shared: true }];

beforeEach(() => {
  calls.inserts.length = 0;
  calls.updates.length = 0;
  calls.savedRows = [{ id: 'saved' }];
});

// SHR-252 (762a6c4 recheck): the manual editor never offered "Refund" and
// never persisted `kind` at all — a manual income insert relied on the
// database default (kind='expense'), and editing an existing refund
// initialised the type toggle from its sign, showing it as "Income".
describe('SHR-252: the manual transaction editor persists kind explicitly', () => {
  it('saves a new refund with a positive amount and kind=refund', async () => {
    renderScreen(
      <TransactionEditor
        tx={null}
        householdId="hh"
        accounts={ACCOUNTS}
        categories={[]}
        members={[]}
        allTransactions={[]}
        onClose={() => {}}
        onSaved={async () => {}}
        onOpenOther={null}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Refund' }));
    fireEvent.change(document.querySelector('.te-hero-input'), { target: { value: '75' } });
    fireEvent.change(document.querySelector('.te-fieldgrid select'), { target: { value: 'acc-1' } });
    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });

    expect(calls.inserts).toHaveLength(1);
    expect(calls.inserts[0]).toMatchObject({ amount: 75, kind: 'refund' });
    cleanup();
  });

  it('saves a manual income entry with kind=income, not relying on a database default', async () => {
    renderScreen(
      <TransactionEditor
        tx={null}
        householdId="hh"
        accounts={ACCOUNTS}
        categories={[]}
        members={[]}
        allTransactions={[]}
        onClose={() => {}}
        onSaved={async () => {}}
        onOpenOther={null}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Income' }));
    fireEvent.change(document.querySelector('.te-hero-input'), { target: { value: '500' } });
    fireEvent.change(document.querySelector('.te-fieldgrid select'), { target: { value: 'acc-1' } });
    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });

    expect(calls.inserts[0]).toMatchObject({ amount: 500, kind: 'income' });
    cleanup();
  });

  it('initialises an existing refund as Refund, not Income', () => {
    const tx = {
      id: 't1',
      amount: 100,
      kind: 'refund',
      merchant: 'Amazon',
      occurred_at: '2026-08-06',
      account_id: 'acc-1',
      category_id: null,
      is_shared: true,
    };
    renderScreen(
      <TransactionEditor
        tx={tx}
        householdId="hh"
        accounts={ACCOUNTS}
        categories={[]}
        members={[]}
        allTransactions={[]}
        onClose={() => {}}
        onSaved={async () => {}}
        onOpenOther={null}
      />,
    );
    expect(screen.getByRole('button', { name: 'Refund' }).dataset.active).toBe('true');
    expect(screen.getByRole('button', { name: 'Income' }).dataset.active).toBe('false');
    cleanup();
  });

  it('changing an existing refund to Income persists the new kind and sign', async () => {
    const tx = {
      id: 't1',
      amount: 100,
      kind: 'refund',
      merchant: 'Amazon',
      occurred_at: '2026-08-06',
      account_id: 'acc-1',
      category_id: null,
      is_shared: true,
    };
    renderScreen(
      <TransactionEditor
        tx={tx}
        householdId="hh"
        accounts={ACCOUNTS}
        categories={[]}
        members={[]}
        allTransactions={[]}
        onClose={() => {}}
        onSaved={async () => {}}
        onOpenOther={null}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Income' }));
    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0]).toMatchObject({ amount: 100, kind: 'income' });
  });
});

// QA re-review, 17 October: an update that matched no row (deleted or
// changed elsewhere) returned no error, so the editor closed as if saved.
describe('a save that changed no row', () => {
  it('stays open and says the record was not saved', async () => {
    calls.savedRows = [];
    const onClose = vi.fn();
    const onSaved = vi.fn();
    const tx = { id: 't1', amount: -50, kind: 'expense', merchant: 'Shop', occurred_at: '2026-08-06', account_id: 'acc-1', category_id: null, is_shared: true };
    renderScreen(<TransactionEditor tx={tx} householdId="hh" accounts={ACCOUNTS} categories={[]} members={[]} allTransactions={[]} onClose={onClose} onSaved={onSaved} onOpenOther={null} />);
    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });
    expect(calls.updates).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toMatch(/This record wasn't saved/);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    cleanup();
  });
});

const CATEGORIES = [
  { id: 'util', name: 'Utilities', kind: 'expense', parent_id: null },
  { id: 'dewa', name: 'DEWA', kind: 'expense', parent_id: 'util' },
  { id: 'wifi', name: 'Du Wifi', kind: 'expense', parent_id: 'util' },
  { id: 'groceries', name: 'Groceries', kind: 'expense', parent_id: null },
];

describe('Category picker: two-level dropdown instead of a flat chip wall', () => {
  it('only lists top-level categories in the first dropdown', () => {
    renderScreen(
      <TransactionEditor tx={null} householdId="hh" accounts={ACCOUNTS} categories={CATEGORIES} members={[]} allTransactions={[]} onClose={() => {}} onSaved={async () => {}} />,
    );
    const [categorySelect] = document.querySelectorAll('.te-fieldgrid')[1].querySelectorAll('select');
    const options = [...categorySelect.options].map((o) => o.textContent);
    expect(options).toEqual(['Uncategorised', 'Utilities', 'Groceries']);
    cleanup();
  });

  it('shows a subcategory dropdown scoped to the chosen main category, and saves the subcategory id', async () => {
    renderScreen(
      <TransactionEditor tx={null} householdId="hh" accounts={ACCOUNTS} categories={CATEGORIES} members={[]} allTransactions={[]} onClose={() => {}} onSaved={async () => {}} />,
    );
    const fieldgrids = document.querySelectorAll('.te-fieldgrid');
    const categorySelect = fieldgrids[1].querySelectorAll('select')[0];
    fireEvent.change(categorySelect, { target: { value: 'util' } });

    const subSelect = document.querySelectorAll('.te-fieldgrid')[1].querySelectorAll('select')[1];
    expect([...subSelect.options].map((o) => o.textContent)).toEqual(['General', 'DEWA', 'Du Wifi']);
    fireEvent.change(subSelect, { target: { value: 'dewa' } });

    fireEvent.change(document.querySelector('.te-hero-input'), { target: { value: '250' } });
    fireEvent.change(fieldgrids[0].querySelectorAll('select')[0], { target: { value: 'acc-1' } });
    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });
    expect(calls.inserts[0]).toMatchObject({ category_id: 'dewa' });
    cleanup();
  });
});

describe('Category picker: savings categories are not somewhere spending goes', () => {
  it('leaves a savings category out of the list', () => {
    const withSavings = [...CATEGORIES, { id: 'save', name: 'Savings & Investments', kind: 'expense', parent_id: null, is_savings: true }];
    renderScreen(
      <TransactionEditor tx={null} householdId="hh" accounts={ACCOUNTS} categories={withSavings} members={[]} allTransactions={[]} onClose={() => {}} onSaved={async () => {}} />,
    );
    const [categorySelect] = document.querySelectorAll('.te-fieldgrid')[1].querySelectorAll('select');
    expect([...categorySelect.options].map((o) => o.textContent)).toEqual(['Uncategorised', 'Utilities', 'Groceries']);
    cleanup();
  });
});

describe('Currency selector: entering a non-AED amount converts to AED on save', () => {
  it('converts a USD entry to AED using the fixed peg', async () => {
    renderScreen(
      <TransactionEditor tx={null} householdId="hh" accounts={ACCOUNTS} categories={[]} members={[]} allTransactions={[]} onClose={() => {}} onSaved={async () => {}} />,
    );
    fireEvent.change(document.querySelector('.te-hero-currency-select'), { target: { value: 'USD' } });
    fireEvent.change(document.querySelector('.te-hero-input'), { target: { value: '100' } });
    fireEvent.change(document.querySelector('.te-fieldgrid select'), { target: { value: 'acc-1' } });
    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });
    expect(calls.inserts[0].currency).toBe('USD');
    expect(calls.inserts[0].amount).toBeCloseTo(-367.25, 2);
    cleanup();
  });

  it('does not offer INR when the household has no rate set', () => {
    renderScreen(
      <TransactionEditor tx={null} householdId="hh" household={{}} accounts={ACCOUNTS} categories={[]} members={[]} allTransactions={[]} onClose={() => {}} onSaved={async () => {}} />,
    );
    const options = [...document.querySelector('.te-hero-currency-select').options].map((o) => o.value);
    expect(options).toEqual(['AED', 'USD']);
    cleanup();
  });
});

// QA, 15 Oct: the save treated a refund as positive but the edit history
// diffed it as negative, so saving an untouched refund recorded "+75 → −75".
describe('edit history records what the save changed, refunds included', () => {
  const refund = { id: 't2', amount: 75, kind: 'refund', merchant: 'Shop', occurred_at: '2026-10-01', account_id: 'acc-1', category_id: null, is_shared: true };
  const history = () => calls.inserts.flat().filter((row) => row.transaction_id === 't2');

  function editRefund() {
    renderScreen(
      <TransactionEditor tx={refund} householdId="hh" accounts={ACCOUNTS} categories={[]} members={[]} allTransactions={[]} onClose={() => {}} onSaved={async () => {}} onOpenOther={null} />,
    );
  }

  it('saving an unchanged refund records no change', async () => {
    editRefund();
    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });
    expect(calls.updates[0]).toMatchObject({ amount: 75, kind: 'refund' });
    expect(history()).toEqual([]);
    cleanup();
  });

  it('a refund changed from 75 to 80 records +75 → +80', async () => {
    editRefund();
    fireEvent.change(document.querySelector('.te-hero-input'), { target: { value: '80' } });
    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });
    expect(history()).toEqual([expect.objectContaining({ field: 'amount', old_value: '+75', new_value: '+80' })]);
    cleanup();
  });

  it('a refund turned into income records the change of type', async () => {
    editRefund();
    fireEvent.click(screen.getByRole('button', { name: 'Income' }));
    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });
    expect(history()).toEqual([expect.objectContaining({ field: 'kind', old_value: 'Refund', new_value: 'Income' })]);
    cleanup();
  });
});
