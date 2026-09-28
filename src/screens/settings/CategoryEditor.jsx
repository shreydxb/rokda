import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import '../money/TransactionEditor.css';

export default function CategoryEditor({ category, householdId, members = [], onClose, onSaved }) {
  const [name, setName] = useState(category?.name ?? '');
  const [kind, setKind] = useState(category?.kind ?? 'expense');
  const [isSavings, setIsSavings] = useState(!!category?.is_savings);
  const [owner, setOwner] = useState(category?.owner_member_id ?? '');
  const [dirty, setDirty] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
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

  const nameError = name.trim() === '' ? 'Name it.' : '';

  async function handleSave(e) {
    e.preventDefault();
    if (nameError) {
      setError(nameError);
      return;
    }
    setSaving(true);
    setError('');

    // Only an expense category can be savings (the database refuses the
    // rest); switching to income clears it rather than failing the save.
    // An owner only means something for costs; income stays shared.
    const payload = { name: name.trim(), kind, is_savings: kind === 'expense' && isSavings, owner_member_id: kind === 'expense' && owner ? owner : null };
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
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label={category ? 'Edit category' : 'Add category'}>
        <div className="te-head">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="ov-kicker">{category ? 'Edit category' : 'New category'}</span>
              {dirty && <span className="te-dirty-chip">Unsaved</span>}
            </div>
            <div className="te-title">{category ? category.name : 'Add a category'}</div>
          </div>
          <button type="button" className="te-close" onClick={requestClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          <div className="te-fieldcell">
            <span className="te-fieldlabel">Name</span>
            <input
              className="te-fieldvalue"
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setDirty(true);
              }}
              aria-invalid={!!nameError}
              placeholder="e.g. Pets"
            />
          </div>

          <div>
            <span className="te-fieldlabel">Kind</span>
            <div className="te-chips">
              {['expense', 'income'].map((k) => (
                <button
                  key={k}
                  type="button"
                  className="om-seg"
                  data-active={kind === k}
                  onClick={() => {
                    setKind(k);
                    setDirty(true);
                  }}
                >
                  {k === 'expense' ? 'Expense' : 'Income'}
                </button>
              ))}
            </div>
          </div>

          {kind === 'expense' && (
            <button
              type="button"
              className="te-togglerow"
              onClick={() => {
                setIsSavings((v) => !v);
                setDirty(true);
              }}
            >
              <div>
                <div className="te-togglelabel">Savings, not spending</div>
                <div className="te-togglenote">
                  For money set aside. Its budget becomes a savings target, measured against what each month saves, and it is kept out of
                  spending totals and out of the lists spending is filed under.
                </div>
              </div>
              <span className="te-togglestate">{isSavings ? 'Savings' : 'Spending'}</span>
            </button>
          )}

          {kind === 'expense' && members.length > 1 && (
            <div>
              <span className="te-fieldlabel">Whose cost</span>
              <div className="te-chips">
                {[{ id: '', display_name: 'Shared' }, ...members].map((m) => (
                  <button
                    key={m.id || 'shared'}
                    type="button"
                    className="om-seg"
                    data-active={owner === m.id}
                    onClick={() => {
                      setOwner(m.id);
                      setDirty(true);
                    }}
                  >
                    {m.display_name}
                  </button>
                ))}
              </div>
              <div className="te-togglenote" style={{ marginTop: 6 }}>
                Shared costs are split between you by income; one person’s own costs are theirs alone. A subcategory left shared follows
                its group when the group is someone’s.
              </div>
            </div>
          )}

          {category && (
            <button type="button" className="te-togglerow" onClick={toggleArchived} disabled={saving}>
              <div>
                <div className="te-togglelabel">Archived</div>
                <div className="te-togglenote">Still labels past transactions, but won't appear when assigning a new one</div>
              </div>
              <span className={`te-togglestate ${category.archived ? 'te-togglestate-warn' : ''}`}>{category.archived ? 'Archived' : 'Active'}</span>
            </button>
          )}

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
              {error}
            </p>
          )}

          <div className="te-sticky-actions">
            <div className="te-actions" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
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
                      {saving ? 'Saving…' : category ? 'Save changes' : 'Add category'}
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
