import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderScreen } from '../../test/renderScreen';
import { householdToday } from '../../lib/day';

// Wealth -> Investments as the prototype lays it out (the revamp, phase 5b;
// design/prototype invKpis, invChart, allocationCard, holdingsCard). The
// holding drawer is HoldingDrawer.test.jsx's.

// Any write at all would be a defect here, so the mock records every call.
const writes = [];
let invoke = async () => ({ data: { ok: true }, error: null });
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    functions: { invoke: (...args) => invoke(...args) },
    from(table) {
      const record = (op) => (payload) => {
        writes.push({ table, op, payload });
        return { eq: async () => ({ error: null }) };
      };
      return { update: record('update'), insert: record('insert'), upsert: record('upsert'), delete: record('delete') };
    },
  },
}));

const { default: Investments } = await import('./Investments');

afterEach(() => {
  writes.length = 0;
  invoke = async () => ({ data: { ok: true }, error: null });
});

const MEMBERS = [{ id: 'm1', display_name: 'Alex' }];
const VWRA = { id: 'h1', name: 'VWRA', asset_class: 'intl_equity', currency: 'USD', is_shared: true, value_aed: 10_000, priced_at: '2026-01-01T00:00:00Z', sector: 'broad' };
const AAPL = {
  id: 'h2', name: 'AAPL', asset_class: 'us_equity', currency: 'USD', is_shared: false, owner_member_id: 'm1', value_aed: 20000, invested_value_aed: 15000,
  quantity: 10, avg_price: 408.5, current_price: 544.6, day_change_pct: 2, priced_at: `${householdToday()}T08:00:00Z`, price_provider: 'twelvedata', price_symbol: 'AAPL', sector: 'technology',
};

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}
const where = () => screen.getByTestId('where').textContent;

function render(holdings, extra = {}, household = { id: 'h' }) {
  const reload = vi.fn().mockResolvedValue(undefined);
  const utils = renderScreen(
    <MemoryRouter initialEntries={['/wealth?tab=investments']}>
      <Where />
      <Investments household={household} members={MEMBERS} me={MEMBERS[0]} loading={false} reloadHousehold={vi.fn()} data={{ holdings, holdingHistory: [], reload, ...extra }} />
    </MemoryRouter>,
  );
  return { ...utils, reload };
}
const kpi = (label) => screen.getByText(label, { selector: 'dt' }).closest('.ds-kpi');
const tableNames = () => [...document.querySelectorAll('.inv-row .inv-name')].map((b) => b.textContent);

