import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, cleanup } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

const calls = { inserts: [], snapshots: [] };
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      insert: (row) => {
        calls.inserts.push(row);
        return { select: () => ({ maybeSingle: async () => ({ data: { id: `holding-${calls.inserts.length}` }, error: null }) }) };
      },
      update: () => ({ eq: async () => ({ error: null }) }),
      upsert: async (row) => {
        if (table === 'holding_value_history') return { error: { message: 'Injected history failure' } };
        calls.snapshots.push(row);
        return { error: null };
      },
    }),
  },
}));

const { default: HoldingEditor } = await import('./HoldingEditor');

beforeEach(() => {
  calls.inserts.length = 0;
  calls.snapshots.length = 0;
});

// Ported from the QA recheck (SHR-246): the holding insert and its history
// point used to be separate requests. If the history write failed and the
// reviewer retried Add holding, the retry inserted a second holding row,
// double-counting wealth. A stable id kept across the retry must make this
// idempotent instead.
describe('SHR-246: retrying after a failed history write', () => {
  it('does not insert a second holding', async () => {
    renderScreen(<HoldingEditor holding={null} householdId="hh" members={[]} onClose={() => {}} onSaved={async () => {}} />);

    fireEvent.change(screen.getByPlaceholderText('e.g. VWRA'), { target: { value: 'QA synthetic fund' } });
    fireEvent.change(document.querySelector('.te-hero-input'), { target: { value: '100' } });

    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });
    expect(screen.getByRole('alert').textContent).toContain('Injected history failure');
    expect(calls.inserts).toHaveLength(1);

    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });
    expect(calls.inserts).toHaveLength(1);

    cleanup();
  });
});
