import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/dom';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

// Any write at all would be a defect here, so the mock records every call.
const writes = [];
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from(table) {
      const record = (op) => (payload) => {
        writes.push({ table, op, payload });
        return { in: () => Promise.resolve({ error: null }), eq: () => Promise.resolve({ error: null }) };
      };
      return { update: record('update'), insert: record('insert'), upsert: record('upsert'), delete: record('delete') };
    },
  },
}));

const { default: Investments } = await import('./Investments');

const MEMBERS = [{ id: 'm1', display_name: 'Shreyash' }];
const STALE_HOLDING = {
  id: 'h1',
  name: 'VWRA',
  asset_class: 'intl_equity',
  currency: 'USD',
  is_shared: true,
  value_aed: 10_000,
  priced_at: '2026-01-01T00:00:00Z',
};

// QA-04 / SHR-245: the Refresh button only stamped last_refreshed. It never
// fetched a price, but the staleness detector read that field — so pressing it
// dismissed the warning without repricing anything.
describe('QA-04: Investments reload does not certify prices', () => {
  it('re-reads data without writing a valuation date', async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    renderScreen(
      <Investments
        household={{ id: 'h' }}
        members={MEMBERS}
        me={MEMBERS[0]}
        loading={false}
        data={{ holdings: [STALE_HOLDING], holdingHistory: [], reload }}
      />,
    );

    const button = screen.getByRole('button', { name: 'Reload' });
    await act(async () => {
      button.click();
    });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
  });

  it('says plainly that reloading is not a repricing', () => {
    renderScreen(
      <Investments
        household={{ id: 'h' }}
        members={MEMBERS}
        me={MEMBERS[0]}
        loading={false}
        data={{ holdings: [STALE_HOLDING], holdingHistory: [], reload: vi.fn() }}
      />,
    );
    expect(screen.getByText(/does not fetch prices/i)).toBeTruthy();
    expect(screen.getByText(/Oldest valuation/i)).toBeTruthy();
  });
});
