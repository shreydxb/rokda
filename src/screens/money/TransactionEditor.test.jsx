import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, cleanup } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

const calls = { inserts: [], updates: [] };
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
          return Promise.resolve({ error: null });
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
