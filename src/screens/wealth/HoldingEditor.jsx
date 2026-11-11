import { useState } from 'react';
import { useCloseGuard } from '../../lib/useCloseGuard';
import DiscardPrompt from '../DiscardPrompt';
import { useDrawerFocus } from '../../lib/useDrawerFocus';
import { supabase } from '../../lib/supabaseClient';
import { ASSET_CLASS_LABELS, SECTOR_GROUPS, SECTOR_LABELS, costFromUnits, hasSector, paysDividends } from '../../lib/holdings';
import { daysSincePriced, historyPointFor, isPendingValuation, nextPricedAt, todayISODate, valueFieldFor, valuationChanged } from '../../lib/valuation';
import { hasBuysOrSales } from '../../lib/trades';
import HoldingTrades from './HoldingTrades';
import HoldingDividends from './HoldingDividends';
import '../money/TransactionEditor.css';
import OwnerPicker from '../OwnerPicker';

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
      dividend_tax_pct: holding.dividend_tax_pct != null ? String(holding.dividend_tax_pct) : '',
      dividend_fee_per_share: holding.dividend_fee_per_share != null ? String(holding.dividend_fee_per_share) : '',
    };
  }
  return {
    name: '', asset_class: 'us_equity', sector: '', currency: 'USD', value_aed: '', owner: 'shared',
    quantity: '', avg_price: '', current_price: '', invested_value_aed: '', day_change_pct: '',
    price_provider: '', price_symbol: '', dividend_tax_pct: '', dividend_fee_per_share: '',
  };
}

const NO_TRADES = [];

