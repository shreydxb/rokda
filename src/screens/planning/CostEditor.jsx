import { useEffect, useState } from 'react';
import { useDrawerFocus } from '../../lib/useDrawerFocus';
import { supabase } from '../../lib/supabaseClient';
import { incomesWithoutRate } from '../../lib/forecast';
import '../money/TransactionEditor.css';

// One cost that starts when work stops (Planning audit, 3.13): health cover an
// employer pays until then, residence visa fees. A year's cost in today's
// money, at today's prices and ages; how much faster than inflation it rises
// counts from now, so cover priced at today's ages costs more by the time work
// stops. A cost for each person counts for each person the plan still covers.
// Timing counts from the year work stops, as other income's does.
function initialForm(row) {
  if (row) {
    return {
      name: row.name,
      note: row.note ?? '',
      currency: row.currency ?? 'AED',
      amount: String(row.amount ?? ''),
      perPerson: !!row.per_person,
      rise: Number(row.rise_pct) ? String(Number(row.rise_pct)) : '',
      starts_after_years: String(row.starts_after_years ?? 0),
      lasts: row.lasts_years == null ? 'forever' : 'years',
      lasts_years: row.lasts_years != null ? String(row.lasts_years) : '',
    };
  }
  return { name: '', note: '', currency: 'AED', amount: '', perPerson: false, rise: '', starts_after_years: '0', lasts: 'forever', lasts_years: '' };
}

const whole = (v) => /^\d+$/.test(String(v).trim());
const blank = (v) => String(v).trim() === '';

