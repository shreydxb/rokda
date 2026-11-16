import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderScreen } from '../test/renderScreen';

vi.mock('../lib/supabaseClient', () => ({ supabase: {} }));
vi.mock('../lib/useHousehold', () => ({
  useHousehold: () => ({ household: { id: 'hh', name: 'Test' }, members: [], me: { id: 'm1' }, loading: false, error: null, reload: async () => {} }),
}));
vi.mock('./useOverviewData', () => ({
  useOverviewData: () => ({ loading: false, refreshing: false, errors: {}, loaded: {}, loadedAt: new Date(), accounts: [], reload: async () => {} }),
}));
// The tabs' own content is not what is tested here.
vi.mock('./wealth/NetWorth', () => ({ default: () => <div>Net worth content</div> }));
vi.mock('./wealth/Accounts', () => ({ default: () => <div>Accounts content</div> }));
vi.mock('./wealth/Investments', () => ({ default: () => <div>Investments content</div> }));
vi.mock('./wealth/Dividends', () => ({ default: () => <div>Dividends content</div> }));

const { default: Wealth } = await import('./Wealth');

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

const openAt = (entry) =>
  renderScreen(
    <MemoryRouter initialEntries={[entry]}>
      <Where />
      <Wealth />
    </MemoryRouter>,
  );

// The card statements moved to Money -> Month end (the revamp, phase 4d):
// the running month lists the ones still open, and a month's step 2 the ones
// that closed in it.
describe('Wealth: card statements moved to Month end', () => {
  it('has no Statements tab', () => {
    openAt('/wealth');
    expect(screen.getByText('Net worth content')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Statements' })).toBeNull();
  });

  it('opens an old Statements link as Month end', () => {
    openAt('/wealth?tab=statements');
    expect(screen.getByTestId('where').textContent).toBe('/money?tab=monthend');
  });

  it('opens an old link to one month’s statements on that month’s step 2', () => {
    openAt('/wealth?tab=statements&month=2026-10');
    expect(screen.getByTestId('where').textContent).toBe('/money?tab=monthend&month=2026-10&step=2');
  });
});
