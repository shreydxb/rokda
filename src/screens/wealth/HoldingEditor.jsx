import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { ASSET_CLASS_LABELS } from '../../lib/holdings';
import '../money/TransactionEditor.css';

function initialForm(holding) {
  if (holding) {
    return {
      name: holding.name,
      asset_class: holding.asset_class,
      currency: holding.currency ?? 'AED',
      value_aed: String(holding.value_aed ?? 0),
      owner: holding.is_shared ? 'shared' : (holding.owner_member_id ?? ''),
      quantity: holding.quantity != null ? String(holding.quantity) : '',
      avg_price: holding.avg_price != null ? String(holding.avg_price) : '',
      current_price: holding.current_price != null ? String(holding.current_price) : '',
      invested_value_aed: holding.invested_value_aed != null ? String(holding.invested_value_aed) : '',
      day_change_pct: holding.day_change_pct != null ? String(holding.day_change_pct) : '',
    };
  }
  return {
    name: '', asset_class: 'us_equity', currency: 'USD', value_aed: '', owner: 'shared',
    quantity: '', avg_price: '', current_price: '', invested_value_aed: '', day_change_pct: '',
  };
}

export default function HoldingEditor({ holding, householdId, members, onClose, onSaved }) {
  const [form, setForm] = useState(() => initialForm(holding));
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

  const nameError = form.name.trim() === '' ? 'Name it.' : '';

  async function handleSave(e) {
    e.preventDefault();
    if (nameError) {
      setError(nameError);
      return;
    }
    setSaving(true);
    setError('');

    const payload = {
      household_id: householdId,
      name: form.name.trim(),
      asset_class: form.asset_class,
      currency: form.currency || 'AED',
      value_aed: Number(form.value_aed) || 0,
      is_shared: form.owner === 'shared',
      owner_member_id: form.owner === 'shared' ? null : form.owner,
      last_refreshed: new Date().toISOString(),
      quantity: form.quantity.trim() === '' ? null : Number(form.quantity),
      avg_price: form.avg_price.trim() === '' ? null : Number(form.avg_price),
      current_price: form.current_price.trim() === '' ? null : Number(form.current_price),
      invested_value_aed: form.invested_value_aed.trim() === '' ? null : Number(form.invested_value_aed),
      day_change_pct: form.day_change_pct.trim() === '' ? null : Number(form.day_change_pct),
    };

    const query = holding
      ? supabase.from('holdings').update(payload).eq('id', holding.id)
      : supabase.from('holdings').insert(payload);

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
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label={holding ? 'Edit holding' : 'Add holding'}>
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
              <input type="number" step="0.01" className="te-hero-input" value={form.value_aed} onChange={(e) => set('value_aed', e.target.value)} placeholder="0" />
            </div>
          </div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: -10 }}>
            Value is entered in AED directly — no live FX conversion.
          </div>

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
          </div>

          <div>
            <span className="te-fieldlabel">Pricing detail (optional)</span>
            <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 4, marginBottom: 10 }}>
              Fills in the richer holdings table (units, avg price, P&amp;L). Manual for now — there's no live
              price feed, so "Today" only updates when you re-enter it.
            </div>
            <div className="te-fieldgrid">
              <div className="te-fieldcell">
                <span className="te-fieldlabel">Units</span>
                <input className="te-fieldvalue" type="number" step="any" value={form.quantity} onChange={(e) => set('quantity', e.target.value)} placeholder="—" />
              </div>
              <div className="te-fieldcell">
                <span className="te-fieldlabel">Avg price ({form.currency || '—'})</span>
                <input className="te-fieldvalue" type="number" step="any" value={form.avg_price} onChange={(e) => set('avg_price', e.target.value)} placeholder="—" />
              </div>
              <div className="te-fieldcell">
                <span className="te-fieldlabel">Price now ({form.currency || '—'})</span>
                <input className="te-fieldvalue" type="number" step="any" value={form.current_price} onChange={(e) => set('current_price', e.target.value)} placeholder="—" />
              </div>
              <div className="te-fieldcell">
                <span className="te-fieldlabel">Invested (AED)</span>
                <input className="te-fieldvalue" type="number" step="0.01" value={form.invested_value_aed} onChange={(e) => set('invested_value_aed', e.target.value)} placeholder="—" />
              </div>
              <div className="te-fieldcell">
                <span className="te-fieldlabel">Day change (%)</span>
                <input className="te-fieldvalue" type="number" step="any" value={form.day_change_pct} onChange={(e) => set('day_change_pct', e.target.value)} placeholder="—" />
              </div>
            </div>
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

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
              {error}
            </p>
          )}

          <div className="te-sticky-actions">
            <div className="te-actions" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
              {holding && (
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
                      {saving ? 'Saving…' : holding ? 'Save changes' : 'Add holding'}
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
