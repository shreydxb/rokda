import { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import '../money/TransactionEditor.css';

export default function RuleEditor({ rule, householdId, categories, onClose, onSaved }) {
  const [pattern, setPattern] = useState(rule?.pattern ?? '');
  const [matchType, setMatchType] = useState(rule?.match_type ?? 'contains');
  const [categoryId, setCategoryId] = useState(rule?.category_id ?? categories[0]?.id ?? '');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const patternError = pattern.trim() === '' ? 'Enter a merchant pattern.' : '';

  async function handleSave(e) {
    e.preventDefault();
    if (patternError || !categoryId) {
      setError(patternError || 'Choose a category.');
      return;
    }
    setSaving(true);
    setError('');

    const payload = { pattern: pattern.trim(), match_type: matchType, category_id: categoryId, updated_at: new Date().toISOString() };
    const query = rule
      ? supabase.from('category_rules').update(payload).eq('id', rule.id)
      : supabase.from('category_rules').insert({ ...payload, household_id: householdId });

    const { error: saveError } = await query;
    setSaving(false);
    if (saveError) {
      setError(saveError.message);
      return;
    }
    await onSaved();
  }

  async function toggleArchived() {
    setSaving(true);
    const { error: saveError } = await supabase.from('category_rules').update({ archived: !rule.archived }).eq('id', rule.id);
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
    const { error: delError } = await supabase.from('category_rules').delete().eq('id', rule.id);
    setSaving(false);
    if (delError) {
      setError(delError.message);
      return;
    }
    await onSaved();
  }

  return (
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label={rule ? 'Edit rule' : 'Add rule'}>
        <div className="te-head">
          <div className="ov-kicker">{rule ? 'Edit rule' : 'Add a rule'}</div>
          <button type="button" className="te-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          <label className="te-field">
            <span>Merchant pattern</span>
            <input type="text" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="e.g. CARREFOUR" aria-invalid={!!patternError} />
          </label>

          <div className="te-type">
            {[
              ['contains', 'Contains'],
              ['starts_with', 'Starts with'],
            ].map(([k, label]) => (
              <button key={k} type="button" className="om-seg" data-active={matchType === k} onClick={() => setMatchType(k)}>
                {label}
              </button>
            ))}
          </div>

          <label className="te-field">
            <span>Category</span>
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: -8 }}>
            Matching is case-insensitive against the transaction's merchant field. Save, then use "Apply now" on the list to
            backfill existing uncategorised transactions.
          </div>

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
              {error}
            </p>
          )}

          <div className="te-actions">
            {rule && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="om-btn" onClick={toggleArchived} disabled={saving}>
                  {rule.archived ? 'Unarchive' : 'Archive'}
                </button>
                <button type="button" className="om-btn te-delete" onClick={handleDelete} disabled={saving}>
                  {confirmingDelete ? 'Confirm delete?' : 'Delete'}
                </button>
              </div>
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
