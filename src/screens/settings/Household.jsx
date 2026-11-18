import { useEffect, useId, useRef, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { householdToday } from '../../lib/day';
import { shortDate } from '../../lib/dividends';
import { buildLabel, buildTitle } from '../../lib/buildInfo';
import { Avatar, Card, Chip, InfoButton } from '../../design-system/kit';
import { Tools } from '../PageTools';
import MemberEditor from './MemberEditor';
import './SettingsTabs.css';

// Settings -> Household, like the prototype (the revamp, phase 7): the
// household's name and rupee rate in a card, each saved when it is left, and
// the members as a table. The review's S-household items are what it answers.

// A field saved when it is left, or on Enter, with "Saved" once it is.
//
// The household is read again in the background, and the rupee rate moves
// every day. A field follows the household only while it still shows the
// value last synced into it: what a member is typing is theirs until it is
// saved (outside review, E-07). A save that takes a while sets the field to
// what was stored only if it still holds what was sent: what was typed
// meanwhile is the member's (round 2 of the outside review, E2-6).
function useSavedField(stored, save) {
  const [value, setValue] = useState(stored);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const synced = useRef(stored);
  const sending = useRef(null);
  useEffect(() => {
    const before = synced.current;
    synced.current = stored;
    setValue((current) => (current === before ? stored : current));
  }, [stored]);

  const putBack = (sent, message = '') => {
    setError(message);
    setValue((current) => (current === sent ? synced.current : current));
  };
  async function commit() {
    const sent = value;
    if (sending.current === sent) return;
    const outcome = save.check(sent, synced.current);
    if (outcome.skip) return;
    if (outcome.putBack) {
      putBack(sent, outcome.error ?? '');
      return;
    }
    sending.current = sent;
    setError('');
    const { error: saveError, stored: asStored } = await save.send(outcome.value);
    sending.current = null;
    if (saveError) {
      putBack(sent, saveError.message);
      return;
    }
    // The field takes the value as stored ("25.80" comes back 25.8), so it
    // goes on following the household after this save (the fresh review of
    // group 4).
    synced.current = asStored;
    setValue((current) => (current === sent ? asStored : current));
    setSaved(true);
  }
  return {
    error,
    saved,
    input: {
      value,
      'aria-invalid': error ? true : undefined,
      onChange: (e) => {
        setValue(e.target.value);
        setSaved(false);
      },
      onBlur: commit,
      onKeyDown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      },
    },
  };
}

function SavedNote({ field, id }) {
  if (field.error) {
    return (
      <p className="ds-warn-ink st-note" role="alert" id={id}>
        {field.error}
      </p>
    );
  }
  return field.saved ? (
    <p className="ds-muted st-note" id={id}>
      Saved
    </p>
  ) : null;
}

const rateText = (n) => (n != null ? String(n) : '');

