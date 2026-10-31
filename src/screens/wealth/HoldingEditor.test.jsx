import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, cleanup, within } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

// A minimal, realistic simulation of the `holdings` table: upsert on `id`
// either inserts (id not present yet) or updates in place (id already
// there) — the same semantics a real `on conflict (id) do update` has.
const db = { holdings: new Map(), histories: [] };
// Column defaults a stored row reads when a test seeds it without them.
const COLUMN_DEFAULTS = { trades_version: 0 };
let historyFailsOnce = false;
// The trade functions, answered per name, every call recorded.
const rpcCalls = [];
let rpcAnswers = {};

vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      const answer = rpcAnswers[name];
      return { data: (typeof answer === 'function' ? answer(args) : answer) ?? null, error: null };
    },
    from: (table) => ({
      // An update applies only to rows matching every .eq() filter, as
      // PostgREST does, and .select() returns the rows it changed: how the
      // editor learns that a trade moved the holding's version first.
      update: (row) => {
        const filters = [];
        const apply = async () => {
          const changed = [];
          if (table === 'holdings') {
            for (const [id, stored] of db.holdings) {
              if (filters.every(([field, value]) => (field in stored ? stored[field] : COLUMN_DEFAULTS[field]) === value)) {
                db.holdings.set(id, { ...stored, ...row });
                changed.push({ id });
              }
            }
          }
          return { data: changed, error: null };
        };
        const builder = {
          eq: (field, value) => {
            filters.push([field, value]);
            return builder;
          },
          select: apply,
          then: (resolve, reject) => apply().then(({ error }) => ({ error })).then(resolve, reject),
        };
        return builder;
      },
      upsert: async (row) => {
        if (table === 'holding_value_history') {
          db.histories.push(row);
          if (historyFailsOnce) {
            historyFailsOnce = false;
            return { error: { message: 'Injected history failure' } };
          }
          return { error: null };
        }
        db.holdings.set(row.id, { ...db.holdings.get(row.id), ...row });
        return { error: null };
      },
    }),
  },
}));

const { default: HoldingEditor } = await import('./HoldingEditor');

beforeEach(() => {
  rpcCalls.length = 0;
  rpcAnswers = {};
  db.holdings.clear();
  db.histories.length = 0;
  historyFailsOnce = false;
});

// Ported from the QA recheck (SHR-246): the holding save and its history
// point used to be separate requests. If the history write failed and the
// reviewer retried Add holding, the retry inserted a second holding row,
// double-counting wealth. A stable id upserted on retry must make this
// idempotent instead.
describe('SHR-246: retrying after a failed history write', () => {
  it('does not create a second holding', async () => {
    historyFailsOnce = true;
    renderScreen(<HoldingEditor holding={null} householdId="hh" members={[]} onClose={() => {}} onSaved={async () => {}} />);

    fireEvent.change(screen.getByPlaceholderText('e.g. VWRA'), { target: { value: 'QA synthetic fund' } });
    fireEvent.change(document.querySelector('.te-hero-input'), { target: { value: '100' } });

    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });
    expect(screen.getByRole('alert').textContent).toContain('Injected history failure');
    expect(db.holdings.size).toBe(1);

    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });
    expect(db.holdings.size).toBe(1);

    cleanup();
  });
});

