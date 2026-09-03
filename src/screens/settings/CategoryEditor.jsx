import { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import '../money/TransactionEditor.css';

export default function CategoryEditor({ category, householdId, onClose, onSaved }) {
  const [name, setName] = useState(category?.name ?? '');
  const [kind, setKind] = useState(category?.kind ?? 'expense');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const nameError = name.trim() === '' ? 'Name it.' : '';

  async function handleSave(e) {
    e.preventDefault();
    if (nameError) {
      setError(nameError);
      return;
    }
    setSaving(true);
    setError('');

    const payload = { name: name.trim(), kind };
    const query = category
      ? supabase.from('categories').update(payload).eq('id', category.id)
      : supabase.from('categories').insert({ ...payload, household_id: householdId });

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
    const { error: saveError } = await supabase.from('categories').update({ archived: !category.archived }).eq('id', category.id);
    setSaving(false);
    if (saveError) {
      setError(saveError.message);
      return;
    }
    await onSaved();
  }

  return (
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label={category ? 'Edit category' : 'Add category'}>
        <div className="te-head">
          <div className="ov-kicker">{category ? 'Edit category' : 'Add a category'}</div>
          <button type="button" className="te-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          <label className="te-field">
            <span>Name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!nameError} />
          </label>

          <div className="te-type">
            {['expense', 'income'].map((k) => (
              <button key={k} type="button" className="om-seg" data-active={kind === k} onClick={() => setKind(k)}>
                {k === 'expense' ? 'Expense' : 'Income'}
              </button>
            ))}
          </div>

          {category?.archived && (
            <div className="ov-muted" style={{ fontSize: 11.5 }}>
              This category is archived — it still labels past transactions, but won't appear when assigning a new one.
            </div>
          )}

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
              {error}
            </p>
          )}

          <div className="te-actions">
            {category && (
              <button type="button" className="om-btn" onClick={toggleArchived} disabled={saving}>
                {category.archived ? 'Unarchive' : 'Archive'}
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
