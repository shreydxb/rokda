import { describe, it, expect, vi } from 'vitest';
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
vi.mock('./money/MonthEnd', () => ({ default: () => <div>Month end content</div> }));
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

// Month end takes Review's place (the revamp, phase 4d): an old link or
// bookmark to the review opens it, for the same month.
describe('Money -> Month end', () => {
  function Where() {
    return <output data-testid="where">{useLocation().search}</output>;
  }

  it('opens an old Review link as Month end, and has no Review tab', () => {
    renderScreen(
      <MemoryRouter initialEntries={['/money?tab=review&month=2026-10']}>
        <Where />
        <Money />
      </MemoryRouter>,
    );
    expect(screen.getByText('Month end content')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Month end' }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
    expect(screen.getByTestId('where').textContent).toBe('?tab=review&month=2026-10');
  });

  // The goals were read only for the review's What to do next, which left
  // with it (the design note: its goal set-asides are on Overview's To do).
  it('reads no planning records on Month end', async () => {
    renderScreen(
      <MemoryRouter initialEntries={['/money?tab=monthend']}>
        <Money />
      </MemoryRouter>,
    );
    expect(screen.getByText('Month end content')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh' })));
    expect(overview.reload).toHaveBeenCalled();
    expect(planning.reload).not.toHaveBeenCalled();
    expect(screen.queryByText('Couldn’t load goals.')).toBeNull();
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

  // Insights is gone (the revamp, phase 4b): its merchants are Activity's
  // Merchants view, and an old link or bookmark opens it for its month.
  it('opens an old Insights link as Activity\'s Merchants for the same month', () => {
    renderScreen(
      <MemoryRouter initialEntries={['/money?tab=insights&month=2026-09']}>
        <Where />
        <Money />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('where').textContent).toBe('?tab=activity&view=merchants&month=2026-09');
    expect(screen.queryByRole('button', { name: 'Insights' })).toBeNull();
  });

  // The Inbox is its own page (the revamp, phase 4c): an old link to Money's
  // Inbox tab opens it.
  it('opens an old Inbox tab link as the Inbox page', () => {
    function Path() {
      return <output data-testid="path">{useLocation().pathname}</output>;
    }
    renderScreen(
      <MemoryRouter initialEntries={['/money?tab=inbox']}>
        <Path />
        <Money />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('path').textContent).toBe('/inbox');
    expect(screen.queryByRole('button', { name: /^Inbox/ })).toBeNull();
  });
});
