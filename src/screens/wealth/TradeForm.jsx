import { useId, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { formatMoney } from '../../lib/money';
import { householdToday } from '../../lib/day';
import { TRADE_KIND_LABELS, formatUnits, refusalMessage, tradeArgs, tradeRow, warningLines } from '../../lib/trades';

const KINDS = ['buy', 'sell', 'split'];
const money2 = (n) => formatMoney(n, { decimals: 2 });

// The Broker funds a trade on this holding can go through: open ones in its
// currency, its own fund first, so the usual choice is the one already made.
function fundsFor(accounts, holding) {
  return (accounts ?? [])
    .filter((a) => a.type === 'broker_funds' && a.currency === holding.currency && !a.archived_at)
    .sort((a, b) => (a.id === holding.funds_account_id ? -1 : b.id === holding.funds_account_id ? 1 : a.name.localeCompare(b.name)));
}

function initialForm(holding, trade, funds) {
  if (trade) {
    // A zero brokerage or tax reads as blank, as it was typed.
    const text = (v) => (Number(v) > 0 ? String(Number(v)) : '');
    return {
      kind: trade.kind,
      trade_date: trade.trade_date,
      units: String(Number(trade.units)),
      price: trade.price == null ? '' : String(Number(trade.price)),
      fees: text(trade.fees),
      // A sale's tax reads blank only while it is still to confirm. Once it
      // was confirmed, a 0 is a figure (a loss-making Indian sale withholds
      // none), and a blank would mark the sale as awaiting its tax again.
      tax_withheld: trade.kind === 'sell' && !trade.tax_to_confirm ? String(Number(trade.tax_withheld ?? 0)) : text(trade.tax_withheld),
      funds_account_id: trade.funds_account_id ?? funds[0]?.id ?? '',
    };
  }
  return { kind: 'buy', trade_date: householdToday(), units: '', price: '', fees: '', tax_withheld: '', funds_account_id: funds[0]?.id ?? '' };
}

// Records a trade on a holding, or fixes one (SHR-371). Nothing here works
// out what a trade does: "Check" asks the database (preview_trade), shows its
// answer, and "Save trade" saves exactly the trade that was checked, on the
// version of the holding it was checked against. Any change to a field
// clears the check, so what is saved is always what was last shown.
export default function TradeForm({ holding, trade = null, trades = [], accounts = [], onCancel, onSaved }) {
  const uid = useId();
  const funds = useMemo(() => fundsFor(accounts, holding), [accounts, holding]);
  const [form, setForm] = useState(() => initialForm(holding, trade, funds));
  const [errors, setErrors] = useState({});
  const [checked, setChecked] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const currency = holding.currency;
  const kind = form.kind;
  const priced = kind !== 'split';
  const moneyMoves = kind === 'buy' || kind === 'sell';
  const noFund = moneyMoves && funds.length === 0;
  const refusalContext = { holdingName: holding.name, currency, trades, formDate: form.trade_date };

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
    setChecked(null);
    setMessage('');
  }

  async function handleCheck() {
    if (busy || noFund) return;
    const { errors: found, args } = tradeArgs(form, holding);
    setErrors(found);
    setMessage('');
    setChecked(null);
    if (!args) return;
    // eslint-disable-next-line no-unused-vars -- the preview takes no tax-to-confirm flag; the save does
    const { p_tax_to_confirm, ...previewArgs } = args;
    setBusy(true);
    const { data, error } = await supabase.rpc('preview_trade', {
      p_holding_id: holding.id,
      ...previewArgs,
      p_traded_at: trade?.traded_at ?? null,
      p_replace_trade_id: trade?.id ?? null,
    });
    setBusy(false);
    if (error) {
      setMessage(`Couldn't check this trade: ${error.message}. Nothing was saved.`);
      return;
    }
    if (!data?.ok) {
      setMessage(refusalMessage(data, refusalContext));
      return;
    }
    setChecked({ args, effect: data });
  }

  async function handleSave() {
    if (!checked || busy) return;
    const { args, effect } = checked;
    setBusy(true);
    // A fix keeps what the form does not show: the trade's time of day and
    // its note. Its kind never changes (the database refuses that).
    const { data, error } = trade
      ? await supabase.rpc('fix_trade', {
          p_trade_id: trade.id,
          p_trade_date: args.p_trade_date,
          p_units: args.p_units,
          p_price: args.p_price,
          p_fees: args.p_fees,
          p_tax_withheld: args.p_tax_withheld,
          p_traded_at: trade.traded_at ?? null,
          p_funds_account_id: args.p_funds_account_id,
          p_tax_to_confirm: args.p_tax_to_confirm,
          p_note: trade.note ?? null,
          p_expected_version: effect.trades_version,
        })
      : await supabase.rpc('record_trade', {
          p_holding_id: holding.id,
          p_kind: args.p_kind,
          p_trade_date: args.p_trade_date,
          p_units: args.p_units,
          p_price: args.p_price,
          p_fees: args.p_fees,
          p_tax_withheld: args.p_tax_withheld,
          p_traded_at: null,
          p_funds_account_id: args.p_funds_account_id,
          p_expected_version: effect.trades_version,
          p_tax_to_confirm: args.p_tax_to_confirm,
        });
    setBusy(false);
    if (error) {
      setMessage(`Couldn't save this trade: ${error.message}. Nothing was saved.`);
      return;
    }
    if (!data?.ok) {
      // Stale included: the form keeps what was typed, and checking again
      // reads the holding afresh in the database, so the next save is on the
      // version it now has. Reloading here would reopen the editor and lose
      // the form.
      setChecked(null);
      setMessage(refusalMessage(data, refusalContext));
      return;
    }
    await onSaved();
  }

  // This form sits inside the holding editor's own form. Enter in one of its
  // fields must check the trade, never submit (save) the holding around it.
  function onKeyDown(e) {
    if (e.key === 'Enter' && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) {
      e.preventDefault();
      handleCheck();
    }
  }

  const fundName = (fundId) => (accounts ?? []).find((a) => a.id === fundId)?.name ?? 'The fund';
  const lines = checked ? previewLines(checked, { holding, currency, fundName, accounts }) : [];
  const field = (key) => `${uid}-${key}`;

  return (
    <div className="ht-form" onKeyDown={onKeyDown}>
      <div className="te-fieldlabel">{trade ? `Fix ${tradeRow(trade, currency).title}` : 'Record a trade'}</div>

      {!trade && (
        <div className="om-scope-list" role="group" aria-label="Kind of trade">
          {KINDS.map((k) => (
            <button key={k} type="button" className="om-scope" data-active={kind === k} aria-pressed={kind === k} onClick={() => set('kind', k)}>
              {TRADE_KIND_LABELS[k]}
            </button>
          ))}
        </div>
      )}

      <div className="te-fieldgrid">
        <div className="te-fieldcell">
          <label className="te-fieldlabel" htmlFor={field('date')}>
            Date
          </label>
          <input
            id={field('date')}
            className="te-fieldvalue"
            type="date"
            value={form.trade_date}
            max={householdToday()}
            // The opening entry is the day the history starts; moving it
            // would move every trade's place in it.
            readOnly={kind === 'opening'}
            onChange={(e) => set('trade_date', e.target.value)}
          />
          {errors.trade_date && <span className="ov-warn ht-error">{errors.trade_date}</span>}
        </div>
        <div className="te-fieldcell">
          <label className="te-fieldlabel" htmlFor={field('units')}>
            {kind === 'split' ? 'New units per old unit' : 'Units traded'}
          </label>
          <input id={field('units')} className="te-fieldvalue" type="number" step="any" min="0" inputMode="decimal" value={form.units} onChange={(e) => set('units', e.target.value)} />
          {errors.units && <span className="ov-warn ht-error">{errors.units}</span>}
        </div>
        {priced && (
          <div className="te-fieldcell">
            <label className="te-fieldlabel" htmlFor={field('price')}>
              Price ({currency})
            </label>
            <input id={field('price')} className="te-fieldvalue" type="number" step="any" min="0" inputMode="decimal" value={form.price} onChange={(e) => set('price', e.target.value)} />
            {errors.price && <span className="ov-warn ht-error">{errors.price}</span>}
          </div>
        )}
        {moneyMoves && (
          <div className="te-fieldcell">
            <label className="te-fieldlabel" htmlFor={field('fees')}>
              Brokerage ({currency})
            </label>
            <input id={field('fees')} className="te-fieldvalue" type="number" step="any" min="0" inputMode="decimal" placeholder="0" value={form.fees} onChange={(e) => set('fees', e.target.value)} />
            {errors.fees && <span className="ov-warn ht-error">{errors.fees}</span>}
          </div>
        )}
        {kind === 'sell' && (
          <div className="te-fieldcell te-span2">
            <label className="te-fieldlabel" htmlFor={field('tax')}>
              {currency === 'INR' ? 'Tax withheld (leave blank if not known yet)' : `Tax withheld (${currency})`}
            </label>
            <input id={field('tax')} className="te-fieldvalue" type="number" step="any" min="0" inputMode="decimal" value={form.tax_withheld} onChange={(e) => set('tax_withheld', e.target.value)} />
            {errors.tax_withheld && <span className="ov-warn ht-error">{errors.tax_withheld}</span>}
          </div>
        )}
        {moneyMoves && funds.length > 0 && (
          <div className="te-fieldcell te-span2">
            <label className="te-fieldlabel" htmlFor={field('fund')}>
              Fund
            </label>
            <select id={field('fund')} className="te-fieldvalue" value={form.funds_account_id} onChange={(e) => set('funds_account_id', e.target.value)}>
              {funds.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {noFund && (
        <p className="ov-warn" style={{ fontSize: 12.5 }}>
          There is no {currency} Broker funds account. Add one in Accounts.
        </p>
      )}

      {message && (
        <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
          {message}
        </p>
      )}

      {checked && (
        <div className="ht-preview" aria-live="polite">
          {lines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}

      <div className="ht-form-actions">
        {/* Not "Cancel": the holding editor around this form has its own. */}
        <button type="button" className="om-btn" onClick={onCancel} disabled={busy}>
          Back to trades
        </button>
        <button type="button" className="om-btn" onClick={handleCheck} disabled={busy || noFund}>
          Check
        </button>
        <button type="button" className="om-btn ov-btn-primary" onClick={handleSave} disabled={busy || !checked}>
          Save trade
        </button>
      </div>
    </div>
  );
}

// What the database said the trade would do, as lines: the holding before and
// after, a sale's profit, the fund's movement, a rupee sale's tax still to
// come, then the preview's warnings.
function previewLines({ args, effect }, { holding, currency, fundName, accounts }) {
  const lines = [];
  const avgBefore = Number(effect.avg_before);
  const avgAfter = Number(effect.holding_avg_after);
  const average = avgBefore === avgAfter ? `${currency} ${money2(avgAfter)}` : `${currency} ${money2(avgBefore)} → ${currency} ${money2(avgAfter)}`;
  lines.push(`${holding.name}: ${formatUnits(effect.units_before)} → ${formatUnits(effect.holding_units_after)} shares, average ${average}`);
  if (args.p_kind === 'sell' && effect.realised != null) {
    const realised = Number(effect.realised);
    lines.push(realised < 0 ? `Loss ${currency} ${money2(-realised)}` : `Profit ${currency} ${money2(realised)}`);
  }
  const delta = Number(effect.funds_delta ?? 0);
  if (delta !== 0) lines.push(`${fundName(effect.funds_account_id)} ${delta > 0 ? '+' : '-'}${currency} ${money2(Math.abs(delta))}`);
  if (args.p_tax_to_confirm) lines.push('Tax: to confirm from the broker\'s statement.');
  const fund = (accounts ?? []).find((a) => a.id === effect.funds_account_id);
  lines.push(
    ...warningLines(effect, {
      holdingName: holding.name,
      fundName: fundName(effect.funds_account_id),
      fundConfirmed: fund?.balance_as_of != null,
      currency,
      lastPrice: holding.current_price ?? null,
    }),
  );
  return lines;
}
