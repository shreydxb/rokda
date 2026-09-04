import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import '../money/TransactionEditor.css';

export default function RuleEditor({ rule, householdId, categories, onClose, onSaved }) {
  const [pattern, setPattern] = useState(rule?.pattern ?? '');
  const [matchType, setMatchType] = useState(rule?.match_type ?? 'contains');
  const [categoryId, setCategoryId] = useState(rule?.category_id ?? categories[0]?.id ?? '');
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

  function requestClose() {
    if (dirty && !confirmingClose) {
      setConfirmingClose(true);
      return;
    }
    onClose();
  }

  const patternError = pattern.trim() === '' ? 'Enter a merchant pattern.' : '';
  const categoryName = categories.find((c) => c.id === categoryId)?.name;

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
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label={rule ? 'Edit rule' : 'Add rule'}>
        <div className="te-head">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="ov-kicker">{rule ? 'Edit rule' : 'New rule'}</span>
              {dirty && <span className="te-dirty-chip">Unsaved</span>}
            </div>
            <div className="te-title">{rule ? `"${rule.pattern}"` : 'Add a rule'}</div>
          </div>
          <button type="button" className="te-close" onClick={requestClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          <div className="te-fieldgrid">
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Merchant pattern</span>
              <input
                className="te-fieldvalue"
                type="text"
                value={pattern}
                onChange={(e) => {
                  setPattern(e.target.value);
                  setDirty(true);
                }}
                placeholder="e.g. CARREFOUR"
                aria-invalid={!!patternError}
              />
            </div>
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Category</span>
              <select
                className="te-fieldvalue"
                value={categoryId}
                onChange={(e) => {
                  setCategoryId(e.target.value);
                  setDirty(true);
                }}
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <span className="te-fieldlabel">Match type</span>
            <div className="te-chips">
              {[
                ['contains', 'Contains'],
                ['starts_with', 'Starts with'],
              ].map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  className="om-seg"
                  data-active={matchType === k}
                  onClick={() => {
                    setMatchType(k);
                    setDirty(true);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="ov-muted" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
            Matching is case-insensitive against the transaction's merchant field
            {categoryName ? ` — matches go to ${categoryName}` : ''}. Save, then use "Apply now" on the list to backfill existing
            uncategorised transactions.
          </div>

          {rule && (
            <button type="button" className="te-togglerow" onClick={toggleArchived} disabled={saving}>
              <div>
                <div className="te-togglelabel">Archived</div>
                <div className="te-togglenote">Archived rules stop suggesting and can't be applied</div>
              </div>
              <span className={`te-togglestate ${rule.archived ? 'te-togglestate-warn' : ''}`}>{rule.archived ? 'Archived' : 'Active'}</span>
            </button>
          )}

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
              {error}
            </p>
          )}

          <div className="te-sticky-actions">
            <div className="te-actions" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
              {rule && (
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
                      {saving ? 'Saving…' : rule ? 'Save changes' : 'Add rule'}
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
