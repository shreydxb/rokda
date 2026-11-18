import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCloseGuard } from '../../lib/useCloseGuard';
import { supabase } from '../../lib/supabaseClient';
import { Chip, Drawer, Segmented } from '../../design-system/kit';
import DiscardPrompt from '../DiscardPrompt';
import '../money/TransactionEditor.css';
import './SettingsTabs.css';

// A member, in the kit's drawer (the revamp, phase 7; design/prototype
// set-member). What a member may change here follows the database's
// owner/member boundary (owner_role_authorization): an owner manages the
// roster; a member who is not an owner renames themselves and links their
// own Telegram, and sees everyone else read-only. Offering the rest only for
// the database to refuse it showed a raw policy error instead of saying who
// can do it (SHR-314).
export default function MemberEditor({ member, householdId, isSelf, isLastOwner, canManage = true, onClose, onSaved }) {
  const uid = useId();
  const navigate = useNavigate();
  // A member who is not an owner can still edit their own row: the name.
  const canEdit = canManage || isSelf;
  const [displayName, setDisplayName] = useState(member?.display_name ?? '');
  const [role, setRole] = useState(member?.role ?? 'member');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const dirty = displayName !== (member?.display_name ?? '') || role !== (member?.role ?? 'member');
  // Where Link goes once the drawer has closed: unsaved changes are asked
  // about first, as closing asks.
  const [leavingFor, setLeavingFor] = useState(null);
  const leave = () => {
    if (leavingFor) navigate(leavingFor);
    onClose();
  };
  // Escape steps back out of a removal waiting to be confirmed before it
  // closes anything.
  const { confirmingClose, requestClose, keepEditing, escapeKey } = useCloseGuard({
    dirty,
    onClose: leave,
    listen: false,
    onEscape: () => {
      if (confirmingDelete) setConfirmingDelete(false);
      else requestClose();
    },
  });

  // Owner is an administrative grant, resolved through the member's linked
  // login (is_household_owner). A row with no login cannot be that person, so
  // the database refuses it and the choice isn't offered (QA #3). What a
  // member with no login can own (accounts, transactions, goals) is a
  // different column entirely.
  const canBeOwner = !!member?.user_id;
  const roleNote = !canManage
    ? isSelf
      ? 'Only an owner can change roles.'
      : 'Only an owner can change another member.'
    : isLastOwner
      ? 'The only owner. Add another first.'
      : !canBeOwner
        ? 'An owner needs a login.'
        : null;

  // Linking happens on the Telegram tab, which holds the link drawer.
  const linkPath = member ? `/settings?tab=telegram&link=${member.id}` : null;
  function openLink() {
    if (dirty) {
      setLeavingFor(linkPath);
      requestClose();
      return;
    }
    navigate(linkPath);
    onClose();
  }

  async function handleSave(e) {
    e.preventDefault();
    if (!displayName.trim()) {
      setError('Name it.');
      return;
    }
    setSaving(true);
    setError('');
    const payload = { display_name: displayName.trim(), role };
    const { error: saveError } = member
      ? await supabase.from('household_members').update(payload).eq('id', member.id)
      : await supabase.from('household_members').insert({ ...payload, household_id: householdId, user_id: null });
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

  const formId = `${uid}-form`;
  const footer = (
    <div className="st-dfoot">
      {error && (
        <p className="ds-warn-ink st-derror" role="alert">
          {error}
        </p>
      )}
      <div className="te-actions st-dfoot-row">
        {canManage && member && !isSelf && !isLastOwner && (
          <button type="button" className="om-btn te-delete" onClick={handleDelete} disabled={saving}>
            {confirmingDelete ? 'Confirm remove?' : 'Remove'}
          </button>
        )}
        <div className="te-actions-right">
          {confirmingClose ? (
            <DiscardPrompt
              onDiscard={leave}
              onKeepEditing={() => {
                setLeavingFor(null);
                keepEditing();
              }}
            />
          ) : (
            <>
              <button type="button" className="om-btn" onClick={requestClose}>
                {canEdit ? 'Cancel' : 'Close'}
              </button>
              {canEdit && (
                <button type="submit" form={formId} className="om-btn ov-btn-primary" disabled={saving}>
                  {saving ? 'Saving…' : member ? 'Save' : 'Add member'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <Drawer kicker={member ? 'Member' : 'New member'} title={member ? member.display_name : 'Add a member'} dirty={dirty} onClose={requestClose} onEscape={escapeKey} footer={footer}>
      <form id={formId} className="te-form" onSubmit={handleSave} noValidate>
        <div className="st-field">
          <label className="st-label" htmlFor={`${uid}-name`}>
            Name
          </label>
          <input id={`${uid}-name`} className="ds-select st-input" type="text" readOnly={!canEdit} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Their name" />
        </div>
        <div className="st-field">
          <span className="st-label">Role</span>
          <Segmented
            label="Role"
            options={[
              { id: 'owner', label: 'Owner', disabled: !canManage || isLastOwner || !canBeOwner },
              { id: 'member', label: 'Member', disabled: !canManage || isLastOwner },
            ]}
            value={role}
            onChange={setRole}
          />
          {roleNote && <p className="ds-muted st-hint">{roleNote}</p>}
        </div>
        {member && (
          <ul className="st-kv" aria-label="Accounts">
            <li>
              <span className="st-kv-k">Login</span>
              <span className="st-kv-v">{member.user_id ? <Chip tone="pos">Linked</Chip> : <Chip>No login yet</Chip>}</span>
            </li>
            <li>
              <span className="st-kv-k">Telegram</span>
              <span className="st-kv-v">
                {member.telegram_user_id ? <Chip tone="pos">Linked</Chip> : <Chip tone="warn">Not linked</Chip>}
                {canEdit && (
                  <button type="button" className="ds-btn ds-btn-sm" onClick={openLink}>
                    {member.telegram_user_id ? 'Link again' : 'Link'}
                  </button>
                )}
              </span>
            </li>
          </ul>
        )}
      </form>
    </Drawer>
  );
}
