import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';

const upserts = [];
// A real upsert with ignoreDuplicates + .select() returns the written row on
// a genuine insert, and an empty array when the conflict target already
// existed and nothing was written. mockUpsertHitsConflict simulates the
// latter — another session already closed this month (SHR-246).
let mockUpsertHitsConflict = false;
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      upsert: (row, options) => {
        upserts.push({ table, row, options });
        return { select: () => Promise.resolve(mockUpsertHitsConflict ? { data: [], error: null } : { data: [row], error: null }) };
      },
    }),
  },
}));

const { default: NetWorth } = await import('./NetWorth');

beforeEach(() => {
  upserts.length = 0;
  mockUpsertHitsConflict = false;
});

const MEMBERS = [{ id: 'm1', display_name: 'Shreyash' }];

// QA-08 at the call site the review named: NetWorth.jsx's hero passed a signed
// figure to the magnitude formatter, so −100 rendered as 100.
describe('QA-08: the net worth hero keeps its sign', () => {
  it('renders a negative net worth with a minus', () => {
    renderScreen(
      <NetWorth
        household={{ id: 'h1' }}
        me={MEMBERS[0]}
        members={MEMBERS}
        loading={false}
        data={{
          accounts: [{ id: 'l1', name: 'Car loan', type: 'loan', balance: 100, is_shared: true, archived_at: null }],
          netWorthSnapshots: [],
          holdings: [],
        }}
      />,
    );
    const hero = document.querySelector('.ov-hero');
    expect(hero.textContent).toContain('−100');
  });

  it('renders a positive net worth without decoration', () => {
    renderScreen(
      <NetWorth
        household={{ id: 'h1' }}
        me={MEMBERS[0]}
        members={MEMBERS}
        loading={false}
        data={{
          accounts: [{ id: 's1', name: 'Savings', type: 'savings', balance: 100, is_shared: true, archived_at: null }],
          netWorthSnapshots: [],
          holdings: [],
        }}
      />,
    );
    const hero = document.querySelector('.ov-hero');
    expect(hero.textContent).toContain('100');
    expect(hero.textContent).not.toMatch(/[−+]/);
    expect(screen.getByText('Net worth')).toBeTruthy();
  });
});