export default function Household({ household, members = [], me, loading, reload }) {
  const uid = useId();
  const [editing, setEditing] = useState(null);

  const name = useSavedField(household?.name ?? '', {
    check: (typed, current) => {
      const trimmed = typed.trim();
      if (trimmed === current) return { skip: typed === current, putBack: true };
      if (!trimmed) return { putBack: true };
      return { value: trimmed };
    },
    send: async (trimmed) => {
      const { error } = await supabase.from('households').update({ name: trimmed }).eq('id', household.id);
      if (!error) await reload();
      return { error, stored: trimmed };
    },
  });
  const rate = useSavedField(rateText(household?.inr_per_aed), {
    check: (typed, current) => {
      if (typed.trim() === '' || Number(typed) === Number(current)) return { skip: typed === current, putBack: true };
      const n = Number(typed);
      if (!(n > 0)) return { putBack: true, error: 'Enter a rate greater than zero.' };
      return { value: n };
    },
    send: async (n) => {
      const { error } = await supabase
        .from('households')
        .update({ inr_per_aed: n, inr_rate_set_at: new Date().toISOString(), inr_rate_source: 'manual' })
        .eq('id', household.id);
      if (!error) await reload();
      return { error, stored: String(n) };
    },
  });

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  // Owners who can actually sign in. The database guarantees an owner row has
  // a login, but the last-owner guard is about who can still administer the
  // household, so it says what is meant (QA #3).
  const owners = members.filter((m) => m.role === 'owner' && m.user_id != null);
  // Adding a member is owner-only in the database.
  const iAmOwner = me?.role === 'owner';
  const setAt = household?.inr_rate_set_at ? shortDate(householdToday(new Date(household.inr_rate_set_at))) : null;

  return (
    <div className="st-grid st-grid-5-7">
      <Tools>
        {iAmOwner && (
          <button type="button" className="ds-btn ds-btn-primary" onClick={() => setEditing('new')}>
            + Member
          </button>
        )}
      </Tools>

      <div className="st-stack">
        <Card title="Household">
          <div className="st-fields">
            <div className="st-field">
              <label className="st-label" htmlFor={`${uid}-name`}>
                Name
              </label>
              <input id={`${uid}-name`} className="ds-select st-input" type="text" {...name.input} aria-describedby={`${uid}-name-note`} />
              <SavedNote field={name} id={`${uid}-name-note`} />
            </div>
            <div className="st-field">
              <div className="st-label">
                <label htmlFor={`${uid}-rate`}>Rupee rate</label>
                <InfoButton about="Rupee rate">
                  Everything is stored in AED. The display currency in the account menu only changes how totals are shown: USD at the fixed peg of 3.6725, INR at this rate, which the nightly refresh also updates.
                </InfoButton>
              </div>
              <div className="st-rate">
                <span className="ds-muted">1 AED =</span>
                <input id={`${uid}-rate`} className="ds-select st-input st-rate-input" type="number" step="0.01" min="0" placeholder="e.g. 25.80" {...rate.input} aria-describedby={`${uid}-rate-note`} />
                <span className="ds-muted">INR</span>
                <span className="st-grow" />
                <Chip>{setAt ? `Updated ${setAt}` : 'Not set'}</Chip>
              </div>
              <SavedNote field={rate} id={`${uid}-rate-note`} />
            </div>
          </div>
        </Card>
        {/* The build this is, for checking a deploy, where the prototype
            gives its own. */}
        <div className="ds-muted st-build" title={buildTitle()}>
          {buildLabel()}
        </div>
      </div>

      <Card
        title="Members"
        info={<InfoButton about="Members">An owner manages the list. A member with no login can still own accounts, transactions and goals.</InfoButton>}
        right={<span>{`${members.length} ${members.length === 1 ? 'person' : 'people'}`}</span>}
        flush
      >
        <div className="ds-table-wrap">
          <table className="ds-table st-members">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Role</th>
                <th scope="col">Login</th>
                <th scope="col">Telegram</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m, at) => (
                <tr key={m.id} data-open="" onClick={(e) => !e.target.closest('button') && setEditing(m)}>
                  <td>
                    <span className="st-who">
                      <Avatar name={m.display_name} initial={m.display_name.slice(0, 1).toUpperCase()} tone={at === 0 ? 'a' : 'b'} />
                      <button type="button" className="st-name" onClick={() => setEditing(m)}>
                        {m.display_name}
                      </button>
                      {m.id === me?.id && <span className="ds-muted st-you">you</span>}
                    </span>
                  </td>
                  <td>{m.role === 'owner' ? 'Owner' : 'Member'}</td>
                  <td>{m.user_id ? <Chip tone="pos">Linked</Chip> : <Chip>No login</Chip>}</td>
                  <td>{m.telegram_user_id ? <Chip tone="pos">Linked</Chip> : <Chip tone="warn">Not linked</Chip>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!iAmOwner && <p className="ds-muted st-foot">Only an owner can add or remove members.</p>}
      </Card>

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
