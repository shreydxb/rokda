import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import MemberEditor from './MemberEditor';

export default function Household({ household, members, me, loading, reload }) {
  const [name, setName] = useState(household?.name ?? '');
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState('');
  const [editing, setEditing] = useState(null);

  // This component is always mounted (Settings.jsx just toggles `loading`),
  // so the useState initializer above only ever sees household as it was on
  // the very first render — often still null, before the fetch resolves.
  // Re-sync whenever the real name arrives or changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing local edit-buffer state from a prop that loads asynchronously
    setName(household?.name ?? '');
  }, [household?.name]);

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  const nameDirty = name.trim() !== '' && name.trim() !== household?.name;
  const owners = members.filter((m) => m.role === 'owner');

  async function saveName(e) {
    e.preventDefault();
    if (!nameDirty) return;
    setSavingName(true);
    setNameError('');
    const { error } = await supabase.from('households').update({ name: name.trim() }).eq('id', household.id);
    setSavingName(false);
    if (error) {
      setNameError(error.message);
      return;
    }
    await reload();
  }

  return (
    <div>
      <section style={{ marginTop: 26, maxWidth: 420 }}>
        <div className="ov-kicker" style={{ marginBottom: 12 }}>
          Household name
        </div>
        <form onSubmit={saveName} style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{
              flex: 1,
              background: 'none',
              border: '1px solid var(--rule2)',
              borderRadius: 'var(--radius-sm)',
              padding: '9px 10px',
              fontSize: 14,
              color: 'var(--ink)',
              fontFamily: 'inherit',
            }}
          />
          <button type="submit" className="om-btn" disabled={!nameDirty || savingName}>
            {savingName ? 'Saving…' : 'Save'}
          </button>
        </form>
        {nameError && (
          <p className="ov-warn" role="alert" style={{ fontSize: 12.5, marginTop: 8 }}>
            {nameError}
          </p>
        )}
      </section>

      <section style={{ marginTop: 40 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
          <div className="ov-kicker">Members</div>
          <button type="button" className="om-btn mn-add" onClick={() => setEditing('new')}>
            + Member
          </button>
        </div>
        <div className="mn-list">
          {members.map((m) => (
            <button key={m.id} type="button" className="mn-row" onClick={() => setEditing(m)}>
              <div className="mn-row-main">
                <div>
                  {m.display_name}
                  {m.id === me?.id ? ' (you)' : ''}
                </div>
                <div className="ov-muted" style={{ marginTop: 3 }}>
                  {m.role === 'owner' ? 'Owner' : 'Member'} · {m.user_id ? 'Linked to a login' : 'Not linked yet — assign-only'}
                </div>
              </div>
            </button>
          ))}
        </div>
        <div className="ov-muted" style={{ marginTop: 14, fontSize: 11.5, lineHeight: 1.65, maxWidth: '80ch' }}>
          A member without a linked login can still own accounts, transactions, and goals — useful for adding a partner before
          they have their own account. Sending them an actual invite isn't wired up yet.
        </div>
      </section>

      {editing && (
        <MemberEditor
          member={editing === 'new' ? null : editing}
          householdId={household?.id}
          isSelf={editing !== 'new' && editing.id === me?.id}
          isLastOwner={editing !== 'new' && editing.role === 'owner' && owners.length <= 1}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}
