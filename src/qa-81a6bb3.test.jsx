// Ported QA recheck probe for 81a6bb3 (SHR-241 handoff). Synthetic data and
// mocked writes only — see the linked reproduction document for the original
// source: https://linear.app/shrey0/document/rokda-qa-81a6bb3-retry-recovery-and-migration-evidence-85fa57e53760
//
// The reviewer's mock modelled the retry as insert-then-conditionally-update
// (matching the previous implementation's two separate operations). The fix
// this probe drove instead makes the holdings write a single upsert on a
// client-generated id (see HoldingEditor.jsx) — one call handles both "the
// first attempt never committed" (this probe) and "the first attempt
// committed but the response was lost" (already covered in
// src/qa-762a6c4.test.jsx) without needing to tell them apart. The mock below
// is adapted to that real operation — a Map keyed by id, standing in for the
// table — rather than the reviewer's insert/update pair; the assertion (one
// holding exists after the retry, save succeeds) is unchanged.
import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen, cleanup } from '@testing-library/react';
import { act } from 'react';

const db = vi.hoisted(() => ({ holdings: new Map(), attempts: 0 }));
vi.mock('./lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      upsert: async (row) => {
        if (table === 'holding_value_history') return { error: null };
        db.attempts++;
        // The first attempt fails BEFORE commit — nothing is written, the
        // way a request that never reached the database wouldn't be.
        if (db.attempts === 1) return { error: { message: 'Network failed before commit' } };
        db.holdings.set(row.id, { ...db.holdings.get(row.id), ...row });
        return { error: null };
      },
    }),
  },
}));

const { default: HoldingEditor } = await import('./screens/wealth/HoldingEditor');

beforeEach(() => {
  db.holdings.clear();
  db.attempts = 0;
});
afterEach(cleanup);

it('a failed initial insert can be retried when nothing was committed', async () => {
  const onSaved = vi.fn();
  render(<HoldingEditor holding={null} householdId="hh" members={[]} onClose={() => {}} onSaved={onSaved} />);
  fireEvent.change(screen.getByPlaceholderText('e.g. VWRA'), { target: { value: 'Synthetic' } });
  fireEvent.change(document.querySelector('.te-hero-input'), { target: { value: '100' } });

  await act(async () => {
    fireEvent.submit(document.querySelector('form'));
  });
  expect(screen.getByRole('alert').textContent).toContain('Network failed before commit');
  expect(db.holdings.size).toBe(0);

  await act(async () => {
    fireEvent.submit(document.querySelector('form'));
  });

  expect(db.holdings.size).toBe(1);
  expect(onSaved).toHaveBeenCalledOnce();
});
