import { useEffect, useState } from 'react';
import { useDrawerFocus } from '../../lib/useDrawerFocus';
import { supabase } from '../../lib/supabaseClient';
import { ASSET_CLASS_LABELS, SECTOR_GROUPS, SECTOR_LABELS, costFromUnits, hasSector } from '../../lib/holdings';
import { daysSincePriced, historyPointFor, isPendingValuation, nextPricedAt, todayISODate, valueFieldFor, valuationChanged } from '../../lib/valuation';
import { hasBuysOrSales } from '../../lib/trades';
import HoldingTrades from './HoldingTrades';
import '../money/TransactionEditor.css';

function initialForm(holding) {
  if (holding) {
    return {
      name: holding.name,
      asset_class: holding.asset_class,
      sector: holding.sector ?? '',
      currency: holding.currency ?? 'AED',
      value_aed: valueFieldFor(holding),
      owner: holding.is_shared ? 'shared' : (holding.owner_member_id ?? ''),
      quantity: holding.quantity != null ? String(holding.quantity) : '',
      avg_price: holding.avg_price != null ? String(holding.avg_price) : '',
      current_price: holding.current_price != null ? String(holding.current_price) : '',
      invested_value_aed: holding.invested_value_aed != null ? String(holding.invested_value_aed) : '',
      day_change_pct: holding.day_change_pct != null ? String(holding.day_change_pct) : '',
      price_provider: holding.price_provider ?? '',
      price_symbol: holding.price_symbol ?? '',
    };
  }
  return {
    name: '', asset_class: 'us_equity', sector: '', currency: 'USD', value_aed: '', owner: 'shared',
    quantity: '', avg_price: '', current_price: '', invested_value_aed: '', day_change_pct: '',
    price_provider: '', price_symbol: '',
  };
}

const NO_TRADES = [];