export default function CostEditor({ row, householdId, household = null, stacked = false, onClose, onSaved }) {
  const drawerRef = useDrawerFocus();
  const [form, setForm] = useState(() => initialForm(row));
  const [dirty, setDirty] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

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

  // The same limits the database enforces, said here in words first.
  const rise = Number(form.rise);
  const problem =
    form.name.trim() === ''
      ? 'Name it.'
      : !(Number(form.amount) > 0)
        ? 'Enter an amount above zero.'
        : !blank(form.rise) && !(Number.isFinite(rise) && rise >= 0 && rise <= 10)
          ? 'A rise between 0% and 10% a year above inflation.'
          : !whole(form.starts_after_years) || Number(form.starts_after_years) > 60
            ? 'Start between 0 and 60 years after work stops.'
            : form.lasts === 'years' && (!whole(form.lasts_years) || Number(form.lasts_years) < 1 || Number(form.lasts_years) > 60)
              ? 'Say how many years it lasts, from 1 to 60.'
              : '';

  async function handleSave(e) {
    e.preventDefault();
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError('');
    const payload = {
      household_id: householdId,
      name: form.name.trim(),
      note: form.note.trim(),
      currency: form.currency,
      amount: Number(form.amount),
      per_person: form.perPerson,
      rise_pct: blank(form.rise) ? 0 : rise,
      starts_after_years: Number(form.starts_after_years),
      lasts_years: form.lasts === 'years' ? Number(form.lasts_years) : null,
      updated_at: new Date().toISOString(),
    };
    const query = row ? supabase.from('after_work_costs').update(payload).eq('id', row.id) : supabase.from('after_work_costs').insert(payload);
    const { error: saveError } = await query;
    setSaving(false);
    if (saveError) {
      setError(saveError.message);
      return;
    }
    await onSaved();
  }

  async function handleDelete() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setSaving(true);
    const { error: delError } = await supabase.from('after_work_costs').delete().eq('id', row.id);
    setSaving(false);
    if (delError) {
      setError(delError.message);
      return;
    }
    await onSaved();
  }

  return (
    <div className={stacked ? 'te-overlay te-overlay-stacked' : 'te-overlay'} onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="te-drawer" ref={drawerRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={row ? 'Edit cost' : 'Add cost'}>
        <div className="te-head">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="ov-kicker">{row ? 'Edit cost' : 'New cost'}</span>
              {dirty && <span className="te-dirty-chip">Unsaved</span>}
            </div>
            <div className="te-title">{row ? row.name : 'A cost that starts when work stops'}</div>
          </div>
          <button type="button" className="te-close" onClick={requestClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          <div>
            <div className="te-hero-label">Amount a year, in today’s money</div>
            <div className="te-hero-row">
              <select className="te-hero-currency-select" value={form.currency} onChange={(e) => set('currency', e.target.value)} aria-label="Currency">
                {['AED', 'INR', 'USD'].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <input type="number" step="0.01" className="te-hero-input" value={form.amount} onChange={(e) => set('amount', e.target.value)} placeholder="0" aria-label="Amount a year" />
            </div>
            {incomesWithoutRate([{ currency: form.currency }], household).length > 0 && (
              <div className="ov-warn" style={{ fontSize: 11.5, marginTop: 6 }}>
                No AED/INR rate is set yet, so this is not counted until one is (Settings → Household).
              </div>
            )}
          </div>

          <div>
            <span className="te-fieldlabel">For</span>
            <div className="om-scope-list" style={{ marginTop: 10 }} role="group" aria-label="Who the amount is for">
              <button type="button" className="om-scope" data-active={!form.perPerson} aria-pressed={!form.perPerson} onClick={() => set('perPerson', false)}>
                The household
              </button>
              <button type="button" className="om-scope" data-active={form.perPerson} aria-pressed={form.perPerson} onClick={() => set('perPerson', true)}>
                Each person
              </button>
            </div>
          </div>

          <div className="te-fieldgrid">
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Name</span>
              <input className="te-fieldvalue" type="text" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Health cover, Visa fees" aria-label="Name" />
            </div>
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Rises above inflation · % a year</span>
              <input className="te-fieldvalue" type="number" step="0.5" value={form.rise} onChange={(e) => set('rise', e.target.value)} placeholder="blank: 0" aria-label="Rise a year above inflation" />
            </div>
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Starts after · years</span>
              <input
                className="te-fieldvalue"
                type="number"
                step="1"
                value={form.starts_after_years}
                onChange={(e) => set('starts_after_years', e.target.value)}
                aria-label="Starts after years from when work stops"
              />
            </div>
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Lasts</span>
              <div className="om-scope-list" style={{ marginTop: 8 }}>
                <button type="button" className="om-scope" data-active={form.lasts === 'forever'} aria-pressed={form.lasts === 'forever'} onClick={() => set('lasts', 'forever')}>
                  For good
                </button>
                <button type="button" className="om-scope" data-active={form.lasts === 'years'} aria-pressed={form.lasts === 'years'} onClick={() => set('lasts', 'years')}>
                  A set number of years
                </button>
              </div>
              {form.lasts === 'years' && (
                <input
                  className="te-fieldvalue"
                  style={{ marginTop: 10 }}
                  type="number"
                  step="1"
                  value={form.lasts_years}
                  onChange={(e) => set('lasts_years', e.target.value)}
                  placeholder="years"
                  aria-label="Lasts for years"
                />
              )}
            </div>
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Note</span>
              <input className="te-fieldvalue" type="text" value={form.note} onChange={(e) => set('note', e.target.value)} placeholder="optional" aria-label="Note" />
            </div>
          </div>

          <div className="ov-muted" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
            Enter what it would cost today, at today&rsquo;s ages. The rise counts from now: health cover usually rises a few percent a year faster
            than prices as you age, so cover priced today costs more by the time work stops. A cost for each person is counted for each person the
            plan still covers, so cover for two halves when one remains. Starts after counts from the year work stops.
          </div>

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
              {error}
            </p>
          )}

          <div className="te-sticky-actions">
            <div className="te-actions" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
              {row && (
                <button type="button" className="om-btn te-delete" onClick={handleDelete} disabled={saving}>
                  {confirmingDelete ? 'Confirm delete?' : 'Delete'}
                </button>
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
                      {saving ? 'Saving…' : row ? 'Save changes' : 'Add cost'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