// QA #6: selecting a provider, units and a supported currency disables the
// value field. Saving then turned the blank field into 0, stamped priced_at
// and wrote a zero history point -- so a holding with a real cost basis
// showed a fresh 100% loss, and a failed price refresh left that false zero
// in place permanently, its fresh timestamp suppressing the "never valued"
// warning.
describe('QA #6: a new auto-priced holding is pending, not worth zero', () => {
  function fillAutoPricedForm() {
    fireEvent.change(screen.getByPlaceholderText('e.g. VWRA'), { target: { value: 'QA synthetic ETF' } });
    fireEvent.change(document.querySelector('select.te-fieldvalue'), { target: { value: 'us_equity' } });
    // Provider + units + a convertible currency is what disables the value
    // field. USD is the form's default for a new holding.
    const selects = [...document.querySelectorAll('select.te-fieldvalue')];
    const providerSelect = selects.find((s) => [...s.options].some((o) => o.value === 'twelvedata'));
    fireEvent.change(providerSelect, { target: { value: 'twelvedata' } });
    fireEvent.change(document.querySelectorAll('input[type="number"][step="any"]')[0], { target: { value: '10' } });
    // A provider without its symbol fails validation before save is reached.
    fireEvent.change(screen.getByPlaceholderText('e.g. AAPL'), { target: { value: 'VWRA' } });
  }

  it('leaves the value field disabled and records no valuation date', async () => {
    renderScreen(<HoldingEditor holding={null} householdId="hh" members={[]} onClose={() => {}} onSaved={async () => {}} />);
    fillAutoPricedForm();

    expect(document.querySelector('.te-hero-input').disabled).toBe(true);
    expect(document.querySelector('.te-hero-input').placeholder).toBe('Awaiting first price');

    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });

    expect(db.holdings.size).toBe(1);
    const saved = [...db.holdings.values()][0];
    // priced_at absent is what every reader already treats as "never valued".
    expect(saved.priced_at).toBeUndefined();
    // And nothing was written to history: a zero point there would sit in the
    // chart and in portfolioValueChange's range start for good.
    expect(db.histories).toHaveLength(0);

    cleanup();
  });

  it('still confirms and records history for a manually valued holding', async () => {
    renderScreen(<HoldingEditor holding={null} householdId="hh" members={[]} onClose={() => {}} onSaved={async () => {}} />);
    fireEvent.change(screen.getByPlaceholderText('e.g. VWRA'), { target: { value: 'QA manual fund' } });
    fireEvent.change(document.querySelector('.te-hero-input'), { target: { value: '10000' } });

    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });

    const saved = [...db.holdings.values()][0];
    expect(saved.priced_at).toBeTruthy();
    expect(db.histories).toHaveLength(1);
    expect(db.histories[0].value_aed).toBe(10000);

    cleanup();
  });

  it('records an intentional zero as a real valuation', async () => {
    // Typing 0 into an enabled field is an assertion; a blank disabled field
    // is not. The fix must not take the ability to say "this is worth
    // nothing" away.
    renderScreen(<HoldingEditor holding={null} householdId="hh" members={[]} onClose={() => {}} onSaved={async () => {}} />);
    fireEvent.change(screen.getByPlaceholderText('e.g. VWRA'), { target: { value: 'QA written-off holding' } });
    fireEvent.change(document.querySelector('.te-hero-input'), { target: { value: '0' } });

    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });

    const saved = [...db.holdings.values()][0];
    expect(saved.value_aed).toBe(0);
    expect(saved.priced_at).toBeTruthy();
    expect(db.histories).toHaveLength(1);

    cleanup();
  });
});

// A holding's cost is units × average price, worked out by the database at the
// peg or the current rupee rate. The editor must not offer a cost box the save
// would silently overwrite, and must still offer one for a holding without
// units.
describe('cost from units', () => {
  const unitInputs = () => document.querySelectorAll('input[type="number"][step="any"]');

  it('replaces the cost box once units and an average price are entered', () => {
    renderScreen(<HoldingEditor holding={null} householdId="hh" members={[]} onClose={() => {}} onSaved={async () => {}} />);
    expect(screen.queryByTestId('invested-from-units')).toBeNull();
    expect(document.querySelector('input.te-fieldvalue[step="0.01"]')).not.toBeNull();

    fireEvent.change(unitInputs()[0], { target: { value: '10' } });
    expect(screen.queryByTestId('invested-from-units')).toBeNull();
    fireEvent.change(unitInputs()[1], { target: { value: '100' } });
    expect(screen.getByTestId('invested-from-units').textContent).toMatch(/Units × avg price/);
    expect(document.querySelector('input.te-fieldvalue[step="0.01"]')).toBeNull();
    cleanup();
  });

  it('keeps the cost box for a currency the database cannot convert', () => {
    renderScreen(<HoldingEditor holding={null} householdId="hh" members={[]} onClose={() => {}} onSaved={async () => {}} />);
    fireEvent.change(document.querySelector('input[maxlength="3"]'), { target: { value: 'GBP' } });
    fireEvent.change(unitInputs()[0], { target: { value: '10' } });
    fireEvent.change(unitInputs()[1], { target: { value: '100' } });
    expect(screen.queryByTestId('invested-from-units')).toBeNull();
    expect(document.querySelector('input.te-fieldvalue[step="0.01"]')).not.toBeNull();
    cleanup();
  });
});