// QA-05 / SHR-246: net_worth_snapshots was read but never written. History
// accumulates because someone closes a month.
describe('QA-05: closing a month', () => {
  it('offers the last completed month, reviews the values, then writes one idempotent row', async () => {
    const { act } = await import('react');
    const reload = vi.fn().mockResolvedValue(undefined);
    renderScreen(
      <NetWorth
        household={{ id: 'hh' }}
        me={MEMBERS[0]}
        members={MEMBERS}
        loading={false}
        data={{
          accounts: [{ id: 's1', name: 'Savings', type: 'savings', balance: 1000, is_shared: true, archived_at: null }],
          netWorthSnapshots: [],
          holdings: [],
          reload,
        }}
      />,
    );

    // Clicking "Close <month>" opens a review of what would be written — it
    // must not write anything by itself (SHR-246: current/provisional totals
    // must not silently become historical fact).
    const button = screen.getByRole('button', { name: /^Close / });
    await act(async () => {
      button.click();
    });
    expect(upserts).toHaveLength(0);

    const confirmButton = screen.getByRole('button', { name: /Confirm & close/ });
    await act(async () => {
      confirmButton.click();
    });

    expect(upserts).toHaveLength(1);
    expect(upserts[0].table).toBe('net_worth_snapshots');
    expect(upserts[0].options).toEqual({ onConflict: 'household_id,snapshot_date', ignoreDuplicates: true });
    expect(upserts[0].row.assets).toBe(1000);
    expect(reload).toHaveBeenCalled();
  });

  it('says history is not configured rather than promising it will appear', () => {
    renderScreen(
      <NetWorth
        household={{ id: 'hh' }}
        me={MEMBERS[0]}
        members={MEMBERS}
        loading={false}
        data={{ accounts: [], netWorthSnapshots: [], holdings: [], reload: vi.fn() }}
      />,
    );
    expect(screen.getByText(/No month has been closed yet/i)).toBeTruthy();
  });

  // Ported from the QA recheck: clicking "Close August" from live September
  // balances must never write those balances as August's history.
  it("does not write September's current balances as August history", async () => {
    const { act } = await import('react');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-06T12:00:00Z'));
    try {
      renderScreen(
        <NetWorth
          household={{ id: 'hh' }}
          me={MEMBERS[0]}
          members={MEMBERS}
          loading={false}
          data={{
            accounts: [
              {
                id: 'a',
                name: 'Synthetic',
                type: 'savings',
                balance: 9000,
                balance_as_of: '2026-09-06T00:00:00Z',
                is_shared: true,
              },
            ],
            holdings: [],
            netWorthSnapshots: [],
            reload: vi.fn().mockResolvedValue(undefined),
          }}
        />,
      );
      await act(async () => {
        screen.getByRole('button', { name: /^Close / }).click();
      });
      expect(upserts.filter((u) => u.row?.snapshot_date === '2026-08-01' && u.row?.assets === 9000)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // 762a6c4 recheck (SHR-246): the review inputs coerced a blank or
  // non-numeric field to zero instead of refusing to close on it.
  it('blocks Confirm & close when a reviewed value is blank', async () => {
    const { act } = await import('react');
    renderScreen(
      <NetWorth
        household={{ id: 'hh' }}
        me={MEMBERS[0]}
        members={MEMBERS}
        loading={false}
        data={{
          accounts: [{ id: 's1', name: 'Savings', type: 'savings', balance: 1000, is_shared: true, archived_at: null }],
          netWorthSnapshots: [],
          holdings: [],
          reload: vi.fn(),
        }}
      />,
    );
    await act(async () => {
      screen.getByRole('button', { name: /^Close / }).click();
    });
    const assetsInput = document.querySelector('.te-fieldgrid input[type="number"]');
    await act(async () => {
      assetsInput.dispatchEvent(new Event('input', { bubbles: true }));
      Object.defineProperty(assetsInput, 'value', { value: '', configurable: true });
      assetsInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const confirmButton = screen.getByRole('button', { name: /Confirm & close/ });
    expect(confirmButton.disabled).toBe(true);
    await act(async () => {
      confirmButton.click();
    });
    expect(upserts).toHaveLength(0);
  });

  // 762a6c4 recheck (SHR-246): report a concurrently-closed month clearly
  // instead of silently reloading as if the reviewer's own numbers were saved.
  it('reports a concurrently-closed month instead of silently succeeding', async () => {
    const { act } = await import('react');
    mockUpsertHitsConflict = true;
    const reload = vi.fn();
    renderScreen(
      <NetWorth
        household={{ id: 'hh' }}
        me={MEMBERS[0]}
        members={MEMBERS}
        loading={false}
        data={{
          accounts: [{ id: 's1', name: 'Savings', type: 'savings', balance: 1000, is_shared: true, archived_at: null }],
          netWorthSnapshots: [],
          holdings: [],
          reload,
        }}
      />,
    );
    await act(async () => {
      screen.getByRole('button', { name: /^Close / }).click();
    });
    await act(async () => {
      screen.getByRole('button', { name: /Confirm & close/ }).click();
    });
    expect(screen.getByRole('alert').textContent).toMatch(/already closed by another session/i);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('NetWorth composition bar', () => {
  it('breaks assets down by class with percentages that sum to the total', () => {
    renderScreen(
      <NetWorth
        household={{ id: 'h1' }}
        me={MEMBERS[0]}
        members={MEMBERS}
        loading={false}
        data={{
          accounts: [
            { id: 'a1', name: 'ENBD', type: 'checking', balance: 30000, balance_as_of: '2026-09-01', is_shared: true, archived_at: null },
          ],
          netWorthSnapshots: [],
          holdings: [
            { id: 'h1', name: 'VWRA', asset_class: 'equity', value_aed: 60000, is_shared: true, archived_at: null },
            { id: 'h2', name: 'Gold', asset_class: 'commodity', value_aed: 10000, is_shared: true, archived_at: null },
          ],
        }}
      />,
    );
    const legend = document.querySelector('.wl-composition-legend').textContent;
    expect(legend).toMatch(/Cash.*30%/);
    expect(legend).toMatch(/equity.*60%/i);
    expect(legend).toMatch(/Commodity.*10%/i);
  });

  it('omits the composition bar entirely when there is nothing to break down', () => {
    renderScreen(
      <NetWorth
        household={{ id: 'h1' }}
        me={MEMBERS[0]}
        members={MEMBERS}
        loading={false}
        data={{ accounts: [], netWorthSnapshots: [], holdings: [] }}
      />,
    );
    expect(document.querySelector('.wl-composition')).toBeNull();
  });
});

describe('NetWorth history table', () => {
  it('shows a row per closed month plus the live month, with change from the prior row', () => {
    renderScreen(
      <NetWorth
        household={{ id: 'h1' }}
        me={MEMBERS[0]}
        members={MEMBERS}
        loading={false}
        data={{
          accounts: [
            { id: 'a1', name: 'ENBD', type: 'checking', balance: 62000, balance_as_of: '2026-09-01', is_shared: true, archived_at: null },
          ],
          netWorthSnapshots: [{ snapshot_date: '2026-08-01', assets: 95000, liabilities: 48000 }],
          holdings: [],
        }}
      />,
    );
    const table = document.querySelector('.wl-history-table table').textContent;
    expect(table).toMatch(/Aug 26/);
    expect(table).toMatch(/live/i);
  });
});

describe('NetWorth: investments rolled into Assets, not a separate section', () => {
  it('shows one "Investments" line with the total, not each holding listed separately', () => {
    renderScreen(
      <NetWorth
        household={{ id: 'h1' }}
        me={MEMBERS[0]}
        members={MEMBERS}
        loading={false}
        data={{
          accounts: [{ id: 'a1', name: 'ENBD', type: 'checking', balance: 10000, balance_as_of: '2026-09-01', is_shared: true, archived_at: null }],
          netWorthSnapshots: [],
          holdings: [
            { id: 'h1', name: 'VWRA', asset_class: 'equity', value_aed: 60000, is_shared: true, archived_at: null },
            { id: 'h2', name: 'Gold', asset_class: 'commodity', value_aed: 10000, is_shared: true, archived_at: null },
          ],
        }}
      />,
    );
    expect(screen.getByText('Investments')).toBeTruthy();
    expect(screen.queryByText('VWRA')).toBeNull();
    expect(screen.queryByText('Gold')).toBeNull();
    expect(screen.getByText('2 holdings')).toBeTruthy();
  });

  it('shows Total assets including both accounts and holdings', () => {
    renderScreen(
      <NetWorth
        household={{ id: 'h1' }}
        me={MEMBERS[0]}
        members={MEMBERS}
        loading={false}
        data={{
          accounts: [{ id: 'a1', name: 'ENBD', type: 'checking', balance: 10000, balance_as_of: '2026-09-01', is_shared: true, archived_at: null }],
          netWorthSnapshots: [],
          holdings: [{ id: 'h1', name: 'VWRA', asset_class: 'equity', value_aed: 60000, is_shared: true, archived_at: null }],
        }}
      />,
    );
    const totalRow = [...document.querySelectorAll('.wl-total-row')].find((r) => r.textContent.includes('Total assets'));
    expect(totalRow.textContent).toMatch(/70,000/);
  });
});

describe('NetWorth: Monthly change section', () => {
  it('lists a signed change per closed month, matching the history table', () => {
    renderScreen(
      <NetWorth
        household={{ id: 'h1' }}
        me={MEMBERS[0]}
        members={MEMBERS}
        loading={false}
        data={{
          accounts: [],
          netWorthSnapshots: [
            { snapshot_date: '2026-07-01', assets: 90000, liabilities: 50000 },
            { snapshot_date: '2026-08-01', assets: 95000, liabilities: 48000 },
          ],
          holdings: [],
        }}
      />,
    );
    expect(screen.getByText('Monthly change')).toBeTruthy();
    const rows = [...document.querySelectorAll('.wl-change-row')];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.textContent.includes('+7,000'))).toBe(true);
  });

  it('omits the section entirely when there is no history', () => {
    renderScreen(
      <NetWorth
        household={{ id: 'h1' }}
        me={MEMBERS[0]}
        members={MEMBERS}
        loading={false}
        data={{ accounts: [], netWorthSnapshots: [], holdings: [] }}
      />,
    );
    expect(screen.queryByText('Monthly change')).toBeNull();
  });
});
