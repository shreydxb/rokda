import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import MemberEditor from './MemberEditor';
import Explain from '../Explain';
import { buildLabel, buildTitle } from '../../lib/buildInfo';

export default function Household({ household, members, me, loading, reload }) {
  const [name, setName] = useState(household?.name ?? '');
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState('');
  const [editing, setEditing] = useState(null);
  const [inrRate, setInrRate] = useState(household?.inr_per_aed != null ? String(household.inr_per_aed) : '');
  const [savingRate, setSavingRate] = useState(false);
  const [rateError, setRateError] = useState('');

  // This component is always mounted (Settings.jsx just toggles `loading`),
  // so the useState initializer above only ever sees household as it was on
  // the very first render — often still null, before the fetch resolves.
  // Re-sync whenever the real name arrives or changes.
  //
  // A field follows the household only while it still shows the value last
  // synced into it: what a member is typing is theirs until they save it.
  // The household is read again in the background, and the rupee rate moves
  // every day, so syncing unconditionally replaced what was being typed
  // (outside review, E-07).
  const syncedNameRef = useRef(household?.name ?? '');
  const syncedRateRef = useRef(household?.inr_per_aed != null ? String(household.inr_per_aed) : '');
  useEffect(() => {
    const incoming = household?.name ?? '';
    const before = syncedNameRef.current;
    syncedNameRef.current = incoming;
    setName((current) => (current === before ? incoming : current));
  }, [household?.name]);

  useEffect(() => {
    const incoming = household?.inr_per_aed != null ? String(household.inr_per_aed) : '';
    const before = syncedRateRef.current;
    syncedRateRef.current = incoming;
    setInrRate((current) => (current === before ? incoming : current));
  }, [household?.inr_per_aed]);

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  const nameDirty = name.trim() !== '' && name.trim() !== household?.name;
  const rateDirty = inrRate.trim() !== '' && Number(inrRate) !== Number(household?.inr_per_aed);
  // Owners who can actually sign in. The database now guarantees these are the
  // same set -- an owner row must have a user_id -- but the check the "last
  // owner" guard depends on is "can anyone still administer this household",
  // and counting labels is what let a placeholder stand in for an owner in the
  // first place (QA #3). Say what is meant.
  const owners = members.filter((m) => m.role === 'owner' && m.user_id != null);
  // Adding a member is owner-only in the database now, so a non-owner pressing
  // this would get a raw policy error instead of a button that does nothing.
  const iAmOwner = me?.role === 'owner';

  async function saveName(e) {
    e.preventDefault();
    if (!nameDirty) return;
    setSavingName(true);
    setNameError('');
    const sent = name;
    const { error } = await supabase.from('households').update({ name: sent.trim() }).eq('id', household.id);
    setSavingName(false);
    if (error) {
      setNameError(error.message);
      return;
    }
    // The field takes the name as stored, so it goes on following the
    // household after this save (the fresh review of group 4) -- if it still
    // holds what was sent: what was typed while the save was under way is
    // the member's (round 2 of the outside review, E2-6).
    syncedNameRef.current = sent.trim();
    setName((current) => (current === sent ? sent.trim() : current));
    await reload();
  }

  async function saveRate(e) {
    e.preventDefault();
    const rate = Number(inrRate);
    if (!rateDirty || !(rate > 0)) {
      setRateError('Enter a rate greater than zero.');
      return;
    }
    setSavingRate(true);
    setRateError('');
    const sent = inrRate;
    const { error } = await supabase
      .from('households')
      .update({ inr_per_aed: rate, inr_rate_set_at: new Date().toISOString(), inr_rate_source: 'manual' })
      .eq('id', household.id);
    setSavingRate(false);
    if (error) {
      setRateError(error.message);
      return;
    }
    // As stored: "25.80" comes back as 25.8, and a field still reading
    // "25.80" would stop following the household and offer to write this
    // rate back over the next day's (the fresh review of group 4).
    // Likewise only if it still holds what was sent (E2-6).
    syncedRateRef.current = String(rate);
    setInrRate((current) => (current === sent ? String(rate) : current));
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
            aria-label="Household name"
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

      <section style={{ marginTop: 40, maxWidth: 420 }}>
        <div className="ov-kicker" style={{ marginBottom: 12 }}>
          Display currency
        </div>
        <div style={{ marginBottom: 14 }}>
          <Explain label="How the currency works">
            Everything is still stored and charged in AED. The sidebar toggle only changes what portfolio and net-worth
            figures are <em>shown as</em>. USD uses the fixed AED peg (3.6725, unchanged since 1997) — INR floats, so a
            daily feed refreshes it automatically. Entering a rate here overrides that until the next refresh, and
            exists mainly as a fallback for when the feed has never run.
          </Explain>
        </div>
        <form onSubmit={saveRate} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="ov-muted" style={{ fontSize: 13 }}>
            1 AED =
          </span>
          <input
            type="number"
            step="0.01"
            min="0"
            aria-label="Rupees per dirham"
            value={inrRate}
            onChange={(e) => setInrRate(e.target.value)}
            placeholder="e.g. 25.80"
            style={{
              width: 110,
              background: 'none',
              border: '1px solid var(--rule2)',
              borderRadius: 'var(--radius-sm)',
              padding: '9px 10px',
              fontSize: 14,
              color: 'var(--ink)',
              fontFamily: 'inherit',
            }}
          />
          <span className="ov-muted" style={{ fontSize: 13 }}>
            INR
          </span>
          <button type="submit" className="om-btn" disabled={!rateDirty || savingRate}>
            {savingRate ? 'Saving…' : 'Save'}
          </button>
        </form>
        <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 8 }}>
          {household?.inr_rate_set_at
            ? `${household.inr_rate_source === 'auto' ? 'Auto-refreshed' : 'Manually set'} ${new Date(household.inr_rate_set_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}.`
            : 'Not set yet — the INR display option stays disabled until the daily feed runs or a rate is entered here.'}
        </div>
        {rateError && (
          <p className="ov-warn" role="alert" style={{ fontSize: 12.5, marginTop: 8 }}>
            {rateError}
          </p>
        )}
      </section>

      <section style={{ marginTop: 40 }}>
        <div className="ov-section-head">
          <div className="ov-kicker">Members</div>
          {iAmOwner && (
            <button type="button" className="om-btn mn-add" onClick={() => setEditing('new')}>
              + Member
            </button>
          )}
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
                  {m.role === 'owner' ? 'Owner' : 'Member'} · {m.user_id ? 'Linked to a login' : 'Not linked yet — assign-only'} ·{' '}
                  {m.telegram_user_id ? 'Telegram linked' : 'Telegram not linked'}
                </div>
              </div>
            </button>
          ))}
        </div>
        {!iAmOwner && (
          <div className="ov-muted" style={{ marginTop: 14 }}>
            Only an owner can add or remove members.
          </div>
        )}
        <Explain label="About members">
          A member without a linked login can still own accounts, transactions, and goals — useful for adding a partner before
          they have their own account. They cannot be a household owner, though: that role is about administering the roster,
          which needs a login. Sending them an actual invite isn't wired up yet.
        </Explain>
      </section>

      {/* The build this is, for checking a deploy (it used to sit in the
          sidebar of every screen). */}
      <section style={{ marginTop: 40 }}>
        <div className="ov-kicker" style={{ marginBottom: 8 }}>
          About
        </div>
        <div className="ov-muted" title={buildTitle()}>
          {buildLabel()}
        </div>
      </section>

      {editing && (
        <MemberEditor
          member={editing === 'new' ? null : editing}
          householdId={household?.id}
          isSelf={editing !== 'new' && editing.id === me?.id}
          isLastOwner={editing !== 'new' && editing.role === 'owner' && owners.length <= 1}
          canManage={iAmOwner}
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
