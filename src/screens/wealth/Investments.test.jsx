import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/dom';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';
import { householdToday } from '../../lib/day';
import { ScopeProvider } from '../../lib/ScopeContext';
import { CurrencyProvider } from '../../lib/CurrencyContext';

// Any write at all would be a defect here, so the mock records every call.
const writes = [];
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from(table) {
      const record = (op) => (payload) => {
        writes.push({ table, op, payload });
        // Filters chain as on the real client. select() reports the rows a
        // filtered update changed: none, as when the row changed after the
        // tab loaded it.
        const chain = {
          in: () => chain,
          eq: () => chain,
          select: () => Promise.resolve({ data: [], error: null }),
          then: (resolve) => resolve({ error: null }),
        };
        return chain;
      };
      return { update: record('update'), insert: record('insert'), upsert: record('upsert'), delete: record('delete') };
    },
  },
}));

const { default: Investments } = await import('./Investments');

const MEMBERS = [{ id: 'm1', display_name: 'Alex' }];
const STALE_HOLDING = {
  id: 'h1',
  name: 'VWRA',
  asset_class: 'intl_equity',
  currency: 'USD',
  is_shared: true,
  value_aed: 10_000,
  priced_at: '2026-01-01T00:00:00Z',
};

// QA-04 / SHR-245: the Refresh button only stamped last_refreshed. It never
// fetched a price, but the staleness detector read that field — so pressing it
// dismissed the warning without repricing anything.
describe('QA-04: Investments reload does not certify prices', () => {
  // The tab's own Reload did what the page's Refresh does; it is gone, and
  // the only button here fetches prices. Nothing on the tab writes a
  // valuation date without fetching one.
  it('has no re-read of its own besides the page Refresh, and writes nothing on its own', () => {
    renderScreen(
      <Investments
        household={{ id: 'h' }}
        members={MEMBERS}
        me={MEMBERS[0]}
        loading={false}
        data={{ holdings: [STALE_HOLDING], holdingHistory: [], reload: vi.fn() }}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh prices' })).toBeTruthy();
    expect(writes).toEqual([]);
  });

  it('says plainly that reloading is not a repricing', () => {
    renderScreen(
      <Investments
        household={{ id: 'h' }}
        members={MEMBERS}
        me={MEMBERS[0]}
        loading={false}
        data={{ holdings: [STALE_HOLDING], holdingHistory: [], reload: vi.fn() }}
      />,
    );
    expect(screen.getByText(/does not fetch prices/i)).toBeTruthy();
    expect(screen.getByText(/Oldest valuation/i)).toBeTruthy();
  });
});

const PRICED_HOLDING = {
  id: 'h2',
  name: 'AAPL',
  asset_class: 'us_equity',
  currency: 'USD',
  is_shared: false,
  value_aed: 20000,
  invested_value_aed: 15000,
  day_change_pct: 2,
  priced_at: '2026-09-09T00:00:00Z',
  owner_member_id: 'm1',
};

describe('Investments: portfolio overview stats', () => {
  it('shows Invested, Profit not yet taken, and Change today', () => {
    renderScreen(
      <Investments
        household={{ id: 'h' }}
        members={MEMBERS}
        me={MEMBERS[0]}
        loading={false}
        data={{ holdings: [PRICED_HOLDING], holdingHistory: [], reload: vi.fn() }}
      />,
    );
    expect(screen.getByText('Invested')).toBeTruthy();
    // Renamed once sales had a figure of their own (SHR-371): this one is
    // only what the holdings still held have gained.
    expect(screen.getByText('Profit not yet taken')).toBeTruthy();
    expect(screen.getByText('Change today')).toBeTruthy();
  });
});

describe('Investments: holdings table shows owner once, not duplicated under the name', () => {
  it('does not repeat the owner in the name cell subtitle', () => {
    renderScreen(
      <Investments
        household={{ id: 'h' }}
        members={MEMBERS}
        me={MEMBERS[0]}
        loading={false}
        data={{ holdings: [PRICED_HOLDING], holdingHistory: [], reload: vi.fn() }}
      />,
    );
    const nameCell = screen.getByText('AAPL').parentElement;
    expect(nameCell.textContent).not.toMatch(/Alex/);
    // The Owner column is the only place the name should appear.
    expect(screen.getAllByText('Alex')).toHaveLength(1);
  });
});

describe('Investments: table currency and % of total', () => {
  it('labels Invested/Value columns with the display currency and shows % of total under Value', () => {
    renderScreen(
      <Investments
        household={{ id: 'h' }}
        members={MEMBERS}
        me={MEMBERS[0]}
        loading={false}
        data={{ holdings: [PRICED_HOLDING], holdingHistory: [], reload: vi.fn() }}
      />,
    );
    expect(screen.getByText('Invested (AED)')).toBeTruthy();
    expect(screen.getByText('Value (AED)')).toBeTruthy();
    expect(screen.getByText(/100%.*of total/)).toBeTruthy();
  });
});

describe('Investments: a refused holding save reads the data afresh', () => {
  // The editor gets the row this tab loaded. Without a reload, opening it
  // again after a refusal would hand it the same old row, refused again.
  it('reloads, so the editor opened again shows what changed', async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    renderScreen(
      <Investments
        household={{ id: 'h' }}
        members={MEMBERS}
        me={MEMBERS[0]}
        loading={false}
        data={{ holdings: [PRICED_HOLDING], holdingHistory: [], reload }}
      />,
    );
    fireEvent.click(document.querySelector('.wl-holdrow'));
    fireEvent.change(screen.getByPlaceholderText('e.g. VWRA'), { target: { value: 'AAPL renamed' } });
    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });
    expect(screen.getByText(/changed or was removed after you opened it/)).toBeTruthy();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

// SHR-371: a holding sold down to nothing keeps its record, apart from the
// holdings still held, and what sales made has a figure of its own.
describe('Investments: sold-out holdings and profit on sales', () => {
  const YEAR = Number(householdToday().slice(0, 4));
  const SOLD = {
    id: 'h3',
    name: 'ABC',
    asset_class: 'us_equity',
    currency: 'USD',
    is_shared: false,
    owner_member_id: 'm1',
    value_aed: 0,
    quantity: 0,
    avg_price: 110,
    trades_version: 4,
    priced_at: '2026-09-09T00:00:00Z',
  };
  const RUPEE = { ...SOLD, id: 'h4', name: 'XYZ', currency: 'INR', asset_class: 'india_equity', quantity: 5, value_aed: 1000 };
  const sale = (id, holding, day, realised, extra = {}) => ({
    id, holding_id: holding.id, kind: 'sell', trade_date: day, traded_at: null, created_at: `${day}T10:00:00Z`,
    units: 1, price: 150, fees: 0, tax_withheld: 0, tax_to_confirm: false, realised, ...extra,
  });
  const render = (holdings, holdingTrades = [], household = { id: 'h' }) =>
    renderScreen(
      <Investments
        household={household}
        members={MEMBERS}
        me={MEMBERS[0]}
        loading={false}
        data={{ holdings, holdingHistory: [], holdingTrades, fxRateHistory: [], reload: vi.fn() }}
      />,
    );
  const tableNames = () => [...document.querySelectorAll('.wl-holdrow td:first-child')].map((td) => td.firstChild.textContent);

  it('puts a sold-out holding under Sold, not in the holdings table', () => {
    render([PRICED_HOLDING, SOLD], [sale('t1', SOLD, `${YEAR}-01-15`, 100)]);
    expect(tableNames()).toEqual(['AAPL']);
    const fold = screen.getByRole('button', { name: 'Sold (1)' });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(new RegExp(`Sold out on 15 Jan ${YEAR}`))).toBeNull();
    fireEvent.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(new RegExp(`Alex · Sold out on 15 Jan ${YEAR}`))).toBeTruthy();
    expect(screen.getByRole('button', { name: /ABC/ })).toBeTruthy();
  });

  it('moves a holding bought again from Sold back to the table', () => {
    render([PRICED_HOLDING, { ...SOLD, quantity: 4, value_aed: 2000 }], [sale('t1', SOLD, `${YEAR}-01-15`, 100)]);
    expect(tableNames()).toEqual(['AAPL', 'ABC']);
    expect(screen.queryByRole('button', { name: /^Sold \(/ })).toBeNull();
  });

  it('shows what sales made this year in AED beside the profit not yet taken', () => {
    render([PRICED_HOLDING, SOLD], [sale('t1', SOLD, `${YEAR}-01-15`, 100)]);
    expect(screen.getByText('Profit not yet taken')).toBeTruthy();
    const stat = screen.getByText('Profit on sales this year').parentElement;
    // A dollar profit at the peg: 100 × 3.6725, shown whole like its neighbours.
    expect(stat.textContent).toContain('+367');
  });

  it('says what tax took, and how many sales still wait for the broker\'s tax', () => {
    render([PRICED_HOLDING, RUPEE], [
      sale('t1', RUPEE, `${YEAR}-01-15`, 2300, { tax_withheld: 230 }),
      sale('t2', RUPEE, `${YEAR}-01-16`, 230, { tax_to_confirm: true }),
    ], { id: 'h', inr_per_aed: 23 });
    const stat = screen.getByText('Profit on sales this year').parentElement;
    expect(stat.textContent).toContain('+110');
    expect(stat.textContent).toContain('after tax +100');
    expect(stat.textContent).toContain('1 sale awaiting the broker’s tax');
  });

  it('leaves out a sale from last year', () => {
    render([PRICED_HOLDING, SOLD], [sale('t1', SOLD, `${YEAR - 1}-12-31`, 100)]);
    const stat = screen.getByText('Profit on sales this year').parentElement;
    expect(stat.textContent).toContain('None this year');
  });

  it('says when this year\'s profit on sales is not known', () => {
    render([PRICED_HOLDING, RUPEE], [sale('t1', RUPEE, `${YEAR}-01-15`, 2300)]);
    const stat = screen.getByText('Profit on sales this year').parentElement;
    expect(stat.textContent).toContain('Not known: a rupee sale has no exchange rate');
  });

  it('shows the Sold fold even when every holding is sold', () => {
    render([SOLD], [sale('t1', SOLD, `${YEAR}-01-15`, 100)]);
    expect(screen.getByText('No holdings')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sold (1)' })).toBeTruthy();
  });
});

describe('Investments: the holding editor after a trade', () => {
  // A trade moves the holding's units and version. The editor stays open on
  // the holding as reloaded, so its figures and trades are the new ones.
  it('keeps the editor open on the reloaded holding after its trades change', () => {
    const abc = { ...PRICED_HOLDING, id: 'h7', name: 'ABC', quantity: 9, avg_price: 110, trades_version: 3 };
    const screenFor = (holding) => (
      <Investments household={{ id: 'h' }} members={MEMBERS} me={MEMBERS[0]} loading={false} data={{ holdings: [holding], holdingHistory: [], holdingTrades: [], accounts: [], reload: vi.fn() }} />
    );
    const { rerender } = renderScreen(screenFor(abc));
    fireEvent.click(document.querySelector('.wl-holdrow'));
    expect(screen.getByLabelText('Units').value).toBe('9');
    // The same tree renderScreen built, so the screen keeps its state.
    rerender(
      <ScopeProvider>
        <CurrencyProvider>{screenFor({ ...abc, quantity: 6, trades_version: 4 })}</CurrencyProvider>
      </ScopeProvider>,
    );
    expect(screen.getByRole('dialog', { name: 'Edit holding' })).toBeTruthy();
    expect(screen.getByLabelText('Units').value).toBe('6');
  });
});