// QA-04 / SHR-245: the Refresh button only stamped last_refreshed. It never
// fetched a price, but the staleness detector read that field, so pressing it
// dismissed the warning without repricing anything.
describe('Investments: the prices', () => {
  // The tab's own Reload did what the page's Refresh does; it is gone, and
  // the only button here fetches prices. Nothing on the tab writes a
  // valuation date without fetching one.
  it('has no re-read of its own besides the page Refresh, and writes nothing on its own', () => {
    render([VWRA]);
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh prices' })).toBeTruthy();
    expect(writes).toEqual([]);
  });

  // The stamp's pop-over holds what the footer notes used to say.
  it('says, behind the Prices stamp, how old the prices are and that reloading is not a repricing', () => {
    render([VWRA, AAPL]);
    expect(screen.queryByText(/does not fetch prices/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Prices/ }));
    expect(screen.getByText(/does not fetch prices/)).toBeTruthy();
    expect(screen.getByText(/Oldest valuation 1 Jan/)).toBeTruthy();
    expect(screen.getByText(/1 holding on a live feed/)).toBeTruthy();
  });

  it('counts the stale prices beside the stamp, and opens the first', () => {
    render([VWRA, AAPL]);
    fireEvent.click(screen.getByRole('button', { name: '1 stale' }));
    expect(where()).toBe('/wealth?tab=investments&holding=h1');
  });

  it('says a refresh that failed in a banner, with Try again', async () => {
    invoke = async () => ({ data: null, error: { message: 'Feed unreachable' } });
    const { reload } = render([VWRA, AAPL]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh prices' }));
    });
    const banner = screen.getByRole('alert');
    expect(banner.textContent).toContain('Couldn’t refresh prices: Feed unreachable');
    invoke = async () => ({ data: { ok: true }, error: null });
    await act(async () => {
      fireEvent.click(within(banner).getByRole('button', { name: 'Try again' }));
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('names the holdings whose feed failed', () => {
    render([VWRA, { ...AAPL, price_fetch_error: 'Not found' }]);
    expect(document.querySelector('.ds-banner-warn').textContent).toContain('AAPL didn’t refresh, so its price may be old.');
  });
});

describe('Investments: the figures', () => {
  it('shows Value, Invested, Profit not yet taken, Profit on sales this year and Change today', () => {
    render([AAPL]);
    expect([...document.querySelectorAll('.ds-kpi dt')].map((d) => d.textContent)).toEqual(['Value', 'Invested', 'Profit not yet taken', 'Profit on sales this year', 'Change today']);
    expect(kpi('Value').textContent).toContain('20,000');
    expect(kpi('Profit not yet taken').textContent).toContain('+5,000');
    expect(kpi('Profit not yet taken').textContent).toContain('33.3% on cost');
  });

  // A never-valued holding counts its placeholder 0 (QA #6): the total says
  // it leaves that holding out.
  it('says the value leaves out a holding not valued yet', () => {
    render([AAPL, { ...VWRA, value_aed: 0, priced_at: null }]);
    expect(kpi('Value').textContent).toContain('1 not valued yet');
  });
});

describe('Investments: the holdings table', () => {
  it('lists the holdings largest first, each opening its drawer through the address', () => {
    render([VWRA, AAPL]);
    expect(tableNames()).toEqual(['AAPL', 'VWRA']);
    fireEvent.click(screen.getByRole('button', { name: 'AAPL' }));
    expect(where()).toBe('/wealth?tab=investments&holding=h2');
  });

  it('gives the owner once, as an avatar, not again under the name', () => {
    render([AAPL]);
    const nameCell = screen.getByRole('button', { name: 'AAPL' }).closest('td');
    expect(nameCell.textContent).not.toMatch(/Alex/);
    expect(screen.getAllByRole('img', { name: 'Alex' })).toHaveLength(1);
  });

  it('labels Invested and Value with the display currency, and gives each holding its share of the total', () => {
    render([AAPL]);
    expect(screen.getByRole('columnheader', { name: 'Invested (AED)' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Value (AED)' })).toBeTruthy();
    expect(screen.getByText('100% of total')).toBeTruthy();
  });

  it('gives prices in the holding’s currency, and says which are typed by hand', () => {
    render([AAPL, { ...VWRA, current_price: 98.2 }]);
    const [aapl, vwra] = document.querySelectorAll('.inv-row');
    expect(aapl.textContent).toContain('544.60USD');
    expect(vwra.textContent).toContain('manual');
  });

  it('marks a stale price and a share with no sector', () => {
    render([{ ...AAPL, sector: null, price_fetch_error: 'Not found' }]);
    const row = document.querySelector('.inv-row');
    expect(within(row).getByText('Stale price')).toBeTruthy();
    expect(within(row).getByText('Untagged')).toBeTruthy();
  });
});

describe('Investments: Allocation', () => {
  it('stacks the holdings by asset class, with the largest concentration and its cap', () => {
    render([VWRA, AAPL], {}, { id: 'h', concentration_cap_pct: 25 });
    expect(screen.getByRole('img', { name: /By asset class/ })).toBeTruthy();
    expect(screen.getByText('Above 25% cap')).toBeTruthy();
  });

  // Of everything invested, so only when nothing is filtered out.
  it('leaves the concentration out while a group is chosen', () => {
    render([VWRA, AAPL], {}, { id: 'h', concentration_cap_pct: 25 });
    fireEvent.click(screen.getByRole('button', { name: 'Global' }));
    expect(screen.queryByText(/Largest concentration/)).toBeNull();
  });
});

// The fresh review of B-06: a day that leaves out a holding held then, for
// want of a recorded value, says which, rather than drawing a dip unexplained.
describe('Investments: Value over time', () => {
  const dayAgo = (n) => new Date(Date.parse(`${householdToday()}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
  const vwra = { ...VWRA, created_at: '2020-01-01T00:00:00Z' };

  it('marks a partial history, naming the holdings some days leave out', () => {
    const aapl = { ...AAPL, created_at: '2020-01-01T00:00:00Z' };
    const history = [
      { holding_id: 'h1', as_of: dayAgo(300), value_aed: 9000 },
      { holding_id: 'h1', as_of: dayAgo(0), value_aed: 10000 },
      { holding_id: 'h2', as_of: dayAgo(0), value_aed: 20000 },
    ];
    render([vwra, aapl], { holdingHistory: history });
    fireEvent.click(screen.getByRole('button', { name: '5Y' }));
    expect(screen.getByText('Partial history')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'About Partial history' }));
    expect(screen.getByText(/Some days leave out AAPL, which had no value recorded then/)).toBeTruthy();
    // One explanation beside the title, holding both of the chart's caveats.
    expect(screen.getByText(/money added or withdrawn/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'About Value over time' })).toBeNull();
  });

  // The fresh review of PR 5: a pick kept its position in another range, so
  // another day read as the one picked. A new range starts at today's point
  // (and round 2's E2-4: a pick past the end of a shorter range took the tab
  // down).
  it('reads a day picked, and goes back to today when the range changes', () => {
    const history = [1500, 1200, 900, 600, 300, 120, 60, 30, 3, 1].map((n, i) => ({ holding_id: 'h1', as_of: dayAgo(n), value_aed: 9000 + i * 100 }));
    render([vwra], { holdingHistory: history });
    fireEvent.click(screen.getByRole('button', { name: '5Y' }));
    const readout = () => document.querySelector('.inv-readout').textContent;
    const today = readout();
    // The change over the range first, then today's value (the prototype's
    // readout).
    expect(today).toMatch(/^(Change|No|Not).*Today/);
    const chart = screen.getByRole('group', { name: /Value of the investments/ });
    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    expect(readout()).not.toBe(today);
    expect(readout()).toContain('9,800');
    fireEvent.click(screen.getByRole('button', { name: '1W' }));
    expect(readout()).toContain('Today');
    expect(readout()).not.toContain('9,800');
    expect(document.querySelector('.ds-trend svg')).toBeTruthy();
  });

  it('says why there is no change for the range', () => {
    render([vwra]);
    expect(document.querySelector('.inv-readout').textContent).toContain('No valuation history yet');
  });
});

// SHR-371: a holding sold down to nothing keeps its record, apart from the
// holdings still held, and what sales made has a figure of its own.
describe('Investments: sold-out holdings and profit on sales', () => {
  const YEAR = Number(householdToday().slice(0, 4));
  const SOLD = { id: 'h3', name: 'ABC', asset_class: 'us_equity', currency: 'USD', is_shared: false, owner_member_id: 'm1', value_aed: 0, quantity: 0, avg_price: 110, trades_version: 4, priced_at: '2026-09-09T00:00:00Z' };
  const RUPEE = { ...SOLD, id: 'h4', name: 'XYZ', currency: 'INR', asset_class: 'india_equity', quantity: 5, value_aed: 1000 };
  const sale = (id, holding, day, realised, extra = {}) => ({
    id, holding_id: holding.id, kind: 'sell', trade_date: day, traded_at: null, created_at: `${day}T10:00:00Z`,
    units: 1, price: 150, fees: 0, tax_withheld: 0, tax_to_confirm: false, realised, ...extra,
  });
  const withTrades = (holdings, holdingTrades = [], household = { id: 'h' }) => render(holdings, { holdingTrades, fxRateHistory: [] }, household);
  const sold = () => document.querySelector('.inv-sold');

  it('folds a sold-out holding under Sold, apart from the table, opening it from there', () => {
    withTrades([AAPL, SOLD], [sale('t1', SOLD, `${YEAR}-01-15`, 100)]);
    expect(tableNames()).toEqual(['AAPL']);
    expect(screen.getByText('Sold (1)')).toBeTruthy();
    expect(sold().textContent).toContain(`Alex · sold out on 15 Jan ${YEAR}`);
    fireEvent.click(within(sold()).getByRole('button', { name: /ABC/ }));
    expect(where()).toBe('/wealth?tab=investments&holding=h3');
  });

  it('moves a holding bought again from Sold back to the table', () => {
    withTrades([AAPL, { ...SOLD, quantity: 4, value_aed: 2000 }], [sale('t1', SOLD, `${YEAR}-01-15`, 100)]);
    expect(tableNames()).toEqual(['AAPL', 'ABC']);
    expect(screen.queryByText(/^Sold \(/)).toBeNull();
  });

  it('shows what sales made this year in AED, and how many', () => {
    withTrades([AAPL, SOLD], [sale('t1', SOLD, `${YEAR}-01-15`, 100)]);
    // A dollar profit at the peg: 100 × 3.6725, shown whole like its neighbours.
    expect(kpi('Profit on sales this year').textContent).toContain('+367');
    expect(kpi('Profit on sales this year').textContent).toContain('1 sale');
  });

  it("says what tax took, and how many sales still wait for the broker's tax", () => {
    withTrades([AAPL, RUPEE], [sale('t1', RUPEE, `${YEAR}-01-15`, 2300, { tax_withheld: 230 }), sale('t2', RUPEE, `${YEAR}-01-16`, 230, { tax_to_confirm: true })], { id: 'h', inr_per_aed: 23 });
    const stat = kpi('Profit on sales this year').textContent;
    expect(stat).toContain('+110');
    expect(stat).toContain('after tax +100');
    expect(stat).toContain('1 awaiting the broker’s tax');
  });

  it('leaves out a sale from last year', () => {
    withTrades([AAPL, SOLD], [sale('t1', SOLD, `${YEAR - 1}-12-31`, 100)]);
    expect(kpi('Profit on sales this year').textContent).toContain('None');
  });

  it("says when this year's profit on sales is not known", () => {
    withTrades([AAPL, RUPEE], [sale('t1', RUPEE, `${YEAR}-01-15`, 2300)]);
    expect(kpi('Profit on sales this year').textContent).toContain('a rupee sale has no exchange rate');
  });

  it('says so when trades could not be loaded, instead of none this year', () => {
    render([AAPL, SOLD], { holdingTrades: [], fxRateHistory: [], errors: { holdingTrades: new Error('timeout') }, loaded: {} });
    const stat = kpi('Profit on sales this year').textContent;
    expect(stat).toContain('couldn’t load trades.');
    expect(stat).not.toContain('None');
  });

  it("withholds a rupee sale's profit when exchange rates could not be loaded", () => {
    render([AAPL, RUPEE], { holdingTrades: [sale('t1', RUPEE, `${YEAR}-01-15`, 2300)], fxRateHistory: [], errors: { fxRateHistory: new Error('timeout') }, loaded: { holdingTrades: true } }, { id: 'h', inr_per_aed: 23 });
    expect(kpi('Profit on sales this year').textContent).toContain('couldn’t load exchange-rate history.');
  });

  it('still shows what sales made, and the Sold fold, when every holding in view is sold', () => {
    withTrades([SOLD], [sale('t1', SOLD, `${YEAR}-01-15`, 100)]);
    expect(screen.getByText('No holdings')).toBeTruthy();
    expect(kpi('Profit on sales this year').textContent).toContain('+367');
    expect(screen.getByText('Sold (1)')).toBeTruthy();
  });
});

describe('Investments: nothing to show', () => {
  it('offers to add a first holding', () => {
    render([]);
    expect(screen.getByText('No holdings')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add a holding' }));
    expect(where()).toBe('/wealth?tab=investments&holding=new');
  });

  // Round 2 of the outside review, E2-3: holdings that never loaded are not
  // "No holdings", which invited adding them a second time.
  it('says holdings that never loaded could not load, and offers to try again', () => {
    const { reload } = render([], { errors: { holdings: 'network' }, loaded: {} });
    expect(screen.getByText('Couldn’t load investments.')).toBeTruthy();
    expect(screen.queryByText('No holdings')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reload).toHaveBeenCalled();
  });
});
