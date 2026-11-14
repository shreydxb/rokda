import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderScreen } from '../test/renderScreen';

vi.mock('../lib/supabaseClient', () => ({ supabase: {} }));
vi.mock('../lib/useHousehold', () => ({
  useHousehold: () => ({ household: { id: 'hh', name: 'Test' }, members: [], me: { id: 'm1' }, loading: false, error: null, reload: async () => {} }),
}));
// The tabs' own content is not what is tested here.
vi.mock('./money/Review', () => ({ default: () => <div>Review</div> }));
vi.mock('./money/Activity', () => ({ default: () => <div>Activity</div> }));

const overview = { reload: vi.fn(async () => {}), intake: [] };
const planning = { reload: vi.fn(async () => {}) };
vi.mock('./useOverviewData', () => ({
  useOverviewData: () => ({ loading: false, refreshing: false, errors: {}, loaded: {}, loadedAt: new Date(), intake: overview.intake, accounts: [], categories: [], reload: overview.reload }),
}));
vi.mock('./usePlanningData', () => ({
  usePlanningData: () => ({ loading: false, refreshing: false, errors: { goals: 'network' }, loaded: {}, reload: planning.reload }),
}));

const { default: Money } = await import('./Money');

// Round 2 of the outside review, E2-9: on Money -> Review, a failed read of
// the goals was reported, but Try again and Refresh re-read only Money's own
// records, so the failure stayed until the page was opened again.
describe('Money -> Review: reading again', () => {
  beforeEach(() => {
    overview.reload.mockClear();
    planning.reload.mockClear();
  });

  const open = () =>
    renderScreen(
      <MemoryRouter initialEntries={['/money?tab=review']}>
        <Money />
      </MemoryRouter>,
    );

  it('Try again reads the planning records again too', async () => {
    open();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Try again' })));
    expect(planning.reload).toHaveBeenCalled();
  });

  it('Refresh reads the planning records again too', async () => {
    open();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh' })));
    expect(planning.reload).toHaveBeenCalled();
  });

  // Only the review tab uses them; elsewhere they are not read at all.
  it('Refresh on another tab leaves them alone', async () => {
    renderScreen(
      <MemoryRouter initialEntries={['/money']}>
        <Money />
      </MemoryRouter>,
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh' })));
    expect(overview.reload).toHaveBeenCalled();
    expect(planning.reload).not.toHaveBeenCalled();
  });
});

// The revamp (review N1): the sidebar shows the Inbox's count. Money already
// has the Inbox's items, so it says how many wait whenever that changes, and
// the sidebar follows at once after an approval.
describe('Money: the Inbox count for the sidebar', () => {
  it('announces how many items wait', async () => {
    const { INBOX_COUNT_EVENT } = await import('../shell/useInboxCount');
    overview.intake = [{ id: 'a', status: 'pending' }, { id: 'b', status: 'approved' }, { id: 'c', status: 'pending' }];
    const seen = [];
    const listen = (e) => seen.push(e.detail);
    window.addEventListener(INBOX_COUNT_EVENT, listen);
    renderScreen(
      <MemoryRouter initialEntries={['/money']}>
        <Money />
      </MemoryRouter>,
    );
    window.removeEventListener(INBOX_COUNT_EVENT, listen);
    overview.intake = [];
    expect(seen.at(-1)).toBe(2);
  });
});