// A holding's sector is tagged once, for Wealth's concentration line
// (Planning audit, 4.17). Only shares and share funds have one.
describe('sector', () => {
  const holding = { id: 'h1', name: 'Chip fund', asset_class: 'us_equity', currency: 'USD', value_aed: 5000, is_shared: true, priced_at: '2026-09-01T00:00:00Z' };

  it('is saved with the holding, and changing it is not a new valuation', async () => {
    db.holdings.set('h1', { ...holding });
    renderScreen(<HoldingEditor holding={holding} householdId="hh" members={[]} onClose={() => {}} onSaved={async () => {}} />);
    expect(screen.getByLabelText('Sector').value).toBe('');
    fireEvent.change(screen.getByLabelText('Sector'), { target: { value: 'technology' } });
    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });
    expect(db.holdings.get('h1').sector).toBe('technology');
    expect(db.holdings.get('h1').priced_at).toBe('2026-09-01T00:00:00Z');
    expect(db.histories).toHaveLength(0);
    cleanup();
  });

  it("offers the market sectors and an Indian broker's, and saves the broker's", async () => {
    const indian = { ...holding, id: 'h2', name: 'BEL', asset_class: 'india_equity', currency: 'INR' };
    db.holdings.set('h2', { ...indian });
    renderScreen(<HoldingEditor holding={indian} householdId="hh" members={[]} onClose={() => {}} onSaved={async () => {}} />);
    const groups = [...screen.getByLabelText('Sector').querySelectorAll('optgroup')].map((g) => g.label);
    expect(groups).toEqual(['Market sectors', "Indian broker's sectors"]);
    fireEvent.change(screen.getByLabelText('Sector'), { target: { value: 'defence' } });
    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });
    expect(db.holdings.get('h2').sector).toBe('defence');
    cleanup();
  });

  it('is not asked for gold, and a holding moved to it loses its sector', async () => {
    db.holdings.set('h1', { ...holding, sector: 'technology' });
    renderScreen(<HoldingEditor holding={{ ...holding, sector: 'technology' }} householdId="hh" members={[]} onClose={() => {}} onSaved={async () => {}} />);
    expect(screen.getByLabelText('Sector').value).toBe('technology');
    fireEvent.change(document.querySelector('select.te-fieldvalue'), { target: { value: 'commodity' } });
    expect(screen.queryByLabelText('Sector')).toBeNull();
    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });
    expect(db.holdings.get('h1').sector).toBeNull();
    cleanup();
  });
});