export default function HoldingEditor({
  holding: holdingAsOpened,
  // Deleted elsewhere since it was opened: the draft stays, and says so.
  gone = false,
  householdId,
  members,
  trades = NO_TRADES,
  tradesFailed = false,
  dividends = NO_TRADES,
  specialParts = NO_TRADES,
  dividendsFailed = false,
  accounts = NO_TRADES,
  onClose,
  onSaved,
  onStale,
  onTradesChanged,
}) {
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
  // So has a dividend being recorded, fixed or added (SHR-366).
  const [dividendFormOpen, setDividendFormOpen] = useState(false);
  const subFormOpen = tradeFormOpen || dividendFormOpen;
  // A trade or a dividend being typed is as much unsaved work as an edited
  // field.
  const { confirmingClose, requestClose, keepEditing } = useCloseGuard({ dirty: dirty || subFormOpen, onClose });

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  }

  const nameError = form.name.trim() === '' ? 'Name it.' : '';
  const symbolError = form.price_provider && form.price_symbol.trim() === '' ? 'Enter the symbol this provider expects.' : '';
  // Withholding is a default per holding, not a fact (SHR-366): a US-listed
  // share of a foreign company is withheld by its home country. Left empty, a
  // new holding takes its class's default and an existing one keeps its rate.
  const dividendFields = paysDividends(form.asset_class);
  const taxRate = form.dividend_tax_pct.trim() === '' ? null : Number(form.dividend_tax_pct);
  const feePerShare = form.dividend_fee_per_share.trim() === '' ? null : Number(form.dividend_fee_per_share);
  const rateError = dividendFields && taxRate !== null && !(taxRate >= 0 && taxRate <= 100) ? 'Enter a rate from 0 to 100.' : '';
  const feeError = dividendFields && feePerShare !== null && !(feePerShare >= 0) ? 'Enter a fee of 0 or more.' : '';
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
  // Trades that never loaded can't show whether there are any, so a traded
  // holding then offers no Delete either.
  const buysOrSales = holding && hasBuysOrSales(trades, holding.id);
  // Nor one with received or presumed dividends: they are tax records, and
  // received ones moved money (round 2 of the outside review). Dividends that
  // never loaded can't show whether there are any, so no Delete then either.
  const receivedDividends = holding && dividends.some((d) => d.holding_id === holding.id && (d.status === 'received' || d.status === 'presumed'));
  const deletable = holding && !gone && !(traded && tradesFailed) && !buysOrSales && !dividendsFailed && !receivedDividends;
  // A holding deleted elsewhere is only shown, to copy from: a save, a
  // trade or a dividend would act on nothing (the fresh review of PR 5).
  const goneReason = gone ? 'This holding was deleted elsewhere.' : null;
  const daysOld = holding ? daysSincePriced(holding) : null;
  const lastValuedLabel =
    daysOld === null ? 'No valuation confirmed yet.' : `Unchanged numbers keep the existing valuation date (${daysOld}d ago).`;

  async function handleSave(e) {
    e.preventDefault();
    if (gone) return;
    if (nameError || symbolError || rateError || feeError) {
      setError(nameError || symbolError || rateError || feeError);
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
      ...(dividendFields && taxRate !== null ? { dividend_tax_pct: taxRate } : {}),
      ...(dividendFields && feePerShare !== null ? { dividend_fee_per_share: feePerShare } : {}),
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
          {gone && (
            <p className="ov-warn" role="alert" style={{ marginTop: 0, fontSize: 12.5 }}>
              This holding was deleted elsewhere. Copy what you need from your draft, then close.
            </p>
          )}
          {/* The holding's own fields lock while a trade is recorded or fixed:
              saving the trade reloads the holding, and an edit made meanwhile
              would be lost. */}
          <fieldset className="he-fields" disabled={subFormOpen}>
            <div>
              <div className="te-hero-label">Value</div>
              <div className="te-hero-row">
                <span className="te-hero-currency">AED</span>
                <input aria-label="Value"
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
                <input aria-label="Ticker or fund" className="te-fieldvalue" type="text" value={form.name} onChange={(e) => set('name', e.target.value)} aria-invalid={!!nameError} placeholder="e.g. VWRA" />
              </div>
              <div className="te-fieldcell">
                <span className="te-fieldlabel">Asset class</span>
                <select aria-label="Asset class" className="te-fieldvalue" value={form.asset_class} onChange={(e) => set('asset_class', e.target.value)}>
                  {Object.entries(ASSET_CLASS_LABELS).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="te-fieldcell">
                <span className="te-fieldlabel">Native currency</span>
                <input aria-label="Native currency" className="te-fieldvalue" type="text" value={form.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} maxLength={3} />
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
              {/* What is withheld from this share's dividends, and any fee per
                  share a depositary takes (SHR-366). */}
              {dividendFields && (
                <>
                  <div className="te-fieldcell">
                    <label className="te-fieldlabel" htmlFor="holding-dividend-tax">
                      Withholding on dividends
                    </label>
                    <input id="holding-dividend-tax" className="te-fieldvalue" type="text" inputMode="decimal" value={form.dividend_tax_pct}
                      onChange={(e) => set('dividend_tax_pct', e.target.value)} aria-invalid={!!rateError} placeholder="Default for its class" />
                  </div>
                  <div className="te-fieldcell">
                    <label className="te-fieldlabel" htmlFor="holding-dividend-fee">
                      Fees per share
                    </label>
                    <input id="holding-dividend-fee" className="te-fieldvalue" type="text" inputMode="decimal" value={form.dividend_fee_per_share}
                      onChange={(e) => set('dividend_fee_per_share', e.target.value)} aria-invalid={!!feeError} placeholder="0" />
                  </div>
                </>
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
                  <input className="te-fieldvalue" aria-label={`Price now (${form.currency || '—'})`} type="number" step="any" value={form.current_price} onChange={(e) => set('current_price', e.target.value)} disabled={!!form.price_provider} placeholder="—" />
                </div>
                <div className="te-fieldcell">
                  <span className="te-fieldlabel">Invested (AED)</span>
                  {costFromUnits(form) ? (
                    <span className="te-fieldvalue ov-muted" data-testid="invested-from-units">
                      Units × avg price, at today&rsquo;s rate
                    </span>
                  ) : (
                    <input className="te-fieldvalue" aria-label="Invested (AED)" type="number" step="0.01" value={form.invested_value_aed} onChange={(e) => set('invested_value_aed', e.target.value)} placeholder="—" />
                  )}
                </div>
                <div className="te-fieldcell">
                  <span className="te-fieldlabel">Day change (%)</span>
                  <input aria-label="Day change (%)" className="te-fieldvalue" type="number" step="any" value={form.day_change_pct} onChange={(e) => set('day_change_pct', e.target.value)} disabled={!!form.price_provider} placeholder="—" />
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
                  <select aria-label="Provider" className="te-fieldvalue" value={form.price_provider} onChange={(e) => set('price_provider', e.target.value)}>
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
                    aria-label={form.price_provider === 'mfapi' ? 'AMFI scheme code' : form.price_provider === 'coingecko' ? 'CoinGecko coin id' : 'Symbol'}
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
              <OwnerPicker value={form.owner} members={members} onChange={(id) => set('owner', id)} />
            </div>
          </fieldset>

          {traded && (
            <HoldingTrades
              holding={holding}
              trades={trades}
              failed={tradesFailed}
              accounts={accounts}
              disabledReason={goneReason ?? (dirty ? 'Save or discard your changes to the holding first.' : dividendFormOpen ? 'Finish the dividend first.' : null)}
              onChanged={onTradesChanged}
              onFormOpen={setTradeFormOpen}
            />
          )}

          {/* A share the dividend feeds cover, once it is saved. A dividend
              saved reloads the screen as a trade does. */}
          {holding && paysDividends(holding.asset_class) && (
            <HoldingDividends
              holding={holding}
              dividends={dividends}
              specialParts={specialParts}
              failed={dividendsFailed}
              accounts={accounts}
              disabledReason={goneReason ?? (dirty ? 'Save or discard your changes to the holding first.' : tradeFormOpen ? 'Finish the trade first.' : null)}
              onChanged={onTradesChanged}
              onFormOpen={setDividendFormOpen}
            />
          )}

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
              {error}
            </p>
          )}

          {/* While a trade or dividend form is open only the question about
              leaving shows here: it has its own way back and its own save. */}
          {(!subFormOpen || confirmingClose) && (
            <div className="te-sticky-actions">
              <div className="te-actions" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
                {!subFormOpen && deletable && (
                  <button type="button" className="om-btn te-delete" onClick={handleDelete} disabled={saving}>
                    {confirmingDelete ? 'Confirm delete?' : 'Delete'}
                  </button>
                )}
                {!subFormOpen && holding && !gone && !(traded && tradesFailed) && buysOrSales && (
                  <span className="ov-muted" style={{ fontSize: 11.5, maxWidth: 260 }}>
                    A holding with buys or sales can&rsquo;t be deleted. Delete its trades first, or keep it: sold to zero, it moves to Sold.
                  </span>
                )}
                {!subFormOpen && holding && !gone && !buysOrSales && receivedDividends && (
                  <span className="ov-muted" style={{ fontSize: 11.5, maxWidth: 260 }}>
                    A holding with received dividends can&rsquo;t be deleted: they are tax records. Keep it: sold to zero, it moves to Sold.
                  </span>
                )}
                <div className="te-actions-right">
                  {confirmingClose ? (
                    <DiscardPrompt
                      question={tradeFormOpen ? 'Discard this trade?' : dividendFormOpen ? 'Discard this dividend?' : 'Discard changes?'}
                      onDiscard={onClose}
                      onKeepEditing={keepEditing}
                    />
                  ) : (
                    <>
                      <button type="button" className="om-btn" onClick={requestClose}>
                        Cancel
                      </button>
                      {!gone && (
                        <button type="submit" className="om-btn ov-btn-primary" disabled={saving}>
                          {saving ? 'Saving…' : holding ? 'Save changes' : 'Add holding'}
                        </button>
                      )}
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
