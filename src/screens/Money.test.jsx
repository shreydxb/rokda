import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderScreen } from '../test/renderScreen';
import { ScopeProvider } from '../lib/ScopeContext';
import { CurrencyProvider } from '../lib/CurrencyContext';

vi.mock('../lib/supabaseClient', () => ({ supabase: {} }));
vi.mock('../lib/useHousehold', () => ({
  useHousehold: () => ({ household: { id: 'hh', name: 'Test' }, members: [], me: { id: 'm1' }, loading: false, error: null, reload: async () => {} }),
}));
// The tabs' own content is not what is tested here.
vi.mock('./money/Review', () => ({ default: () => <div>Review</div> }));
// Activity puts a control in the page header, as every rebuilt tab does.
vi.mock('./money/Activity', async () => {
  const { Tools } = await import('./money/MoneyTools');
  return {
    default: () => (
      <div>
        Activity
        <Tools>
          <button type="button">Next month</button>
        </Tools>
      </div>
    ),
  };
});
vi.mock('./money/Budget', () => ({ default: () => <div>Budget</div> }));

const overview = { reload: vi.fn(async () => {}), intake: [], loading: false, errors: {}, loadedAt: new Date() };
const planning = { reload: vi.fn(async () => {}) };
vi.mock('./useOverviewData', () => ({
  useOverviewData: () => ({ loading: overview.loading, refreshing: false, errors: overview.errors, loaded: {}, loadedAt: overview.loadedAt, intake: overview.intake, accounts: [], categories: [], reload: overview.reload }),
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

  const seenWhile = (setup) => {
    const seen = [];
    const listen = (e) => seen.push(e.detail);
    return import('../shell/useInboxCount').then(({ INBOX_COUNT_EVENT }) => {
      window.addEventListener(INBOX_COUNT_EVENT, listen);
      setup();
      renderScreen(
        <MemoryRouter initialEntries={['/money']}>
          <Money />
        </MemoryRouter>,
      );
      window.removeEventListener(INBOX_COUNT_EVENT, listen);
      overview.loading = false;
      overview.errors = {};
      overview.intake = [];
      return seen;
    });
  };

  // The fresh review of the revamp's shell: a count Money does not know
  // must not be announced.
  it('says nothing while its records load', async () => {
    const seen = await seenWhile(() => {
      overview.loading = true;
      overview.intake = [{ id: 'a', status: 'pending' }];
    });
    expect(seen).toEqual([]);
  });

  it('says nothing when the Inbox could not be read', async () => {
    const seen = await seenWhile(() => {
      overview.errors = { intake: 'network' };
    });
    expect(seen).toEqual([]);
  });

  // Each read says the count again, even when it has not changed, so the
  // sidebar settles on Money's figure rather than an older one of its own.
  it('says the count again after every read', async () => {
    const { INBOX_COUNT_EVENT } = await import('../shell/useInboxCount');
    overview.intake = [{ id: 'a', status: 'pending' }];
    const seen = [];
    const listen = (e) => seen.push(e.detail);
    window.addEventListener(INBOX_COUNT_EVENT, listen);
    const view = renderScreen(
      <MemoryRouter initialEntries={['/money']}>
        <Money />
      </MemoryRouter>,
    );
    overview.loadedAt = new Date(Date.now() + 60_000);
    // Re-rendered inside the same providers renderScreen uses.
    view.rerender(
      <ScopeProvider>
        <CurrencyProvider>
          <MemoryRouter initialEntries={['/money']}>
            <Money />
          </MemoryRouter>
        </CurrencyProvider>
      </ScopeProvider>,
    );
    window.removeEventListener(INBOX_COUNT_EVENT, listen);
    overview.intake = [];
    expect(seen).toEqual([1, 1]);
  });
});

// The revamp, phase 4 (design/prototype): each tab's controls sit in the page
// header beside Refresh, and the month is shared by the tabs.
describe('Money: the header and the month', () => {
  function Where() {
    return <output data-testid="where">{useLocation().search}</output>;
  }

  it("puts the tab's controls in the page header", () => {
    renderScreen(
      <MemoryRouter initialEntries={['/money']}>
        <Money />
      </MemoryRouter>,
    );
    const control = screen.getByRole('button', { name: 'Next month' });
    expect(control.closest('.fresh-row')).not.toBeNull();
    expect(screen.getAllByRole('button', { name: 'Next month' })).toHaveLength(1);
  });

  it('keeps the month when another tab is opened', () => {
    renderScreen(
      <MemoryRouter initialEntries={['/money?month=2026-09&cat=c1']}>
        <Where />
        <Money />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Budget' }));
    expect(screen.getByTestId('where').textContent).toBe('?tab=budget&month=2026-09');
  });

  // The fresh review of 4a: a link into Activity names its month as a range.
  it("keeps a link's month when another tab is opened", () => {
    renderScreen(
      <MemoryRouter initialEntries={['/money?tab=activity&cat=c1&from=2026-09-01&to=2026-09-30']}>
        <Where />
        <Money />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Budget' }));
    expect(screen.getByTestId('where').textContent).toBe('?tab=budget&month=2026-09');
  });
});
