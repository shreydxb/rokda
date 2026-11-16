import { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { formatPct } from '../../lib/money';
import { SECTOR_LABELS, largestConcentration } from '../../lib/holdings';
import { Chip, InfoButton, ProgressBar } from '../../design-system/kit';

// How much of the investments sits in one place, under Allocation (Planning
// audit, 4.17; the revamp, phase 5b, design/prototype allocationCard): the
// largest sector or single holding, whichever is more, as a share of
// everything invested, against the household's cap, which the bar marks with
// a tick. Sectors come from each holding's tag; "{n} untagged" opens the
// largest holding still without one. The cap is set here, beside what it
// governs, and saved for the household.
export default function Concentration({ holdings, scopeMemberId, household, onCapSaved, onOpenHolding }) {
  const c = largestConcentration(holdings, scopeMemberId, household?.concentration_cap_pct);
  const [editing, setEditing] = useState(false);
  const [cap, setCap] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  if (!c) return null;

  function openCap() {
    setCap(c.cap ? String(c.cap.pct) : '');
    setError('');
    setEditing(true);
  }

  async function saveCap(value) {
    setSaving(true);
    setError('');
    const { error: saveError } = await supabase.from('households').update({ concentration_cap_pct: value }).eq('id', household.id);
    setSaving(false);
    if (saveError) {
      setError(saveError.message);
      return;
    }
    setEditing(false);
    await onCapSaved();
  }

  function submit(e) {
    e.preventDefault();
    const n = Number(cap);
    if (cap.trim() === '' || !(n > 0 && n <= 100)) {
      setError('Enter a share above 0 and at most 100.');
      return;
    }
    saveCap(Math.round(n * 100) / 100);
  }

  // A share that rounds to the cap but is past it reads 25.4%, not 25%.
  const decimals = c.cap && Math.round(c.share * 100) === c.cap.pct ? 1 : 0;
  const pct = (v) => formatPct(v, { decimals });
  const what =
    c.kind === 'sector' ? `${c.name} · sector` : c.sector ? `${c.name} · one holding in ${SECTOR_LABELS[c.sector] ?? c.sector}` : `${c.name} · one holding`;

  return (
    <div className="inv-conc">
      <div className="inv-conc-head">
        <span className="inv-conc-label">
          Largest concentration
          <InfoButton about="Largest concentration">
            The largest sector, or single holding, as a share of everything invested (cash left out), against the household&rsquo;s cap: the tick marks
            the cap. A fund spread across sectors counts in none, and a holding with no sector yet counts only on its own.
          </InfoButton>
        </span>
        {c.cap && <span className="inv-ink3">{`cap ${c.cap.pct}%`}</span>}
      </div>
      {c.kind === 'spread' ? (
        <p className="inv-conc-spread">Nothing stands out: everything invested is in funds spread across sectors.</p>
      ) : (
        <>
          <div className="inv-conc-row">
            <span className="inv-conc-name">{what}</span>
            <span className="inv-conc-fig">{pct(c.share)}</span>
          </div>
          <ProgressBar label={`${c.name}: ${pct(c.share)} of investments`} value={c.share} max={1} tick={c.cap ? c.cap.pct / 100 : null} tone={c.cap?.above ? 'warn' : 'accent'} format={pct} />
        </>
      )}
      <div className="inv-conc-foot">
        {c.cap && c.kind !== 'spread' && (c.cap.above ? <Chip tone="warn">{`Above ${c.cap.pct}% cap`}</Chip> : <Chip tone="pos">{`Within ${c.cap.pct}% cap`}</Chip>)}
        {c.untagged > 0 && c.untaggedId && (
          <button type="button" className="ds-chip ds-chip-warn" onClick={() => onOpenHolding(c.untaggedId)}>
            {`${c.untagged} untagged`}
          </button>
        )}
        <span className="inv-grow" />
        {!editing && (
          <button type="button" className="ds-link ds-link-accent" onClick={openCap}>
            {c.cap ? 'Change cap' : 'Set a cap'}
          </button>
        )}
      </div>
      {editing && (
        <form className="inv-cap-form" onSubmit={submit} noValidate>
          <label htmlFor="concentration-cap">No single sector or holding above</label>
          <span className="inv-cap-field">
            {/* Opened by its own button, so focus follows the press. */}
            <input id="concentration-cap" className="ds-select ds-select-sm inv-cap-input" type="number" inputMode="decimal" min="1" max="100" step="any" value={cap} onChange={(e) => setCap(e.target.value)} autoFocus />
            <span className="inv-ink3">% of investments</span>
          </span>
          <span className="inv-cap-actions">
            <button type="submit" className="ds-btn ds-btn-sm ds-btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            {c.cap && (
              <button type="button" className="ds-btn ds-btn-sm" disabled={saving} onClick={() => saveCap(null)}>
                No cap
              </button>
            )}
            <button type="button" className="ds-btn ds-btn-sm" disabled={saving} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </span>
          <p className="inv-ink3 inv-cap-note">For the household: both of you see the same cap.</p>
          {error && (
            <p className="inv-neg inv-cap-note" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
