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
