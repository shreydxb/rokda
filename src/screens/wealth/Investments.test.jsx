import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/dom';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

// Any write at all would be a defect here, so the mock records every call.
const writes = [];
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from(table) {
      const record = (op) => (payload) => {
        writes.push({ table, op, payload });
        // Filters chain as on the real client. select() reports the rows a
        // filtered update changed: none, as when the row changed after the
        // tab loaded it.
        const chain = {
          in: () => chain,
          eq: () => chain,
          select: () => Promise.resolve({ data: [], error: null }),
          then: (resolve) => resolve({ error: null }),
        };
        return chain;
      };
      return { update: record('update'), insert: record('insert'), upsert: record('upsert'), delete: record('delete') };
    },
  },
}));

const { default: Investments } = await import('./Investments');

const MEMBERS = [{ id: 'm1', display_name: 'Alex' }];
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
  // The tab's own Reload did what the page's Refresh does; it is gone, and
  // the only button here fetches prices. Nothing on the tab writes a
  // valuation date without fetching one.
  it('has no re-read of its own besides the page Refresh, and writes nothing on its own', () => {
    renderScreen(
      <Investments
        household={{ id: 'h' }}
        members={MEMBERS}
        me={MEMBERS[0]}
        loading={false}
        data={{ holdings: [STALE_HOLDING], holdingHistory: [], reload: vi.fn() }}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh prices' })).toBeTruthy();
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

const PRICED_HOLDING = {
  id: 'h2',
  name: 'AAPL',
  asset_class: 'us_equity',
  currency: 'USD',
  is_shared: false,
  value_aed: 20000,
  invested_value_aed: 15000,
  day_change_pct: 2,
  priced_at: '2026-09-09T00:00:00Z',
  owner_member_id: 'm1',
};

describe('Investments: portfolio overview stats', () => {
  it('shows Invested, Profit and loss to date, and Change today', () => {
    renderScreen(
      <Investments
        household={{ id: 'h' }}
        members={MEMBERS}
        me={MEMBERS[0]}
        loading={false}
        data={{ holdings: [PRICED_HOLDING], holdingHistory: [], reload: vi.fn() }}
      />,
    );
    expect(screen.getByText('Invested')).toBeTruthy();
    expect(screen.getByText('Profit and loss to date')).toBeTruthy();
    expect(screen.getByText('Change today')).toBeTruthy();
  });
});

describe('Investments: holdings table shows owner once, not duplicated under the name', () => {
  it('does not repeat the owner in the name cell subtitle', () => {
    renderScreen(
      <Investments
        household={{ id: 'h' }}
        members={MEMBERS}
        me={MEMBERS[0]}
        loading={false}
        data={{ holdings: [PRICED_HOLDING], holdingHistory: [], reload: vi.fn() }}
      />,
    );
    const nameCell = screen.getByText('AAPL').parentElement;
    expect(nameCell.textContent).not.toMatch(/Alex/);
    // The Owner column is the only place the name should appear.
    expect(screen.getAllByText('Alex')).toHaveLength(1);
  });
});

describe('Investments: table currency and % of total', () => {
  it('labels Invested/Value columns with the display currency and shows % of total under Value', () => {
    renderScreen(
      <Investments
        household={{ id: 'h' }}
        members={MEMBERS}
        me={MEMBERS[0]}
        loading={false}
        data={{ holdings: [PRICED_HOLDING], holdingHistory: [], reload: vi.fn() }}
      />,
    );
    expect(screen.getByText('Invested (AED)')).toBeTruthy();
    expect(screen.getByText('Value (AED)')).toBeTruthy();
    expect(screen.getByText(/100%.*of total/)).toBeTruthy();
  });
});

describe('Investments: a refused holding save reads the data afresh', () => {
  // The editor gets the row this tab loaded. Without a reload, opening it
  // again after a refusal would hand it the same old row, refused again.
  it('reloads, so the editor opened again shows what changed', async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    renderScreen(
      <Investments
        household={{ id: 'h' }}
        members={MEMBERS}
        me={MEMBERS[0]}
        loading={false}
        data={{ holdings: [PRICED_HOLDING], holdingHistory: [], reload }}
      />,
    );
    fireEvent.click(document.querySelector('.wl-holdrow'));
    fireEvent.change(screen.getByPlaceholderText('e.g. VWRA'), { target: { value: 'AAPL renamed' } });
    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });
    expect(screen.getByText(/changed or was removed after you opened it/)).toBeTruthy();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
