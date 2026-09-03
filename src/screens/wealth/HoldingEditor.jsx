import { useState } from 'react';
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
    };
  }
  return { name: '', asset_class: 'us_equity', currency: 'USD', value_aed: '', owner: 'shared' };
}

export default function HoldingEditor({ holding, householdId, members, onClose, onSaved }) {
  const [form, setForm] = useState(() => initialForm(holding));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
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
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label={holding ? 'Edit holding' : 'Add holding'}>
        <div className="te-head">
          <div className="ov-kicker">{holding ? 'Edit holding' : 'Add holding'}</div>
          <button type="button" className="te-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          <label className="te-field">
            <span>Name</span>
            <input type="text" value={form.name} onChange={(e) => set('name', e.target.value)} aria-invalid={!!nameError} />
          </label>

          <label className="te-field">
            <span>Asset class</span>
            <select value={form.asset_class} onChange={(e) => set('asset_class', e.target.value)}>
              {Object.entries(ASSET_CLASS_LABELS).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <div className="te-row">
            <label className="te-field te-amount">
              <span>Value (AED)</span>
              <input type="number" step="0.01" value={form.value_aed} onChange={(e) => set('value_aed', e.target.value)} />
            </label>
            <label className="te-field te-currency">
              <span>Native currency</span>
              <input type="text" value={form.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} maxLength={3} />
            </label>
          </div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: -6 }}>
            Value is entered in AED directly — no live FX conversion. "Native currency" is just a label.
          </div>

          <label className="te-field">
            <span>Owner</span>
            <select value={form.owner} onChange={(e) => set('owner', e.target.value)}>
              <option value="shared">Shared</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}
                </option>
              ))}
            </select>
          </label>

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
              {error}
            </p>
          )}

          <div className="te-actions">
            {holding && (
              <button type="button" className="om-btn te-delete" onClick={handleDelete} disabled={saving}>
                {confirmingDelete ? 'Confirm delete?' : 'Delete'}
              </button>
            )}
            <div className="te-actions-right">
              <button type="button" className="om-btn" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="om-btn ov-btn-primary" disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
