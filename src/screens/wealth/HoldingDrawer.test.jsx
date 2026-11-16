import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { act, useState } from 'react';
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom';
import { renderScreen } from '../../test/renderScreen';
import { ScopeProvider } from '../../lib/ScopeContext';
import { CurrencyProvider } from '../../lib/CurrencyContext';

// The holding drawer (the revamp, phase 5b; design/prototype openHolding): a
// holding opened through the address, `?holding=`, from Investments' table
// or a link on another page (To do's Update price), on Details, Trades or
// Dividends (`&view=`). `?holding=new` adds one.
const writes = [];
let rpcAnswers = {};
// Whether a filtered update finds its row: off, the row changed after the
// drawer opened it, and the save is refused.
let updateFinds = false;
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    rpc: async (name) => ({ data: rpcAnswers[name] ?? null, error: null }),
    from(table) {
      const record = (op) => (payload) => {
        writes.push({ table, op, payload });
        // select() reports the rows a filtered update changed: none, as when
        // the row changed after the drawer opened it.
        const chain = {
          in: () => chain,
          eq: () => chain,
          select: () => Promise.resolve({ data: updateFinds ? [{ id: 'row' }] : [], error: null }),
          then: (resolve) => resolve({ error: null }),
        };
        return chain;
      };
      return { update: record('update'), insert: record('insert'), upsert: record('upsert'), delete: record('delete') };
    },
  },
}));

const { default: HoldingDrawer } = await import('./HoldingDrawer');

afterEach(() => {
  writes.length = 0;
  rpcAnswers = {};
  updateFinds = false;
});

const MEMBERS = [{ id: 'm1', display_name: 'Alex' }];
const AAPL = { id: 'h2', name: 'AAPL', asset_class: 'us_equity', currency: 'USD', is_shared: false, owner_member_id: 'm1', value_aed: 20000, invested_value_aed: 15000, day_change_pct: 2, priced_at: '2026-09-09T00:00:00Z' };
const GOLD = { id: 'h5', name: 'Gold', asset_class: 'commodity', currency: 'USD', is_shared: true, value_aed: 5000, priced_at: '2026-09-09T00:00:00Z' };
const ABC = { ...AAPL, id: 'h7', name: 'ABC', quantity: 9, avg_price: 110, trades_version: 3 };
const TRADES = [
  { id: 't-open', holding_id: 'h7', kind: 'opening', trade_date: '2026-10-27', traded_at: null, created_at: '2026-10-27T08:00:00Z', units: 10, price: 100, fees: 0, tax_withheld: 0, tax_to_confirm: false, realised: null },
  { id: 't-sell', holding_id: 'h7', kind: 'sell', trade_date: '2026-10-29', traded_at: null, created_at: '2026-10-29T08:00:00Z', units: 1, price: 150, fees: 0, tax_withheld: 0, tax_to_confirm: false, realised: 40, funds_account_id: 'f-usd' },
];

function Where() {
  const location = useLocation();
  const type = useNavigationType();
  return (
    <>
      <output data-testid="where">{location.pathname + location.search}</output>
      <output data-testid="type">{type}</output>
    </>
  );
}
const where = () => screen.getByTestId('where').textContent;

const dataFor = (holdings, extra = {}) => ({ holdings, holdingHistory: [], holdingTrades: TRADES, holdingDividends: [], dividendSpecialParts: [], accounts: [], reload: vi.fn().mockResolvedValue(undefined), ...extra });

function tree(entries, data, initialIndex) {
  return (
    <MemoryRouter initialEntries={entries} initialIndex={initialIndex}>
      <Where />
      <HoldingDrawer household={{ id: 'hh' }} members={MEMBERS} data={data} />
    </MemoryRouter>
  );
}
function open(entry, data = dataFor([AAPL, GOLD, ABC])) {
  return renderScreen(tree([entry], data));
}
const tabs = () => within(screen.getByRole('tablist')).getAllByRole('tab');
const chosenTab = () => tabs().find((t) => t.getAttribute('aria-selected') === 'true').textContent;
const nameField = () => screen.getByPlaceholderText('e.g. VWRA');

