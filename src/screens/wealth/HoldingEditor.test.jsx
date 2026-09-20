import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, cleanup } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

// A minimal, realistic simulation of the `holdings` table: upsert on `id`
// either inserts (id not present yet) or updates in place (id already
// there) — the same semantics a real `on conflict (id) do update` has.
const db = { holdings: new Map(), histories: [] };
let historyFailsOnce = false;

vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      update: (row) => ({
        eq: async (_field, id) => {
          if (table === 'holdings' && db.holdings.has(id)) {
            db.holdings.set(id, { ...db.holdings.get(id), ...row });
          }
          return { error: null };
        },
      }),
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
