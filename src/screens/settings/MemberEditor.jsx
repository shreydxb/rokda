import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import '../money/TransactionEditor.css';

export default function MemberEditor({ member, householdId, isSelf, isLastOwner, onClose, onSaved }) {
  const [displayName, setDisplayName] = useState(member?.display_name ?? '');
  const [role, setRole] = useState(member?.role ?? 'member');
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

  const nameError = displayName.trim() === '' ? 'Name it.' : '';

  async function handleSave(e) {
    e.preventDefault();
    if (nameError) {
      setError(nameError);
      return;
    }
    setSaving(true);
    setError('');

    const payload = { display_name: displayName.trim(), role };
    const query = member
      ? supabase.from('household_members').update(payload).eq('id', member.id)
      : supabase.from('household_members').insert({ ...payload, household_id: householdId, user_id: null });

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
    const { error: delError } = await supabase.from('household_members').delete().eq('id', member.id);
    setSaving(false);
    if (delError) {
      setError(delError.message);
      return;
    }
    await onSaved();
  }

  return (
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label={member ? 'Edit member' : 'Add member'}>
        <div className="te-head">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="ov-kicker">{member ? 'Member' : 'New member'}</span>
              {dirty && <span className="te-dirty-chip">Unsaved</span>}
            </div>
            <div className="te-title">{member ? member.display_name : 'Add a member'}</div>
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
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                setDirty(true);
              }}
              aria-invalid={!!nameError}
              placeholder="Their name"
            />
          </div>

          <div>
            <span className="te-fieldlabel">Role</span>
            <div className="te-chips">
              {['owner', 'member'].map((r) => (
                <button
                  key={r}
                  type="button"
                  className="om-seg"
                  data-active={role === r}
                  disabled={isLastOwner}
                  onClick={() => {
                    setRole(r);
                    setDirty(true);
                  }}
                >
                  {r === 'owner' ? 'Owner' : 'Member'}
                </button>
              ))}
            </div>
          </div>
          {isLastOwner && (
            <div className="ov-muted" style={{ fontSize: 11.5, marginTop: -10 }}>
              This is the only owner — add another owner before changing this one to a member.
            </div>
          )}

          {member && !member.user_id && (
            <div className="ov-muted" style={{ fontSize: 11.5 }}>
              Not linked to a login yet. They can still be assigned as an owner of accounts, transactions, and goals.
            </div>
          )}

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
              {error}
            </p>
          )}

          <div className="te-sticky-actions">
            <div className="te-actions" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
              {member && !isSelf && !isLastOwner && (
                <button type="button" className="om-btn te-delete" onClick={handleDelete} disabled={saving}>
                  {confirmingDelete ? 'Confirm remove?' : 'Remove'}
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
                      {saving ? 'Saving…' : member ? 'Save changes' : 'Add member'}
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
