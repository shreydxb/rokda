import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, cleanup } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

// A minimal, realistic simulation of the `holdings` table: upsert on `id`
// either inserts (id not present yet) or updates in place (id already
// there) — the same semantics a real `on conflict (id) do update` has.
const db = { holdings: new Map(), histories: [] };
let historyFailsOnce = false;

vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      update: (row) => ({
        eq: async (_field, id) => {
          if (table === 'holdings' && db.holdings.has(id)) {
            db.holdings.set(id, { ...db.holdings.get(id), ...row });
          }
          return { error: null };
        },
      }),
      upsert: async (row) => {
        if (table === 'holding_value_history') {
          db.histories.push(row);
          if (historyFailsOnce) {
            historyFailsOnce = false;
            return { error: { message: 'Injected history failure' } };
          }
          return { error: null };
        }
        db.holdings.set(row.id, { ...db.holdings.get(row.id), ...row });
        return { error: null };
      },
    }),
  },
}));

const { default: HoldingEditor } = await import('./HoldingEditor');

beforeEach(() => {
  db.holdings.clear();
  db.histories.length = 0;
  historyFailsOnce = false;
});

// Ported from the QA recheck (SHR-246): the holding save and its history
// point used to be separate requests. If the history write failed and the
// reviewer retried Add holding, the retry inserted a second holding row,
// double-counting wealth. A stable id upserted on retry must make this
// idempotent instead.
describe('SHR-246: retrying after a failed history write', () => {
  it('does not create a second holding', async () => {
    historyFailsOnce = true;
    renderScreen(<HoldingEditor holding={null} householdId="hh" members={[]} onClose={() => {}} onSaved={async () => {}} />);

    fireEvent.change(screen.getByPlaceholderText('e.g. VWRA'), { target: { value: 'QA synthetic fund' } });
    fireEvent.change(document.querySelector('.te-hero-input'), { target: { value: '100' } });

    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });
    expect(screen.getByRole('alert').textContent).toContain('Injected history failure');
    expect(db.holdings.size).toBe(1);

    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });
    expect(db.holdings.size).toBe(1);

    cleanup();
  });
});
