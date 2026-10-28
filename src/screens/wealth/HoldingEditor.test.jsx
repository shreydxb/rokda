import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, cleanup } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

// A minimal, realistic simulation of the `holdings` table: upsert on `id`
// either inserts (id not present yet) or updates in place (id already
// there) — the same semantics a real `on conflict (id) do update` has.
const db = { holdings: new Map(), histories: [] };
// Column defaults a stored row reads when a test seeds it without them.
const COLUMN_DEFAULTS = { trades_version: 0 };
let historyFailsOnce = false;

vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
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

