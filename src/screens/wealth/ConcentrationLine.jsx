import { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { formatPct } from '../../lib/money';
import { SECTOR_LABELS, largestConcentration } from '../../lib/holdings';

// One line under Allocation saying how much of the investments sits in one
// place, and whether that is past the household's cap (Planning audit, 4.17).
// The largest sector or single holding, whichever is more; sectors come from
// each holding's tag. The cap is set here, beside what it governs, and saved
// for the household.
export default function ConcentrationLine({ holdings, scopeMemberId, household, onCapSaved }) {
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
  const pct = formatPct(c.share, { decimals: c.cap && Math.round(c.share * 100) === c.cap.pct ? 1 : 0 });
  const what =
    c.kind === 'spread' ? (
      'Nothing stands out: everything invested is in funds spread across sectors'
    ) : (
      <>
        Largest concentration: {c.name}
        {c.kind === 'holding' && `${c.sector ? ` (${SECTOR_LABELS[c.sector]})` : ''}, one holding`}, <span className="fig">{pct}</span> of investments
      </>
    );

  return (
    <div className="wl-concentration">
      <p className="wl-concentration-line">
        <span>{what}</span>
        {c.cap && c.kind !== 'spread' && (
          <span className={c.cap.above ? 'ov-warn' : 'ov-muted'}>
            {c.cap.above ? `above your ${c.cap.pct}% cap` : `within your ${c.cap.pct}% cap`}
          </span>
        )}
        {!editing && (
          <button type="button" className="wl-concentration-cap" onClick={openCap}>
            {c.cap ? 'Change cap' : 'Set a cap'}
          </button>
        )}
      </p>
      {c.untagged > 0 && (
        <p className="ov-muted wl-concentration-note">
          {c.untagged} holding{c.untagged === 1 ? ' has' : 's have'} no sector yet, so {c.untagged === 1 ? 'it counts' : 'each counts'} only on its own. Tag a
          holding&rsquo;s sector in its editor.
        </p>
      )}
      {editing && (
        <form className="wl-cap-form" onSubmit={submit} noValidate>
          <label htmlFor="concentration-cap">No single sector or holding above</label>
          <span className="wl-cap-field">
            {/* Opened by its own button, so focus follows the press. */}
            <input id="concentration-cap" className="wl-cap-input" type="number" inputMode="decimal" min="1" max="100" step="any" value={cap} onChange={(e) => setCap(e.target.value)} autoFocus />
            <span className="ov-muted">% of investments</span>
          </span>
          <span className="wl-cap-actions">
            <button type="submit" className="om-btn" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            {c.cap && (
              <button type="button" className="om-btn" disabled={saving} onClick={() => saveCap(null)}>
                No cap
              </button>
            )}
            <button type="button" className="om-btn" disabled={saving} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </span>
          <p className="ov-muted wl-concentration-note">For the household: both of you see the same cap.</p>
          {error && (
            <p className="ov-warn wl-concentration-note" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
