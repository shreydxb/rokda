import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderScreen } from '../test/renderScreen';

vi.mock('../lib/supabaseClient', () => ({ supabase: {} }));
vi.mock('../lib/useHousehold', () => ({
  useHousehold: () => ({ household: { id: 'hh', name: 'Test' }, members: [], me: { id: 'm1' }, loading: false, error: null, reload: async () => {} }),
}));
// The review tab's own content is not what is tested here.
vi.mock('./money/Review', () => ({ default: () => <div>Review</div> }));

const overview = { reload: vi.fn(async () => {}) };
const planning = { reload: vi.fn(async () => {}) };
vi.mock('./useOverviewData', () => ({
  useOverviewData: () => ({ loading: false, refreshing: false, errors: {}, loaded: {}, loadedAt: new Date(), intake: [], accounts: [], categories: [], reload: overview.reload }),
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
});
