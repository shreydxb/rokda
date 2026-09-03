import { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import '../money/TransactionEditor.css';

export default function MemberEditor({ member, householdId, isSelf, isLastOwner, onClose, onSaved }) {
  const [displayName, setDisplayName] = useState(member?.display_name ?? '');
  const [role, setRole] = useState(member?.role ?? 'member');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

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
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label={member ? 'Edit member' : 'Add member'}>
        <div className="te-head">
          <div className="ov-kicker">{member ? 'Edit member' : 'Add a member'}</div>
          <button type="button" className="te-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          <label className="te-field">
            <span>Name</span>
            <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} aria-invalid={!!nameError} />
          </label>

          <label className="te-field">
            <span>Role</span>
            <select value={role} onChange={(e) => setRole(e.target.value)} disabled={isLastOwner}>
              <option value="owner">Owner</option>
              <option value="member">Member</option>
            </select>
          </label>
          {isLastOwner && (
            <div className="ov-muted" style={{ fontSize: 11.5, marginTop: -8 }}>
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

          <div className="te-actions">
            {member && !isSelf && !isLastOwner && (
              <button type="button" className="om-btn te-delete" onClick={handleDelete} disabled={saving}>
                {confirmingDelete ? 'Confirm remove?' : 'Remove'}
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