// Once a holding has its opening entry, its units and average price come
// only from its trades; the database refuses a hand edit (SHR-367). The
// editor shows them read-only and never sends them.
describe('a traded holding', () => {
  const traded = { id: 'h3', name: 'ABC', asset_class: 'us_equity', currency: 'USD', quantity: 10, avg_price: 100, value_aed: 3672.5, is_shared: true, priced_at: '2026-09-01T00:00:00Z', trades_version: 1 };

  it('shows units and average read-only and leaves them out of the save', async () => {
    // The stored row starts without units or an average, so any that appear
    // after saving were sent by the editor.
    db.holdings.set('h3', { id: 'h3', name: 'ABC', trades_version: 1 });
    renderScreen(<HoldingEditor holding={traded} householdId="hh" members={[]} onClose={() => {}} onSaved={async () => {}} />);
    expect(screen.getByLabelText('Units').readOnly).toBe(true);
    expect(screen.getByLabelText(/^Avg price/).readOnly).toBe(true);
    expect(screen.getByText("Units and average price come from this holding’s trades.")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('e.g. VWRA'), { target: { value: 'ABC renamed' } });
    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });
    expect(db.holdings.get('h3').name).toBe('ABC renamed');
    expect(db.holdings.get('h3')).not.toHaveProperty('quantity');
    expect(db.holdings.get('h3')).not.toHaveProperty('avg_price');
    cleanup();
  });

  it('refuses a save from before a trade, writes nothing, and asks for fresh data', async () => {
    // A trade recorded while the editor was open moved the version to 2.
    db.holdings.set('h4', { ...traded, id: 'h4', trades_version: 2 });
    // The screen hands the editor the row it loaded, so opening it again
    // would be refused again unless that row is read afresh first.
    const onStale = vi.fn().mockResolvedValue(undefined);
    renderScreen(<HoldingEditor holding={{ ...traded, id: 'h4' }} householdId="hh" members={[]} onClose={() => {}} onSaved={async () => {}} onStale={onStale} />);
    fireEvent.change(screen.getByPlaceholderText('e.g. VWRA'), { target: { value: 'ABC renamed' } });
    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });
    expect(db.holdings.get('h4').name).toBe('ABC');
    expect(db.histories).toHaveLength(0);
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(screen.getByText('This holding changed or was removed after you opened it, so nothing was saved. Close it and open it again to see the latest.')).toBeTruthy();
    cleanup();
  });

  it("a traded, auto-priced holding's value is left to the price feed", async () => {
    const priced = { ...traded, id: 'h5', price_provider: 'twelvedata', price_symbol: 'ABC', current_price: 140, quantity: 10 };
    // The feed valued it at 5,000 after the editor loaded it at 4,000.
    db.holdings.set('h5', { ...priced, value_aed: 5000 });
    renderScreen(<HoldingEditor holding={{ ...priced, value_aed: 4000 }} householdId="hh" members={[]} onClose={() => {}} onSaved={async () => {}} />);
    fireEvent.change(screen.getByPlaceholderText('e.g. VWRA'), { target: { value: 'ABC renamed' } });
    // Confirming the value as unchanged would otherwise write the stale 4,000
    // as today's value point.
    fireEvent.click(screen.getByLabelText(/Still worth the same/));
    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });
    expect(db.holdings.get('h5').name).toBe('ABC renamed');
    expect(db.holdings.get('h5').value_aed).toBe(5000);
    expect(db.histories).toHaveLength(0);
    cleanup();
  });

  it('an untraded holding still saves its value as before', async () => {
    const gold = { id: 'h6', name: 'Gold', asset_class: 'commodity', currency: 'AED', value_aed: 1000, is_shared: true, priced_at: '2026-09-01T00:00:00Z', trades_version: 0 };
    db.holdings.set('h6', { ...gold });
    renderScreen(<HoldingEditor holding={gold} householdId="hh" members={[]} onClose={() => {}} onSaved={async () => {}} />);
    fireEvent.change(document.querySelector('.te-hero-input'), { target: { value: '1200' } });
    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });
    expect(db.holdings.get('h6').value_aed).toBe(1200);
    expect(db.histories).toHaveLength(1);
    expect(db.histories[0].value_aed).toBe(1200);
    cleanup();
  });

  it('keeps them editable on a holding without trades', () => {
    renderScreen(<HoldingEditor holding={{ ...traded, trades_version: 0 }} householdId="hh" members={[]} onClose={() => {}} onSaved={async () => {}} />);
    expect(screen.getByLabelText('Units').readOnly).toBe(false);
    expect(screen.queryByText("Units and average price come from this holding’s trades.")).toBeNull();
    cleanup();
  });
});


