// Needs attention shows the most pressing few, with the rest one tap away. A
// household with several stale holdings and one card due should see the card
// first, a short list, and a way to see everything.
import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { screen } from '@testing-library/react';
import { renderScreen } from '../test/renderScreen';

vi.mock('../lib/supabaseClient', () => ({ supabase: {} }));

vi.mock('../lib/useHousehold', () => ({
  useHousehold: () => ({
    household: { id: 'hh', name: 'Test' },
    members: [{ id: 'm1', display_name: 'Partner A' }],
    me: { id: 'm1', display_name: 'Partner A' },
    loading: false,
    error: null,
    reload: () => {},
  }),
}));

const NOW = new Date();
const TODAY = NOW.toISOString().slice(0, 10);
const LONG_AGO = new Date(NOW.getTime() - 90 * 86400000).toISOString();

const ACCOUNTS = [
  { id: 'a1', name: 'Wallet', type: 'cash', currency: 'AED', balance: 100, balance_aed: 100, balance_as_of: TODAY, is_shared: true, owner_member_id: null, archived_at: null },
  // Owed and due today: the one urgent item.
  { id: 'c1', name: 'Bank card', type: 'credit_card', currency: 'AED', balance: 500, balance_aed: 500, balance_as_of: TODAY, due_day: NOW.getDate(), is_shared: true, owner_member_id: null, archived_at: null },
];
// Six holdings last valued three months ago: six informational items.
// Last month already closed, so the month-close reminder is not among them.
const LAST_MONTH = new Date(NOW.getFullYear(), NOW.getMonth() - 1, 1);
const CLOSED = [{ id: 's1', household_id: 'hh', snapshot_date: `${LAST_MONTH.getFullYear()}-${String(LAST_MONTH.getMonth() + 1).padStart(2, '0')}-01`, assets: 600, liabilities: 500 }];

// A recent export recorded, so the backup reminder is not among them either.
const BACKUPS = [{ id: 'b1', household_id: 'hh', kind: 'export', result: 'passed', done_on: TODAY, created_at: NOW.toISOString() }];
const HOLDINGS = Array.from({ length: 6 }, (_, i) => ({
  id: `h${i}`, name: `Fund ${i + 1}`, asset_class: 'intl_equity', quantity: 1, value_aed: 1000, priced_at: LONG_AGO, is_shared: true, owner_member_id: null,
}));

vi.mock('./useOverviewData', async (importOriginal) => ({
  ...(await importOriginal()),
  useOverviewData: () => ({
    loading: false,
    accounts: ACCOUNTS,
    transactions: [],
    categories: [],
    recurring: [],
    netWorthSnapshots: CLOSED,
    holdings: HOLDINGS,
    backupRecords: BACKUPS,
    errors: {},
    loadedAt: new Date(),
    reload: () => {},
  }),
}));

function attentionRows(container) {
  return [...container.querySelectorAll('#ov-attn-list .ov-attn-row')].map((r) => r.querySelector('.ov-attn-main span')?.textContent ?? '');
}

describe('Needs attention', () => {
  it('shows the most pressing four first, and the rest on request', async () => {
    const { default: Overview } = await import('./Overview');
    const { container } = renderScreen(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>,
    );

    let rows = attentionRows(container);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatch(/Bank card payment due/);
    expect(container.textContent).toContain('7 open');

    const more = screen.getByRole('button', { name: 'Show all 7' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await act(async () => more.click());
    rows = attentionRows(container);
    expect(rows).toHaveLength(7);
    expect(rows.filter((r) => /hasn't been repriced/.test(r))).toHaveLength(6);

    const fewer = screen.getByRole('button', { name: 'Show fewer' });
    expect(fewer.getAttribute('aria-expanded')).toBe('true');
    await act(async () => fewer.click());
    expect(attentionRows(container)).toHaveLength(4);
  });
});
