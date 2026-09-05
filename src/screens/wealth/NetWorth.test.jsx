import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';

const upserts = [];
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      upsert: (row, options) => {
        upserts.push({ table, row, options });
        return Promise.resolve({ error: null });
      },
    }),
  },
}));

const { default: NetWorth } = await import('./NetWorth');

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
  it('offers the last completed month and writes one idempotent row', async () => {
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

    const button = screen.getByRole('button', { name: /^Close / });
    await act(async () => {
      button.click();
    });

    expect(upserts).toHaveLength(1);
    expect(upserts[0].table).toBe('net_worth_snapshots');
    expect(upserts[0].options).toEqual({ onConflict: 'household_id,snapshot_date' });
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
});