// SHR-371: a traded holding's editor lists its trades, newest first, and is
// where an older one is fixed or deleted.
describe('a holding\'s trades', () => {
  const abc = { id: 'h3', name: 'ABC', asset_class: 'us_equity', currency: 'USD', quantity: 9, avg_price: 110, value_aed: 3672.5, is_shared: true, priced_at: '2026-09-01T00:00:00Z', trades_version: 3 };
  const t = (id, extra) => ({ id, holding_id: 'h3', kind: 'buy', trade_date: '2026-10-28', traded_at: null, created_at: '2026-10-28T10:00:00Z', units: 5, price: 130, fees: 0, tax_withheld: 0, tax_to_confirm: false, realised: null, ...extra });
  const trades = [
    t('t-open', { kind: 'opening', units: 10, price: 100, trade_date: '2026-10-27', created_at: '2026-10-31T09:00:00Z' }),
    t('t-buy', {}),
    t('t-sell', { kind: 'sell', units: 6, price: 150, fees: 1, realised: 239, trade_date: '2026-10-29' }),
    t('t-other', { holding_id: 'h-other', trade_date: '2026-10-30' }),
  ];
  const ACCOUNTS = [{ id: 'f-usd', name: 'Dollar broker funds', type: 'broker_funds', currency: 'USD', balance: 1000, balance_as_of: '2026-10-01T00:00:00Z', archived_at: null }];
  const open = (holding = abc, list = trades, onTradesChanged = async () => {}) =>
    renderScreen(<HoldingEditor holding={holding} trades={list} accounts={ACCOUNTS} householdId="hh" members={[]} onClose={() => {}} onSaved={async () => {}} onTradesChanged={onTradesChanged} />);
  const DELETE_SELL = { ok: true, trade_id: 't-sell', trades_version: 4, units_before: 9, avg_before: 110, holding_units_after: 15, holding_avg_after: 110, funds_account_id: 'f-usd', funds_delta: -899 };
  const press = async (name) => {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name }));
    });
  };
  const rows = () => within(screen.getByRole('list', { name: 'Trades' })).getAllByRole('listitem');

  it('lists a traded holding\'s trades newest first, with brokerage, tax and profit', () => {
    open();
    const items = rows();
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain('Sell 6 at USD 150.00');
    expect(items[0].textContent).toContain('29 Oct 2026 · brokerage 1.00 · profit 239.00');
    expect(items[1].textContent).toContain('Buy 5 at USD 130.00');
    expect(items[2].textContent).toContain('Opening 10 at USD 100.00');
    expect(screen.getByRole('button', { name: 'Record a trade' })).toBeTruthy();
    cleanup();
  });

  it('shows no trades section for a holding without a trade history', () => {
    open({ ...abc, trades_version: 0 }, []);
    expect(screen.queryByRole('list', { name: 'Trades' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record a trade' })).toBeNull();
    cleanup();
  });

  it('offers no Delete on the opening entry', () => {
    open();
    const [sell, buy, opening] = rows();
    expect(within(sell).getByRole('button', { name: 'Delete Sell 6 at USD 150.00' })).toBeTruthy();
    expect(within(buy).getByRole('button', { name: 'Delete Buy 5 at USD 130.00' })).toBeTruthy();
    expect(within(opening).getByRole('button', { name: 'Fix Opening 10 at USD 100.00' })).toBeTruthy();
    expect(within(opening).queryByRole('button', { name: /^Delete/ })).toBeNull();
    cleanup();
  });

  it('disables trade actions while the holding has unsaved changes', () => {
    open();
    expect(screen.getByRole('button', { name: 'Record a trade' }).disabled).toBe(false);
    fireEvent.change(screen.getByPlaceholderText('e.g. VWRA'), { target: { value: 'ABC renamed' } });
    expect(screen.getByRole('button', { name: 'Record a trade' }).disabled).toBe(true);
    for (const button of screen.getAllByRole('button', { name: /^(Fix|Delete) / })) expect(button.disabled).toBe(true);
    expect(screen.getByText('Save or discard your changes to the holding first.')).toBeTruthy();
    cleanup();
  });

  it('replaces Delete with the reason on a holding with buys or sales', () => {
    open();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.getByText('A holding with buys or sales can’t be deleted. Delete its trades first, or keep it: sold to zero, it moves to Sold.')).toBeTruthy();
    cleanup();
  });

  it('opens the trade form in place of the list, and Back to trades brings the list back', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Record a trade' }));
    expect(screen.getByRole('button', { name: 'Check' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Trades' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to trades' }));
    expect(screen.getByRole('list', { name: 'Trades' })).toBeTruthy();
    cleanup();
  });

  it('asks before deleting a trade, with what it would undo', async () => {
    rpcAnswers.preview_delete_trade = DELETE_SELL;
    open();
    await press('Delete Sell 6 at USD 150.00');
    expect(rpcCalls).toEqual([{ name: 'preview_delete_trade', args: { p_trade_id: 't-sell' } }]);
    expect(screen.getByText('Delete Sell 6 at USD 150.00 on 29 Oct? ABC: 9 → 15 shares · Dollar broker funds -USD 899.00')).toBeTruthy();
    await press('Keep it');
    expect(screen.queryByText(/^Delete Sell 6 at USD 150.00 on 29 Oct\?/)).toBeNull();
    expect(rpcCalls.map((c) => c.name)).toEqual(['preview_delete_trade']);
    cleanup();
  });

  it('leaves the fund out of the question when the delete moves no money', async () => {
    rpcAnswers.preview_delete_trade = { ...DELETE_SELL, holding_units_after: 9, funds_delta: 0 };
    open();
    await press('Delete Buy 5 at USD 130.00');
    expect(screen.getByText('Delete Buy 5 at USD 130.00 on 28 Oct? ABC: 9 → 9 shares')).toBeTruthy();
    cleanup();
  });

  it('deletes a trade on the version shown and reloads', async () => {
    rpcAnswers.preview_delete_trade = DELETE_SELL;
    rpcAnswers.delete_trade = { ok: true, trade_id: 't-sell', trades_version: 4 };
    const onTradesChanged = vi.fn().mockResolvedValue(undefined);
    open(abc, trades, onTradesChanged);
    await press('Delete Sell 6 at USD 150.00');
    await press('Delete trade');
    expect(rpcCalls[1]).toEqual({ name: 'delete_trade', args: { p_trade_id: 't-sell', p_expected_version: 3 } });
    expect(onTradesChanged).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('deletes on the version the question was worked out on, after a trade from Telegram', async () => {
    // The editor opened on version 3; a trade from Telegram made it 4, and
    // the question was worked out on 4 (the delete would leave 5).
    rpcAnswers.preview_delete_trade = { ...DELETE_SELL, trades_version: 5 };
    rpcAnswers.delete_trade = { ok: true, trade_id: 't-sell', trades_version: 5 };
    open();
    await press('Delete Sell 6 at USD 150.00');
    await press('Delete trade');
    expect(rpcCalls[1].args.p_expected_version).toBe(4);
    cleanup();
  });

  it('says why a trade cannot be deleted', async () => {
    rpcAnswers.preview_delete_trade = { ok: false, error: 'exceeds_units', entry_id: 't-sell' };
    open();
    await press('Delete Buy 5 at USD 130.00');
    expect(screen.getByText('This would sell more ABC than was held on 29 Oct. Nothing was saved.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete trade' })).toBeNull();
    cleanup();
  });

  it('opens a trade to fix it', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Fix Buy 5 at USD 130.00' }));
    expect(screen.getByLabelText('Units traded').value).toBe('5');
    expect(screen.getByRole('button', { name: 'Check' })).toBeTruthy();
    cleanup();
  });

  it('hides the holding\'s own Save while a trade is being recorded', () => {
    open();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Record a trade' }));
    // Under a trade's preview, "Save changes" would read as saving the trade.
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to trades' }));
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
    cleanup();
  });

  // SHR-374: follow-ups from the final review.
  it('locks the holding\'s own fields while a trade is being recorded', () => {
    open();
    expect(screen.getByPlaceholderText('e.g. VWRA').matches(':disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Record a trade' }));
    // An edit made now would be lost when the trade saves and reloads.
    expect(screen.getByPlaceholderText('e.g. VWRA').matches(':disabled')).toBe(true);
    expect(screen.getByLabelText('Units traded').matches(':disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Back to trades' }));
    expect(screen.getByPlaceholderText('e.g. VWRA').matches(':disabled')).toBe(false);
    cleanup();
  });

  it('asks before closing on a trade being typed', () => {
    const onClose = vi.fn();
    renderScreen(<HoldingEditor holding={abc} trades={trades} accounts={ACCOUNTS} householdId="hh" members={[]} onClose={onClose} onSaved={async () => {}} onTradesChanged={async () => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Record a trade' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Discard this trade?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('says when its trades could not be loaded, and offers no Delete', () => {
    renderScreen(<HoldingEditor holding={abc} trades={[]} tradesFailed accounts={ACCOUNTS} householdId="hh" members={[]} onClose={() => {}} onSaved={async () => {}} onTradesChanged={async () => {}} />);
    expect(screen.getByText('Couldn’t load this holding’s trades. Refresh the page to try again.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Record a trade' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    cleanup();
  });

  it('puts focus on the form when it opens, and back on Record a trade when it closes', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Record a trade' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Buy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to trades' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Record a trade' }));
    cleanup();
  });

  it('asks about a delete with focus on Keep it, the question read with it', async () => {
    rpcAnswers.preview_delete_trade = DELETE_SELL;
    open();
    await press('Delete Sell 6 at USD 150.00');
    const keep = screen.getByRole('button', { name: 'Keep it' });
    expect(document.activeElement).toBe(keep);
    const question = document.getElementById(keep.getAttribute('aria-describedby'));
    expect(question.textContent).toBe('Delete Sell 6 at USD 150.00 on 29 Oct? ABC: 9 → 15 shares · Dollar broker funds -USD 899.00');
    cleanup();
  });

  it('ties the reason the trade buttons are off to the buttons', () => {
    open();
    fireEvent.change(screen.getByPlaceholderText('e.g. VWRA'), { target: { value: 'ABC renamed' } });
    const record = screen.getByRole('button', { name: 'Record a trade' });
    expect(document.getElementById(record.getAttribute('aria-describedby')).textContent).toBe('Save or discard your changes to the holding first.');
    cleanup();
  });

  it('keeps Delete on a holding with only its opening entry', () => {
    open(abc, [trades[0]]);
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    cleanup();
  });
});