export default function HoldingEditor({ holding: holdingAsOpened, householdId, members, trades = NO_TRADES, accounts = NO_TRADES, onClose, onSaved, onStale, onTradesChanged }) {
  // The editor works from the holding as it was when opened. The screen
  // re-reads its data every few minutes and after a refused save, and the row
  // it hands over then may be newer (a trade from Telegram, a price): taking
  // it would move figures under someone's edits, and judge a plain rename a
  // new valuation. A save from an older version is refused by the database,
  // and a trade made here opens the editor afresh (Investments).
  const [holding] = useState(holdingAsOpened);
  const drawerRef = useDrawerFocus();
  const [form, setForm] = useState(() => initialForm(holding));
  // A valuation is only as of a date someone states. Editing a name must not
  // silently certify the stored price as current (QA-04).
  const [asOf, setAsOf] = useState(() => todayISODate());
  const [dirty, setDirty] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // Explicit reconfirmation of an unchanged valuation (SHR-245): distinct from
  // an ordinary numeric edit, so it must be a deliberate, separate act.
  const [confirmUnchanged, setConfirmUnchanged] = useState(false);
  // Once the holdings insert for a brand-new holding succeeds, its id is kept
  // here so a retry (e.g. after the history write fails) reuses it instead of
  // inserting a second row (SHR-246: a stable id makes the retry idempotent).
  const [createdId, setCreatedId] = useState(null);
  // A trade being recorded or fixed has its own way back and its own save.
  const [tradeFormOpen, setTradeFormOpen] = useState(false);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, confirmingClose]);

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  }

  function requestClose() {
    if (dirty && !confirmingClose) {
      setConfirmingClose(true);
      return;
    }
    onClose();
  }

  const nameError = form.name.trim() === '' ? 'Name it.' : '';
  const symbolError = form.price_provider && form.price_symbol.trim() === '' ? 'Enter the symbol this provider expects.' : '';
  // Matches how the database values a priced holding (set_holding_price):
  // only these currencies have a real conversion path, and units are required
  // to turn a per-unit price into a total value.
  const autoValued = !!form.price_provider && form.quantity.trim() !== '' && ['AED', 'USD', 'INR'].includes((form.currency || '').toUpperCase());

  // An auto-valued holding whose value field is blank because it is disabled
  // and nothing has priced it yet. `Number('') || 0` turned that into a
  // confirmed zero: stamped priced_at, wrote a zero history point, and showed
  // a 100% loss against any cost basis until the first refresh landed -- or
  // permanently, if that refresh failed (QA #6). The stored 0 stays (the
  // column is not null), but nothing is allowed to treat it as a measurement.
  const pendingValuation = isPendingValuation({ holding, valueField: form.value_aed, autoValued });

  // Whether this edit touches the numbers at all — drives both the copy above
  // and whether priced_at moves on save.
  const repricing =
    !holding ||
    valuationChanged(holding, {
      value_aed: Number(form.value_aed) || 0,
      quantity: form.quantity.trim() === '' ? null : Number(form.quantity),
      avg_price: form.avg_price.trim() === '' ? null : Number(form.avg_price),
      current_price: form.current_price.trim() === '' ? null : Number(form.current_price),
      invested_value_aed: form.invested_value_aed.trim() === '' ? null : Number(form.invested_value_aed),
      day_change_pct: form.day_change_pct.trim() === '' ? null : Number(form.day_change_pct),
    });
  // Once a holding has its opening entry, its units and average price come
  // only from its trades (SHR-367).
  const traded = (holding?.trades_version ?? 0) > 0;
  // The database refuses to delete a holding with buys or sales (their money
  // moved through a fund); saying so beats offering a button that fails.
  const deletable = holding && !hasBuysOrSales(trades, holding.id);
  const daysOld = holding ? daysSincePriced(holding) : null;
  const lastValuedLabel =
    daysOld === null ? 'No valuation confirmed yet.' : `Unchanged numbers keep the existing valuation date (${daysOld}d ago).`;

  async function handleSave(e) {
    e.preventDefault();
    if (nameError || symbolError) {
      setError(nameError || symbolError);
      return;
    }
    setSaving(true);
    setError('');

    const valuation = {
      value_aed: Number(form.value_aed) || 0,
      quantity: form.quantity.trim() === '' ? null : Number(form.quantity),
      avg_price: form.avg_price.trim() === '' ? null : Number(form.avg_price),
      current_price: form.current_price.trim() === '' ? null : Number(form.current_price),
      invested_value_aed: form.invested_value_aed.trim() === '' ? null : Number(form.invested_value_aed),
      day_change_pct: form.day_change_pct.trim() === '' ? null : Number(form.day_change_pct),
      price_provider: form.price_provider || null,
      price_symbol: form.price_provider && form.price_symbol.trim() !== '' ? form.price_symbol.trim() : null,
    };
    // priced_at moves when the numbers actually change, or when the reviewer
    // explicitly reconfirms an unchanged value as of the date above. A rename
    // or a reload does neither, so a stale holding stays stale (QA-04).
    const repriced = !holding || valuationChanged(holding, valuation);
    const explicitlyConfirmed = !repriced && holding && confirmUnchanged;
    // A pending valuation confirms nothing, so it moves no date and records no
    // history point. priced_at stays null, which every reader already treats
    // as "never valued" -- the staleness banner, the editor's own copy, and
    // now holdingGain (QA #6). The price feed sets it on the first successful
    // refresh, and a failed refresh correctly leaves it unset rather than
    // leaving a fresh-looking zero behind.
    const nextPriced = pendingValuation
      ? null
      : repriced
        ? nextPricedAt(holding, valuation, { confirmedAsOf: asOf })
        : explicitlyConfirmed
          ? nextPricedAt(holding, holding, { confirmedAsOf: asOf })
          : (holding?.priced_at ?? null);
    // A traded holding the feed prices is valued by the database, from its
    // units under the holding's lock, whenever a trade or a price lands. The
    // figures this editor loaded may already be older than that, so it sends
    // none of them and records no value point (SHR-367).
    const feedValued = traded && autoValued;
    const writesHistory = !feedValued && !pendingValuation && (repriced || explicitlyConfirmed);
    const payload = {
      household_id: householdId,
      name: form.name.trim(),
      asset_class: form.asset_class,
      // Only shares and share funds have a sector.
      sector: hasSector(form.asset_class) ? form.sector || null : null,
      currency: form.currency || 'AED',
      is_shared: form.owner === 'shared',
      owner_member_id: form.owner === 'shared' ? null : form.owner,
      updated_at: new Date().toISOString(),
      ...valuation,
      ...(nextPriced ? { priced_at: nextPriced } : {}),
    };
    // A traded holding's units and average come only from its trades, and the
    // database refuses them from anywhere else (SHR-367), so they are never sent.
    if (traded) {
      delete payload.quantity;
      delete payload.avg_price;
    }
    if (feedValued) {
      delete payload.value_aed;
      delete payload.current_price;
      delete payload.day_change_pct;
      delete payload.priced_at;
    }

    // A brand-new holding's id is generated and recorded BEFORE the first
    // write is dispatched — not read back from a successful response — so a
    // retry can recover regardless of what actually happened to that first
    // attempt. That's the part a plain update-on-retry got wrong (SHR-246,
    // 81a6bb3 recheck): if the first attempt's insert failed before it ever
    // committed, no row exists yet, and an update matches zero rows without
    // raising an error — every retry after that stayed on update forever,
    // never actually creating the holding. Upserting on the known id instead
    // handles both outcomes of that first attempt with the same call: if it
    // never committed, this inserts; if it committed but the response was
    // lost, this updates in place. Either way, retrying never risks a second
    // row, and never silently no-ops on a row that was never written.
    let holdingId = holding?.id ?? createdId;
    if (holding) {
      // Saved only if no trade or go-live moved the holding since the editor
      // opened: otherwise this save would put back what that trade changed.
      const { data: saved, error: saveError } = await supabase
        .from('holdings')
        .update(payload)
        .eq('id', holding.id)
        .eq('trades_version', holding.trades_version ?? 0)
        .select('id');
      if (saveError) {
        setSaving(false);
        setError(saveError.message);
        return;
      }
      if (!saved?.length) {
        setSaving(false);
        setError('This holding changed or was removed after you opened it, so nothing was saved. Close it and open it again to see the latest.');
        // The screen opened this editor with the row it had loaded. Reading
        // its data afresh now is what makes opening it again show the change.
        await onStale?.();
        return;
      }
    } else {
      if (!holdingId) {
        holdingId = crypto.randomUUID();
        setCreatedId(holdingId);
      }
      const { error: saveError } = await supabase.from('holdings').upsert({ id: holdingId, ...payload }, { onConflict: 'id' });
      if (saveError) {
        setSaving(false);
        setError(saveError.message);
        return;
      }
    }

    // A confirmed valuation is also a dated history point. Upserting on
    // (holding_id, as_of) makes confirming the same day twice idempotent
    // rather than duplicating the point (QA-05).
    if (writesHistory && holdingId) {
      const point = historyPointFor(holdingId, asOf, valuation.value_aed);
      const { error: historyError } = await supabase
        .from('holding_value_history')
        .upsert(point, { onConflict: 'holding_id,as_of' });
      if (historyError) {
        setSaving(false);
        setError(`Saved the holding, but its valuation history point failed: ${historyError.message}`);
        return;
      }
    }

    setSaving(false);
    await onSaved();
  }

  async function handleDelete() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setSaving(true);
    const { error: delError } = await supabase.from('holdings').delete().eq('id', holding.id);
    setSaving(false);
    if (delError) {
      setError(delError.message);
      return;
    }
    await onSaved();
  }

  return (
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="te-drawer" ref={drawerRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={holding ? 'Edit holding' : 'Add holding'}>
        <div className="te-head">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="ov-kicker">{holding ? 'Edit holding' : 'New holding'}</span>
              {dirty && <span className="te-dirty-chip">Unsaved</span>}
            </div>
            <div className="te-title">{holding ? holding.name : 'Add a holding'}</div>
          </div>
          <button type="button" className="te-close" onClick={requestClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          <div>
            <div className="te-hero-label">Value</div>
            <div className="te-hero-row">
              <span className="te-hero-currency">AED</span>
              <input
                type="number"
                step="0.01"
                className="te-hero-input"
                value={form.value_aed}
                onChange={(e) => set('value_aed', e.target.value)}
                disabled={autoValued}
                placeholder={autoValued ? 'Awaiting first price' : '0'}
              />
            </div>
          </div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: -10 }}>
            {autoValued
              ? pendingValuation
                ? 'Auto-computed daily from units × live price × FX. Saving now records the holding with no value yet — it stays "not valued" until the first price refresh succeeds, rather than being recorded as worth zero.'
                : 'Auto-computed daily from units × live price × FX, so this field is not editable here.'
              : 'Value is entered in AED directly — no live FX conversion.'}
          </div>

          <div className="te-fieldgrid">
            <div className="te-fieldcell">
              <label className="te-fieldlabel" htmlFor="holding-as-of">
                Valued as of
              </label>
              <input
                id="holding-as-of"
                className="te-fieldvalue"
                type="date"
                value={asOf}
                max={todayISODate()}
                onChange={(e) => {
                  setAsOf(e.target.value);
                  setDirty(true);
                }}
              />
            </div>
            <div className="te-fieldcell te-span2" style={{ alignSelf: 'end' }}>
              <span className="ov-muted" style={{ fontSize: 11.5 }}>
                {repricing
                  ? 'Saving records this as a dated valuation point.'
                  : holding
                    ? lastValuedLabel
                    : 'Saving records this as the first valuation point.'}
              </span>
            </div>
          </div>

          {holding && !repricing && (
            <label className="ov-muted" style={{ fontSize: 11.5, display: 'flex', gap: 8, alignItems: 'center', marginTop: -8 }}>
              <input
                type="checkbox"
                checked={confirmUnchanged}
                onChange={(e) => {
                  setConfirmUnchanged(e.target.checked);
                  setDirty(true);
                }}
              />
              Still worth the same — confirm it as of the date above, without changing any number.
            </label>
          )}

          <div className="te-fieldgrid">
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Ticker or fund</span>
              <input className="te-fieldvalue" type="text" value={form.name} onChange={(e) => set('name', e.target.value)} aria-invalid={!!nameError} placeholder="e.g. VWRA" />
            </div>
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Asset class</span>
              <select className="te-fieldvalue" value={form.asset_class} onChange={(e) => set('asset_class', e.target.value)}>
                {Object.entries(ASSET_CLASS_LABELS).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Native currency</span>
              <input className="te-fieldvalue" type="text" value={form.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} maxLength={3} />
            </div>
            {/* Tagged once, so Wealth can say how much sits in one sector
                (Planning audit, 4.17). Only shares and share funds have one. */}
            {hasSector(form.asset_class) && (
              <div className="te-fieldcell te-span2">
                <label className="te-fieldlabel" htmlFor="holding-sector">
                  Sector
                </label>
                <select id="holding-sector" className="te-fieldvalue" value={form.sector} onChange={(e) => set('sector', e.target.value)}>
                  <option value="">Not tagged</option>
                  {SECTOR_GROUPS.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {Object.entries(group.sectors).map(([id, label]) => (
                        <option key={id} value={id}>
                          {label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                  <option value="broad">{SECTOR_LABELS.broad}</option>
                </select>
              </div>
            )}
          </div>

          <div>
            <span className="te-fieldlabel">Pricing detail (optional)</span>
            <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 4, marginBottom: 10 }}>
              Fills in the richer holdings table (units, avg price, P&amp;L). "Price now" and "Day change" are
              overwritten by the daily refresh below when auto-pricing is on; otherwise they're manual. With units
              and a currency the feed can convert (AED, USD, or INR), the Value field above is overwritten too.
            </div>
            {traded && (
              <div className="ov-muted" style={{ fontSize: 11.5, marginBottom: 10 }}>
                Units and average price come from this holding&rsquo;s trades.
              </div>
            )}
            <div className="te-fieldgrid">
              <div className="te-fieldcell">
                <span className="te-fieldlabel">Units</span>
                <input className="te-fieldvalue" aria-label="Units" type="number" step="any" value={form.quantity} onChange={(e) => set('quantity', e.target.value)} readOnly={traded} placeholder="—" />
              </div>
              <div className="te-fieldcell">
                <span className="te-fieldlabel">Avg price ({form.currency || '—'})</span>
                <input className="te-fieldvalue" aria-label={`Avg price (${form.currency || '—'})`} type="number" step="any" value={form.avg_price} onChange={(e) => set('avg_price', e.target.value)} readOnly={traded} placeholder="—" />
              </div>
              <div className="te-fieldcell">
                <span className="te-fieldlabel">Price now ({form.currency || '—'})</span>
                <input className="te-fieldvalue" type="number" step="any" value={form.current_price} onChange={(e) => set('current_price', e.target.value)} disabled={!!form.price_provider} placeholder="—" />
              </div>
              <div className="te-fieldcell">
                <span className="te-fieldlabel">Invested (AED)</span>
                {costFromUnits(form) ? (
                  <span className="te-fieldvalue ov-muted" data-testid="invested-from-units">
                    Units × avg price, at today&rsquo;s rate
                  </span>
                ) : (
                  <input className="te-fieldvalue" type="number" step="0.01" value={form.invested_value_aed} onChange={(e) => set('invested_value_aed', e.target.value)} placeholder="—" />
                )}
              </div>
              <div className="te-fieldcell">
                <span className="te-fieldlabel">Day change (%)</span>
                <input className="te-fieldvalue" type="number" step="any" value={form.day_change_pct} onChange={(e) => set('day_change_pct', e.target.value)} disabled={!!form.price_provider} placeholder="—" />
              </div>
            </div>
          </div>

          <div>
            <span className="te-fieldlabel">Auto-pricing (optional)</span>
            <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 4, marginBottom: 10 }}>
              Opts this holding into the daily price feed. Leave "None" to keep entering price/day-change by hand —
              most sukuk still have no real option here.
            </div>
            <div className="te-fieldgrid">
              <div className="te-fieldcell te-span2">
                <span className="te-fieldlabel">Provider</span>
                <select className="te-fieldvalue" value={form.price_provider} onChange={(e) => set('price_provider', e.target.value)}>
                  <option value="">None — manual</option>
                  <option value="twelvedata">Twelve Data (global equities, commodities)</option>
                  <option value="yahoo">Yahoo Finance (NSE, DFM; unofficial)</option>
                  <option value="coingecko">CoinGecko (crypto)</option>
                  <option value="mfapi">mfapi.in (India mutual fund NAV)</option>
                </select>
              </div>
              <div className="te-fieldcell te-span2">
                <span className="te-fieldlabel">
                  {form.price_provider === 'mfapi' ? 'AMFI scheme code' : form.price_provider === 'coingecko' ? 'CoinGecko coin id' : 'Symbol'}
                </span>
                <input
                  className="te-fieldvalue"
                  type="text"
                  value={form.price_symbol}
                  onChange={(e) => set('price_symbol', e.target.value)}
                  disabled={!form.price_provider}
                  aria-invalid={!!symbolError}
                  placeholder={
                    form.price_provider === 'mfapi'
                      ? 'e.g. 120503'
                      : form.price_provider === 'coingecko'
                        ? 'e.g. bitcoin'
                        : form.price_provider === 'yahoo'
                          ? 'e.g. RELIANCE.NS or EMAAR.AE'
                          : 'e.g. AAPL'
                  }
                />
              </div>
            </div>
            {holding?.price_fetch_error && (
              <div className="ov-warn" style={{ fontSize: 11.5, marginTop: 8 }}>
                Last refresh failed: {holding.price_fetch_error}
                {holding.price_fetch_fail_count > 1 ? ` (${holding.price_fetch_fail_count} attempts since)` : ''}
              </div>
            )}
          </div>

          <div>
            <span className="te-fieldlabel">Held by</span>
            <div className="om-scope-list" style={{ marginTop: 10 }}>
              <button type="button" className="om-scope" data-active={form.owner === 'shared'} onClick={() => set('owner', 'shared')}>
                Shared
              </button>
              {members.map((m) => (
                <button key={m.id} type="button" className="om-scope" data-active={form.owner === m.id} onClick={() => set('owner', m.id)}>
                  {m.display_name}
                </button>
              ))}
            </div>
          </div>

          {traded && (
            <HoldingTrades
              holding={holding}
              trades={trades}
              accounts={accounts}
              disabledReason={dirty ? 'Save or discard your changes to the holding first.' : null}
              onChanged={onTradesChanged}
              onFormOpen={setTradeFormOpen}
            />
          )}

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
              {error}
            </p>
          )}

          {!tradeFormOpen && (
            <div className="te-sticky-actions">
              <div className="te-actions" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
                {deletable && (
                  <button type="button" className="om-btn te-delete" onClick={handleDelete} disabled={saving}>
                    {confirmingDelete ? 'Confirm delete?' : 'Delete'}
                  </button>
                )}
                {holding && !deletable && (
                  <span className="ov-muted" style={{ fontSize: 11.5, maxWidth: 260 }}>
                    A holding with buys or sales can&rsquo;t be deleted. Delete its trades first, or keep it: sold to zero, it moves to Sold.
                  </span>
                )}
                <div className="te-actions-right">
                  {confirmingClose ? (
                    <>
                      <span className="ov-muted" style={{ marginRight: 8 }}>
                        Discard changes?
                      </span>
                      <button type="button" className="om-btn" onClick={onClose}>
                        Discard
                      </button>
                      <button type="button" className="om-btn" onClick={() => setConfirmingClose(false)}>
                        Keep editing
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="om-btn" onClick={requestClose}>
                        Cancel
                      </button>
                      <button type="submit" className="om-btn ov-btn-primary" disabled={saving}>
                        {saving ? 'Saving…' : holding ? 'Save changes' : 'Add holding'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
