import { useEffect, useId, useRef, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { canRecord, dividendRefusalMessage, dividendRow, dividendsOfHolding, formatPerShare, reviewText } from '../../lib/dividends';
import DividendForm from './DividendForm';
import './HoldingTrades.css';

// A holding's dividends, newest first, in its editor (SHR-366): where one is
// recorded, fixed, skipped or added, and where a row the feed has flagged is
// answered. Telegram asks about most of them; this is where the rest are
// done. Every action waits while the holding itself has unsaved changes, or
// a trade is being typed: a save reloads the holding (disabledReason).
export default function HoldingDividends({ holding, dividends, specialParts, accounts, failed = false, disabledReason, onChanged, onFormOpen }) {
  const list = dividendsOfHolding(dividends, holding.id);
  const uid = useId();
  const reasonId = `${uid}-reason`;
  const addRef = useRef(null);
  // The form open, if any: which change, to which dividend (none to add).
  const [form, setFormState] = useState(null);
  const setForm = (value) => {
    setFormState(value);
    onFormOpen?.(value !== null);
  };
  // An answer being sent from a row, and what the database said if it refused.
  const [busyId, setBusyId] = useState(null);
  const [refusal, setRefusal] = useState(null);
  // The one-off part being given for a row's feed dividend.
  const [oneOff, setOneOff] = useState(null);
  const disabled = !!disabledReason || !!busyId;

  // Back from the form, focus returns to "Add a dividend": the button that
  // opened it is gone.
  const formWasOpen = useRef(false);
  useEffect(() => {
    if (formWasOpen.current && !form) addRef.current?.focus();
    formWasOpen.current = !!form;
  }, [form]);

  async function saved() {
    if (onChanged) await onChanged();
    setForm(null);
  }

  // Keep as it is, or link it to the feed's dividend: one call, answered in
  // the row when refused.
  async function answer(row, name, args) {
    setBusyId(row.id);
    setRefusal(null);
    const { data, error } = await supabase.rpc(name, args);
    setBusyId(null);
    if (error || !data?.ok) {
      setRefusal({ id: row.id, message: error ? `Couldn't save that: ${error.message}. Nothing was changed.` : dividendRefusalMessage(data?.error) });
      return;
    }
    if (onChanged) await onChanged();
  }

  async function saveOneOff(row) {
    const value = Number(oneOff.value);
    if (oneOff.value.trim() === '' || !Number.isFinite(value) || value < 0) {
      setOneOff({ ...oneOff, error: 'Enter an amount per share of 0 or more.' });
      return;
    }
    setBusyId(row.id);
    const { data, error } = await supabase.rpc('set_special_part', { p_event_id: row.event_id, p_special_per_share: value });
    setBusyId(null);
    if (error || !data?.ok) {
      setOneOff({ ...oneOff, error: error ? `Couldn't save that: ${error.message}. Nothing was changed.` : dividendRefusalMessage(data?.error) });
      return;
    }
    setOneOff(null);
    if (onChanged) await onChanged();
  }

  if (failed) {
    return (
      <section className="ht-section" aria-labelledby={`${uid}-title`}>
        <span className="te-fieldlabel" id={`${uid}-title`}>
          Dividends
        </span>
        <p className="ov-warn" role="alert" style={{ fontSize: 12.5, margin: 0 }}>
          Couldn&rsquo;t load this holding&rsquo;s dividends. Refresh the page to try again.
        </p>
      </section>
    );
  }

  if (form) {
    return (
      <section className="ht-section" aria-label="Dividends">
        <DividendForm holding={holding} dividend={form.dividend} action={form.action} accounts={accounts} onCancel={() => setForm(null)} onSaved={saved} />
      </section>
    );
  }

  const describedBy = (titleId) => [titleId, disabledReason ? reasonId : null].filter(Boolean).join(' ');

  return (
    <section className="ht-section" aria-labelledby={`${uid}-title`}>
      <span className="te-fieldlabel" id={`${uid}-title`}>
        Dividends
      </span>
      {disabledReason && (
        <div className="ov-muted" id={reasonId} style={{ fontSize: 11.5 }}>
          {disabledReason}
        </div>
      )}
      {list.length === 0 ? (
        <p className="ov-muted" style={{ fontSize: 12.5, margin: 0 }}>
          No dividends on this holding yet.
        </p>
      ) : (
        <ul className="ht-list" aria-label="Dividends">
          {list.map((d) => {
            const row = dividendRow(d, accounts);
            const titleId = `${uid}-t-${d.id}`;
            const review = reviewText(d);
            const special = d.event_id ? (specialParts ?? []).find((p) => p.event_id === d.event_id) : null;
            const giving = oneOff?.id === d.id;
            return (
              <li key={d.id} className="ht-row hd-row">
                <div className="mn-row-main">
                  <div id={titleId}>{row.title}</div>
                  <div className="ov-muted">{row.detail}</div>
                </div>
                {special && (
                  <p className="ov-muted hd-note">{`${d.currency} ${formatPerShare(special.special_per_share)} per share was a one-off.`}</p>
                )}
                {review && <p className="ov-warn hd-note">{review}</p>}
                {refusal?.id === d.id && (
                  <p className="ov-warn hd-note" role="alert">
                    {refusal.message}
                  </p>
                )}
                {giving ? (
                  <div className="hd-oneoff">
                    <div className="te-fieldcell">
                      <label className="te-fieldlabel" htmlFor={`${uid}-oneoff`}>
                        {`One-off part per share (${d.currency})`}
                      </label>
                      <input
                        id={`${uid}-oneoff`}
                        className="te-fieldvalue"
                        type="number"
                        step="any"
                        min="0"
                        inputMode="decimal"
                        value={oneOff.value}
                        onChange={(e) => setOneOff({ ...oneOff, value: e.target.value, error: null })}
                        onKeyDown={(e) => {
                          // Inside the holding editor's form: Enter saves this, not the holding.
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            saveOneOff(d);
                          }
                        }}
                      />
                      {oneOff.error && (
                        <span className="ov-warn ht-error" role="alert">
                          {oneOff.error}
                        </span>
                      )}
                    </div>
                    <div className="ht-actions">
                      <button type="button" className="om-btn" disabled={!!busyId} onClick={() => setOneOff(null)}>
                        Back
                      </button>
                      <button type="button" className="om-btn ov-btn-primary" disabled={!!busyId} onClick={() => saveOneOff(d)}>
                        Save one-off part
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="ht-actions hd-actions">
                    {canRecord(d) && (
                      <button type="button" className="om-btn" aria-describedby={describedBy(titleId)} disabled={disabled} onClick={() => setForm({ action: 'record', dividend: d })}>
                        Record
                      </button>
                    )}
                    {d.status !== 'skipped' && (
                      <button type="button" className="om-btn" aria-describedby={describedBy(titleId)} disabled={disabled} onClick={() => setForm({ action: 'fix', dividend: d })}>
                        Fix
                      </button>
                    )}
                    {d.status === 'skipped' ? (
                      <button type="button" className="om-btn" aria-describedby={describedBy(titleId)} disabled={disabled} onClick={() => setForm({ action: 'restore', dividend: d })}>
                        Restore
                      </button>
                    ) : (
                      <button type="button" className="om-btn" aria-describedby={describedBy(titleId)} disabled={disabled} onClick={() => setForm({ action: 'skip', dividend: d })}>
                        Skip
                      </button>
                    )}
                    {d.review_reason && (
                      <button
                        type="button"
                        className="om-btn"
                        aria-describedby={describedBy(titleId)}
                        disabled={disabled}
                        onClick={() => answer(d, 'keep_dividend', { p_dividend_id: d.id, p_expected_version: d.version })}
                      >
                        Keep as it is
                      </button>
                    )}
                    {d.review_reason === 'possible_duplicate' && d.review_event_id && (
                      <button
                        type="button"
                        className="om-btn"
                        aria-describedby={describedBy(titleId)}
                        disabled={disabled}
                        onClick={() => answer(d, 'link_dividend', { p_dividend_id: d.id, p_event_id: d.review_event_id, p_expected_version: d.version })}
                      >
                        {"It's this one"}
                      </button>
                    )}
                    {/* Rarely needed, so a text action, not a fifth box. */}
                    {d.event_id && (
                      <button
                        type="button"
                        className="ov-link te-rowaction"
                        aria-describedby={describedBy(titleId)}
                        disabled={disabled}
                        onClick={() => setOneOff({ id: d.id, value: special ? String(Number(special.special_per_share)) : '', error: null })}
                      >
                        Part was a one-off…
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div>
        <button type="button" className="om-btn" ref={addRef} disabled={disabled} aria-describedby={disabledReason ? reasonId : undefined} onClick={() => setForm({ action: 'add', dividend: null })}>
          Add a dividend
        </button>
      </div>
    </section>
  );
}
