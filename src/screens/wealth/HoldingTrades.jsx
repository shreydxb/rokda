import { useEffect, useId, useRef, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { formatMoney } from '../../lib/money';
import { formatUnits, refusalMessage, tradeRow, tradesOfHolding } from '../../lib/trades';
import TradeForm from './TradeForm';
import './HoldingTrades.css';

const dayMonth = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

// A traded holding's trades, newest first, in its editor (SHR-371). This is
// where an older trade is fixed or deleted; Telegram is where most are
// recorded. Every action waits while the holding itself has unsaved changes:
// a trade reloads the holding, which would drop them (disabledReason).
export default function HoldingTrades({ holding, trades, failed = false, accounts, disabledReason, onChanged, onFormOpen }) {
  const list = tradesOfHolding(trades, holding.id);
  const disabled = !!disabledReason;
  const uid = useId();
  const reasonId = `${uid}-reason`;
  const recordRef = useRef(null);
  const keepRef = useRef(null);
  // Which trade the form is open for: 'new' to record one, a trade to fix it.
  const [formFor, setFormForState] = useState(null);
  // The editor hides its own Save while a trade form is open: under a trade's
  // preview, "Save changes" would read as saving the trade.
  const setFormFor = (value) => {
    setFormForState(value);
    onFormOpen?.(value !== null);
  };
  // The delete being asked about: the trade, the database's preview of
  // undoing it (or why it can't be), and whether it is being sent.
  const [deleting, setDeleting] = useState(null);

  // Focus goes where the person is: back to "Record a trade" when the form
  // closes, since the button that opened it is gone; to the safe choice when
  // a delete asks, with the question read alongside it.
  const formWasOpen = useRef(false);
  useEffect(() => {
    if (formWasOpen.current && !formFor) recordRef.current?.focus();
    formWasOpen.current = !!formFor;
  }, [formFor]);
  const asking = !!deleting && !deleting.busy && !!(deleting.effect || deleting.message);
  useEffect(() => {
    if (asking) keepRef.current?.focus();
  }, [asking]);

  // A saved trade reloads the screen, which opens the editor afresh on the
  // holding's new version (Investments keys it so), with this form closed.
  async function saved() {
    if (onChanged) await onChanged();
    // Normally the reload has already reopened the editor; this closes the
    // form if it did not.
    setFormFor(null);
  }

  async function askDelete(t) {
    setDeleting({ trade: t, effect: null, message: '', busy: true });
    const { data, error } = await supabase.rpc('preview_delete_trade', { p_trade_id: t.id });
    if (error || !data?.ok) {
      const message = error ? `Couldn't check this delete: ${error.message}. Nothing was saved.` : refusalMessage(data, { holdingName: holding.name, currency: holding.currency, trades: list });
      setDeleting({ trade: t, effect: null, message, busy: false });
      return;
    }
    setDeleting({ trade: t, effect: data, message: '', busy: false });
  }

  async function confirmDelete() {
    const { trade: t, effect } = deleting;
    setDeleting({ ...deleting, busy: true });
    // Saved on the version the question was worked out on: the database gives
    // the version the delete would leave, one above it. The editor's copy of
    // the holding may be older (a trade from Telegram since it opened), and
    // sending that would refuse every delete as stale.
    const { data, error } = await supabase.rpc('delete_trade', { p_trade_id: t.id, p_expected_version: Number(effect.trades_version) - 1 });
    if (error || !data?.ok) {
      const message = error ? `Couldn't delete this trade: ${error.message}. Nothing was saved.` : refusalMessage(data, { holdingName: holding.name, currency: holding.currency, trades: list });
      setDeleting({ trade: t, effect: null, message, busy: false });
      return;
    }
    setDeleting(null);
    if (onChanged) await onChanged();
  }

  if (failed) {
    return (
      <section className="ht-section" aria-labelledby="ht-title">
        <span className="te-fieldlabel" id="ht-title">
          Trades
        </span>
        <p className="ov-warn" role="alert" style={{ fontSize: 12.5, margin: 0 }}>
          Couldn&rsquo;t load this holding&rsquo;s trades. Refresh the page to try again.
        </p>
      </section>
    );
  }

  if (formFor) {
    return (
      <section className="ht-section" aria-label="Trades">
        <TradeForm holding={holding} trade={formFor === 'new' ? null : formFor} trades={list} accounts={accounts} onCancel={() => setFormFor(null)} onSaved={saved} />
      </section>
    );
  }

  return (
    <section className="ht-section" aria-labelledby="ht-title">
      <div className="ht-head">
        <span className="te-fieldlabel" id="ht-title">
          Trades
        </span>
        <button type="button" className="om-btn" ref={recordRef} disabled={disabled} aria-describedby={disabled ? reasonId : undefined} onClick={() => setFormFor('new')}>
          Record a trade
        </button>
      </div>
      {disabledReason && (
        <div className="ov-muted" id={reasonId} style={{ fontSize: 11.5 }}>
          {disabledReason}
        </div>
      )}
      <ul className="ht-list" aria-label="Trades">
        {list.map((t) => {
          const row = tradeRow(t, holding.currency);
          if (asking && deleting.trade.id === t.id) {
            const questionId = `${uid}-q-${t.id}`;
            return (
              <li key={t.id} className="ht-row ht-row-asking">
                {deleting.effect ? (
                  <>
                    <div className="mn-row-main" id={questionId}>
                      {deleteQuestion(t, row.title, deleting.effect, holding, accounts)}
                    </div>
                    <div className="ht-actions">
                      <button type="button" className="om-btn" ref={keepRef} aria-describedby={questionId} onClick={() => setDeleting(null)}>
                        Keep it
                      </button>
                      <button type="button" className="om-btn te-delete" onClick={confirmDelete}>
                        Delete trade
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="mn-row-main ov-warn" role="alert" id={questionId}>
                      {deleting.message}
                    </div>
                    <div className="ht-actions">
                      <button type="button" className="om-btn" ref={keepRef} aria-describedby={questionId} onClick={() => setDeleting(null)}>
                        Keep it
                      </button>
                    </div>
                  </>
                )}
              </li>
            );
          }
          return (
            <li key={t.id} className="ht-row">
              <div className="mn-row-main">
                <div>{row.title}</div>
                <div className="ov-muted">{row.detail}</div>
              </div>
              <div className="ht-actions">
                <button type="button" className="om-btn" aria-label={`Fix ${row.title}`} aria-describedby={disabled ? reasonId : undefined} disabled={disabled || !!deleting} onClick={() => setFormFor(t)}>
                  Fix
                </button>
                {/* The opening entry is where the history starts: it can be
                    corrected, but removing it is undoing the fresh start,
                    which the app does not offer. */}
                {t.kind !== 'opening' && (
                  <button type="button" className="om-btn" aria-label={`Delete ${row.title}`} aria-describedby={disabled ? reasonId : undefined} disabled={disabled || !!deleting} onClick={() => askDelete(t)}>
                    Delete
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// "Delete Sell 6 at USD 150.00 on 29 Oct? ABC: 9 → 15 shares · Dollar broker
// funds -USD 899.00": what the trade was, and what undoing it does, from the
// database's preview of the delete. A fund the delete does not move is left out.
function deleteQuestion(trade, title, effect, holding, accounts) {
  const parts = [`${holding.name}: ${formatUnits(effect.units_before)} → ${formatUnits(effect.holding_units_after)} shares`];
  const delta = Number(effect.funds_delta ?? 0);
  if (delta !== 0) {
    const fund = (accounts ?? []).find((a) => a.id === effect.funds_account_id)?.name ?? 'The fund';
    parts.push(`${fund} ${delta > 0 ? '+' : '-'}${holding.currency} ${formatMoney(Math.abs(delta), { decimals: 2 })}`);
  }
  return `Delete ${title} on ${dayMonth(trade.trade_date)}? ${parts.join(' · ')}`;
}
