import { useState } from 'react';
import { useCloseGuard } from '../../lib/useCloseGuard';
import DiscardPrompt from '../DiscardPrompt';
import { useDrawerFocus } from '../../lib/useDrawerFocus';
import { supabase } from '../../lib/supabaseClient';
import { paysDividends } from '../../lib/holdings';
import { daysSincePriced, historyPointFor, isPendingValuation, todayISODate, valuationChanged } from '../../lib/valuation';
import { formValuation, holdingProblems, holdingSave, initialForm, isAutoValued } from '../../lib/holdingForm';
import { hasBuysOrSales } from '../../lib/trades';
import HoldingTrades from './HoldingTrades';
import HoldingDividends from './HoldingDividends';
import HoldingFields from './HoldingFields';
import '../money/TransactionEditor.css';

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

  // What is wrong with the form, and whether the feed values it
  // (lib/holdingForm.js).
  const problems = holdingProblems(form);
  const problem = problems.name || problems.symbol || problems.rate || problems.fee;
  const dividendFields = paysDividends(form.asset_class);
  const autoValued = isAutoValued(form);

  // An auto-valued holding whose value field is blank because it is disabled
  // and nothing has priced it yet. `Number('') || 0` turned that into a
  // confirmed zero: stamped priced_at, wrote a zero history point, and showed
  // a 100% loss against any cost basis until the first refresh landed -- or
  // permanently, if that refresh failed (QA #6). The stored 0 stays (the
  // column is not null), but nothing is allowed to treat it as a measurement.
  const pendingValuation = isPendingValuation({ holding, valueField: form.value_aed, autoValued });

  // Whether this edit touches the numbers at all — drives both the copy above
  // and whether priced_at moves on save.
  const repricing = !holding || valuationChanged(holding, formValuation(form));
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
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError('');

    // The row, its figures, and whether a dated history point goes with them
    // (lib/holdingForm.js).
    const { payload, valuation, writesHistory } = holdingSave(form, { holding, householdId, asOf, confirmUnchanged });

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
          <HoldingFields
            form={form}
            set={set}
            holding={holding}
            members={members}
            problems={problems}
            traded={traded}
            autoValued={autoValued}
            pendingValuation={pendingValuation}
            repricing={repricing}
            dividendFields={dividendFields}
            lastValuedLabel={lastValuedLabel}
            asOf={asOf}
            setAsOf={setAsOf}
            confirmUnchanged={confirmUnchanged}
            setConfirmUnchanged={setConfirmUnchanged}
            setDirty={setDirty}
            subFormOpen={subFormOpen}
          />

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
