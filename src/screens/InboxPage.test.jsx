import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { renderScreen } from '../test/renderScreen';

vi.mock('../lib/supabaseClient', () => ({ supabase: {} }));
vi.mock('../lib/useHousehold', () => ({
  useHousehold: () => ({ household: { id: 'hh', name: 'Test' }, members: [{ id: 'm1', display_name: 'Alex' }], me: { id: 'm1' }, loading: false, error: null, reload: async () => {} }),
}));

const ITEM = { id: 'i1', household_id: 'hh', status: 'pending', source: 'telegram', member_id: 'm1', raw_text: 'Cafe 45', parsed_amount: 45, parsed_merchant: 'Cafe', parsed_account_id: 'a1', parsed_category_id: 'c1', parsed_date: '2026-11-10', confidence: 0.95, created_at: '2026-11-10T08:00:00Z' };
const data = {
  intake: [ITEM, { ...ITEM, id: 'i2', parsed_merchant: 'Shop', parsed_category_id: null, confidence: 0.5 }, { ...ITEM, id: 'i3', status: 'approved' }],
  accounts: [{ id: 'a1', name: 'Bank card', type: 'credit_card', archived_at: null, is_shared: true }],
  categories: [{ id: 'c1', name: 'Dining out', kind: 'expense', parent_id: null }],
  transactions: [],
  categoryRules: [],
};
vi.mock('./useOverviewData', () => ({
  useOverviewData: () => ({ loading: false, refreshing: false, errors: {}, loaded: { intake: true }, loadedAt: new Date(), reload: async () => {}, ...data }),
}));

const { default: InboxPage } = await import('./InboxPage');
const { INBOX_COUNT_EVENT } = await import('../shell/useInboxCount');

// The Inbox as its own page (the revamp, phase 4c; design/prototype Inbox):
// its count in the title, bulk approval in the header beside Refresh.
describe('Inbox page', () => {
  const open = () =>
    renderScreen(
      <MemoryRouter initialEntries={['/inbox']}>
        <InboxPage />
      </MemoryRouter>,
    );

  it('says how many wait in its title, and offers to approve the ones read cleanly from the header', () => {
    open();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Inbox · 2 waiting');
    const bulk = screen.getByRole('button', { name: 'Approve 1 read cleanly' });
    expect(bulk.closest('.fresh-row')).not.toBeNull();
  });

  it('tells the sidebar how many wait', () => {
    const seen = [];
    const listen = (e) => seen.push(e.detail);
    window.addEventListener(INBOX_COUNT_EVENT, listen);
    open();
    window.removeEventListener(INBOX_COUNT_EVENT, listen);
    expect(seen.at(-1)).toBe(2);
  });
});