describe('the holding drawer', () => {
  it('opens the holding the address names on its details, its trades and dividends a tab away', () => {
    open('/wealth?tab=investments&holding=h2');
    const dialog = screen.getByRole('dialog', { name: 'AAPL' });
    expect(dialog.textContent).toContain('Holding · US equity');
    expect(tabs().map((t) => t.textContent)).toEqual(['Details', 'Trades', 'Dividends']);
    expect(chosenTab()).toBe('Details');
    expect(nameField().value).toBe('AAPL');
  });

  it('opens on the tab the address names, and a tab chosen replaces the address', () => {
    open('/wealth?tab=investments&holding=h7&view=trades');
    expect(chosenTab()).toBe('Trades');
    expect(screen.getByRole('button', { name: 'Record a trade' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Dividends' }));
    expect(where()).toBe('/wealth?tab=investments&holding=h7&view=dividends');
    expect(screen.getByTestId('type').textContent).toBe('REPLACE');
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
    expect(where()).toBe('/wealth?tab=investments&holding=h7');
  });

  // One editor behind the three tabs: a look at the trades doesn't cost what
  // was typed in the details.
  it('keeps what was typed in its details while another tab is looked at', () => {
    open('/wealth?tab=investments&holding=h2');
    fireEvent.change(nameField(), { target: { value: 'AAPL renamed' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Trades' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
    expect(nameField().value).toBe('AAPL renamed');
    expect(screen.getByRole('dialog').textContent).toContain('Unsaved');
  });

  it('asks before closing with changes unsaved, from any tab', () => {
    open('/wealth?tab=investments&holding=h2');
    fireEvent.change(nameField(), { target: { value: 'AAPL renamed' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Trades' }));
    // The footer's Close; the × beside the title does the same.
    fireEvent.click(within(document.querySelector('.ds-drawer-foot')).getByRole('button', { name: 'Close' }));
    expect(screen.getByText('Discard changes?')).toBeTruthy();
    expect(where()).toContain('holding=h2');
  });

  it('says a holding with no trade history has none yet, and a class that pays none has no dividends', () => {
    open('/wealth?tab=investments&holding=h5&view=trades');
    expect(screen.getByText('No trade history yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Dividends' }));
    expect(screen.getByText('No dividends')).toBeTruthy();
  });

  it('adds a holding from ?holding=new, with no tabs', () => {
    open('/wealth?tab=investments&holding=new');
    expect(screen.getByRole('dialog', { name: 'Add a holding' })).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add holding' })).toBeTruthy();
  });

  it('opens nothing for a holding the data does not have', () => {
    open('/wealth?tab=investments&holding=nowhere');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // Closing leaves the page as it was under the drawer: back, when the page
  // opened it, so Back then leaves the page; the address replaced when a link
  // did.
  it('closes to the page under it, back when the page opened it, the address replaced when a link did', () => {
    open('/wealth?tab=investments&holding=h2');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(where()).toBe('/wealth?tab=investments');
    expect(screen.getByTestId('type').textContent).toBe('REPLACE');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('goes back when the page opened it', () => {
    renderScreen(tree(['/wealth?tab=investments', { pathname: '/wealth', search: '?tab=investments&holding=h2', state: { drawer: true } }], dataFor([AAPL]), 1));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(where()).toBe('/wealth?tab=investments');
    expect(screen.getByTestId('type').textContent).toBe('POP');
  });
});

describe('the holding drawer and the data under it', () => {
  // The drawer gets the row the page loaded. Without a reload, opening it
  // again after a refusal would hand it the same old row, refused again.
  it('reads the data afresh after a refused save', async () => {
    const data = dataFor([AAPL]);
    open('/wealth?tab=investments&holding=h2', data);
    fireEvent.change(nameField(), { target: { value: 'AAPL renamed' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    });
    expect(screen.getByText(/changed or was removed after you opened it/)).toBeTruthy();
    expect(data.reload).toHaveBeenCalledTimes(1);
  });

  it('leaves an open drawer alone when a background refresh moves the holding', () => {
    const { rerender } = open('/wealth?tab=investments&holding=h7', dataFor([ABC]));
    fireEvent.change(nameField(), { target: { value: 'ABC renamed' } });
    // The five-minute refresh brings a trade made in Telegram meanwhile.
    rerender(
      <ScopeProvider>
        <CurrencyProvider>{tree(['/ignored'], dataFor([{ ...ABC, quantity: 6, trades_version: 4 }]))}</CurrencyProvider>
      </ScopeProvider>,
    );
    expect(screen.getByRole('dialog', { name: 'ABC' })).toBeTruthy();
    expect(nameField().value).toBe('ABC renamed');
    expect(screen.getByLabelText('Units').value).toBe('9');
  });

  it('opens afresh on the new figures after a trade made in it', async () => {
    rpcAnswers = {
      preview_delete_trade: { ok: true, trade_id: 't-sell', trades_version: 4, units_before: 9, holding_units_after: 10, funds_account_id: 'f-usd', funds_delta: -150 },
      delete_trade: { ok: true, trade_id: 't-sell', trades_version: 4 },
    };
    // The page as the app has it: a reload replaces the data it was given.
    function Harness() {
      const [holding, setHolding] = useState(ABC);
      return tree(['/wealth?tab=investments&holding=h7&view=trades'], dataFor([holding], { reload: async () => setHolding({ ...ABC, quantity: 10, trades_version: 4 }) }));
    }
    renderScreen(<Harness />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete Sell 1 at USD 150.00' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete trade' }));
    });
    expect(screen.getByRole('dialog', { name: 'ABC' })).toBeTruthy();
    expect(chosenTab()).toBe('Trades');
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
    expect(screen.getByLabelText('Units').value).toBe('10');
  });

  // Round 2 of the outside review, E2-5: a holding deleted elsewhere while
  // it is open keeps its draft and says why.
  it('keeps the drawer and its draft when the holding is deleted elsewhere', () => {
    const { rerender } = open('/wealth?tab=investments&holding=h2', dataFor([AAPL]));
    fireEvent.change(nameField(), { target: { value: 'AAPL renamed' } });
    rerender(
      <ScopeProvider>
        <CurrencyProvider>{tree(['/ignored'], dataFor([]))}</CurrencyProvider>
      </ScopeProvider>,
    );
    expect(screen.getByRole('dialog', { name: 'AAPL' })).toBeTruthy();
    expect(nameField().value).toBe('AAPL renamed');
    expect(screen.getAllByRole('alert').some((a) => /deleted elsewhere/.test(a.textContent))).toBe(true);
    // Nothing is offered that would act on a holding that is gone: only
    // closing (the fresh review of PR 5).
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Dividends' }));
    expect(screen.getByRole('button', { name: 'Add a dividend' }).disabled).toBe(true);
    // Enter in a field submits the form even with no Save button to press.
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
    const before = writes.length;
    fireEvent.submit(document.querySelector('form.te-form'));
    expect(writes.length).toBe(before);
  });
});

// The fresh review of 5b: the drawer read the data again before closing, so
// for that second Save and Delete stayed live; pressed again, the holding was
// saved twice and the second close went back past the page, out of Wealth.
// It closes at once, then the page reads the data again.
describe('the holding drawer after a save or a delete', () => {
  const fromPage = (data) => tree(['/wealth?tab=investments', { pathname: '/wealth', search: '?tab=investments&holding=h2', state: { drawer: true } }], data, 1);
  const pending = () => {
    let finish;
    const reload = vi.fn(() => new Promise((resolve) => (finish = resolve)));
    return { reload, finish: () => finish() };
  };

  it('closes at once on a save, before the data is read again', async () => {
    updateFinds = true;
    const { reload, finish } = pending();
    renderScreen(fromPage(dataFor([AAPL], { reload })));
    fireEvent.change(nameField(), { target: { value: 'AAPL renamed' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(where()).toBe('/wealth?tab=investments');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(writes.filter((w) => w.op === 'update')).toHaveLength(1);
    await act(async () => finish());
    expect(where()).toBe('/wealth?tab=investments');
  });

  it('closes at once on a delete, never calling the holding deleted elsewhere', async () => {
    const { reload, finish } = pending();
    renderScreen(fromPage(dataFor([AAPL], { reload })));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm delete?' }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(/deleted elsewhere/)).toBeNull();
    await act(async () => finish());
    expect(where()).toBe('/wealth?tab=investments');
  });
});
