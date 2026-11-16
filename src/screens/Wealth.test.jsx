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
// Net worth puts a control in the page header, as every rebuilt tab does.
vi.mock('./wealth/NetWorth', async () => {
  const { Tools } = await import('./PageTools');
  return {
    default: () => (
      <div>
        Net worth content
        <Tools>
          <button type="button">By type</button>
        </Tools>
      </div>
    ),
  };
});
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

// The revamp, phase 5a (design note: Wealth): the accounts are Net worth's
// ledger, and each tab's controls sit in the page header.
describe('Wealth: Net worth holds the accounts', () => {
  it('has Net worth, Investments and Dividends, and no Accounts tab', () => {
    openAt('/wealth');
    expect(screen.getAllByRole('button', { name: /^(Net worth|Investments|Dividends|Accounts)$/ }).map((b) => b.textContent)).toEqual(['Net worth', 'Investments', 'Dividends']);
  });

  it('opens an old Accounts link as Net worth', () => {
    openAt('/wealth?tab=accounts');
    expect(screen.getByText('Net worth content')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Net worth' }).getAttribute('aria-current')).toBe('page');
  });

  it("puts the tab's controls in the page header", () => {
    openAt('/wealth');
    expect(screen.getByRole('button', { name: 'By type' }).closest('.fresh-row')).not.toBeNull();
  });
});
