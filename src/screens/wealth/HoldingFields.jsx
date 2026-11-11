import { ASSET_CLASS_LABELS, SECTOR_GROUPS, SECTOR_LABELS, costFromUnits, hasSector } from '../../lib/holdings';
import { todayISODate } from '../../lib/valuation';
import OwnerPicker from '../OwnerPicker';

// Part of the holding editor (HoldingEditor.jsx), split out with the round 2
// cleanup (SHR-383).
//
// The holding's own fields: what it is, whose it is, and its figures, which
// the price feed or its trades may fill instead. They lock while a trade or a
// dividend is being recorded, which has its own save.
export default function HoldingFields({
  form,
  set,
  holding,
  members,
  problems,
  traded,
  autoValued,
  pendingValuation,
  repricing,
  dividendFields,
  lastValuedLabel,
  asOf,
  setAsOf,
  confirmUnchanged,
  setConfirmUnchanged,
  setDirty,
  subFormOpen,
}) {
  return (
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
          <input aria-label="Ticker or fund" className="te-fieldvalue" type="text" value={form.name} onChange={(e) => set('name', e.target.value)} aria-invalid={!!problems.name} placeholder="e.g. VWRA" />
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
                onChange={(e) => set('dividend_tax_pct', e.target.value)} aria-invalid={!!problems.rate} placeholder="Default for its class" />
            </div>
            <div className="te-fieldcell">
              <label className="te-fieldlabel" htmlFor="holding-dividend-fee">
                Fees per share
              </label>
              <input id="holding-dividend-fee" className="te-fieldvalue" type="text" inputMode="decimal" value={form.dividend_fee_per_share}
                onChange={(e) => set('dividend_fee_per_share', e.target.value)} aria-invalid={!!problems.fee} placeholder="0" />
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
              aria-invalid={!!problems.symbol}
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
  );
}
