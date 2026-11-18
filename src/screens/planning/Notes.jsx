import { Fragment, useEffect, useId, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabaseClient';
import { parseNote } from '../../lib/notes';
import { householdToday } from '../../lib/day';
import { dayText, orderNotes, yearlyCheckStatus, yearlyCheckText } from '../../lib/yearlyChecks';
import { useCloseGuard } from '../../lib/useCloseGuard';
import { neverLoaded } from '../../lib/loadState';
import { Card, Chip, Drawer, EmptyState, Switch, WarningRow } from '../../design-system/kit';
import DiscardPrompt from '../DiscardPrompt';
import { Tools } from '../PageTools';
import { NOTES_INPUTS } from './planningSources';
import Withheld from './Withheld';
import './Notes.css';

// Planning -> Notes (the revamp, phase 6c; design/prototype notesScreen): the
// plan in words, private to the household. The list beside the chosen note,
// due checks first; a note is written in a drawer. The chosen note is in the
// address (`?note={id}`), so Overview's yearly reminder opens the note it
// means. The figures live on the other tabs; these notes keep the reasoning
// next to them.

const updatedOn = (at) => dayText(new Date(at));

export default function Notes({ household, me, members = [], data, sources, onRetry, loading }) {
  const notes = data?.notes ?? [];
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState(null); // null | 'new' | note id
  // The note as it was opened. Deleted elsewhere while open, it drops out of
  // a refresh, and with it would go the drawer and its draft (outside
  // review, E-06): it stays open on this, with the draft, until Cancel.
  const [editingNote, setEditingNote] = useState(null);
  // Until the read after a save lands, a note on screen is the version from
  // before it: opened again then, it would show the old text.
  const [reloading, setReloading] = useState(false);

  if (loading) return <div className="ov-skel" aria-busy="true" />;
  const missing = neverLoaded(sources, NOTES_INPUTS);
  if (missing.length > 0) {
    return (
      <Withheld missing={missing} onRetry={onRetry}>
        Your notes aren&rsquo;t shown, rather than shown as none.
      </Withheld>
    );
  }

  const ordered = orderNotes(notes);
  const chosen = ordered.find((n) => n.id === params.get('note')) ?? ordered[0] ?? null;
  // Picking a note from the list replaces the address: Back leaves the tab,
  // not each note looked at.
  const choose = (id) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set('note', id);
        return p;
      },
      { replace: true },
    );
  const busy = editing !== null || reloading;
  const nameOf = (id) => members.find((m) => m.id === id)?.display_name;
  const nextPosition = notes.reduce((max, n) => Math.max(max, n.position ?? 0), 0) + 1;
  const done = async () => {
    setEditing(null);
    setReloading(true);
    try {
      await data.reload();
    } finally {
      setReloading(false);
    }
  };
  const startEditing = (note) => {
    setEditing(note.id);
    setEditingNote(note);
  };
  const gone = editing !== null && editing !== 'new' && !notes.some((n) => n.id === editing);
  const open = editing === 'new' ? null : (notes.find((n) => n.id === editing) ?? editingNote);

  return (
    <div className="nt">
      <Tools>
        <Chip>Private to your household</Chip>
        <button type="button" className={`ds-btn${notes.length ? ' ds-btn-primary' : ''}`} onClick={() => setEditing('new')} disabled={busy}>
          + Note
        </button>
      </Tools>

      {ordered.length === 0 ? (
        <section className="ds-card nt-empty">
          <EmptyState title="No notes yet" body="Reasons behind the plan, and things to check once a year." action={{ label: '+ Note', onClick: () => setEditing('new') }} />
        </section>
      ) : (
        <div className="nt-grid">
          <Card title="Notes" right={<span>{ordered.length}</span>} flush>
            <div className="nt-list">
              {ordered.map((n) => {
                const status = yearlyCheckStatus(n);
                return (
                  <button
                    key={n.id}
                    type="button"
                    className="nt-row"
                    aria-current={chosen?.id === n.id ? 'true' : undefined}
                    data-on={chosen?.id === n.id || undefined}
                    onClick={() => choose(n.id)}
                  >
                    <span className="nt-row-main">
                      <span className="nt-row-title">{n.title}</span>
                      <span className="nt-row-sub">{`Updated ${updatedOn(n.updated_at)}`}</span>
                    </span>
                    {status?.due ? <Chip tone="warn">Due</Chip> : status ? <Chip>Yearly</Chip> : null}
                  </button>
                );
              })}
            </div>
          </Card>
          {chosen && (
            <section className="ds-card nt-note" aria-label={chosen.title}>
              <div className="nt-note-head">
                <h2 className="nt-note-title">{chosen.title}</h2>
                <button type="button" className="ds-btn ds-btn-sm" onClick={() => startEditing(chosen)} disabled={busy}>
                  Edit
                </button>
              </div>
              <div className="nt-note-body">
                {chosen.check_yearly && <YearlyCheck note={chosen} me={me} disabled={busy} onChecked={done} />}
                <NoteBody body={chosen.body} />
                <div className="ds-muted nt-meta">
                  {`Updated ${updatedOn(chosen.updated_at)}`}
                  {nameOf(chosen.updated_by) && ` by ${nameOf(chosen.updated_by)}`}
                </div>
              </div>
            </section>
          )}
        </div>
      )}

      {editing !== null && (
        <NoteDrawer
          key={editing}
          note={open}
          gone={gone}
          householdId={household?.id}
          me={me}
          position={nextPosition}
          onCancel={() => setEditing(null)}
          onSaved={done}
        />
      )}
    </div>
  );
}

function Spans({ spans }) {
  return spans.map((s, i) => (s.bold ? <strong key={i}>{s.text}</strong> : <Fragment key={i}>{s.text}</Fragment>));
}

function NoteBody({ body }) {
  const blocks = parseNote(body);
  if (blocks.length === 0) return <p className="ds-muted">Empty.</p>;
  return (
    <div className="nt-body">
      {blocks.map((b, i) => {
        if (b.type === 'h') {
          const Tag = b.level === 1 ? 'h3' : 'h4';
          return (
            <Tag key={i}>
              <Spans spans={b.spans} />
            </Tag>
          );
        }
        if (b.type === 'ul') {
          return (
            <ul key={i}>
              {b.items.map((item, j) => (
                <li key={j}>
                  <Spans spans={item} />
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i}>
            <Spans spans={b.spans} />
          </p>
        );
      })}
    </div>
  );
}

// A note checked once a year (Planning audit, 4.18): where it stands, and
// while it is due, Checked today, which Overview's reminder waits on. The
// next one is a year from whenever it was done.
function YearlyCheck({ note, me, disabled, onChecked }) {
  const status = yearlyCheckStatus(note);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function check() {
    setSaving(true);
    setError('');
    const { error: saveError } = await supabase.from('household_notes').update({ checked_on: householdToday(), updated_by: me?.id ?? null }).eq('id', note.id);
    setSaving(false);
    if (saveError) {
      setError(saveError.message);
      return;
    }
    await onChecked();
  }

  return (
    <div className="nt-check" data-due={String(status.due)}>
      <span className="ds-dot" aria-hidden="true" />
      <span className="nt-check-text">{yearlyCheckText(status)}</span>
      {status.due && (
        <button type="button" className="ds-btn ds-btn-sm" onClick={check} disabled={disabled || saving}>
          {saving ? 'Saving…' : 'Checked today'}
        </button>
      )}
      {error && (
        <p className="ds-warn-ink nt-check-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// The note's drawer (design/prototype openNote): the title, the note and a
// "Check once a year" switch. A note can run to pages: changed and unsaved,
// closing asks first, and so does leaving the page.
function NoteDrawer({ note, gone = false, householdId, me, position = 0, onCancel, onSaved }) {
  const uid = useId();
  const formId = `${uid}-form`;
  const [title, setTitle] = useState(note?.title ?? '');
  const [body, setBody] = useState(note?.body ?? '');
  const [yearly, setYearly] = useState(note?.check_yearly ?? false);
  // The version this edit started from. The note itself is read again every
  // few minutes while the drawer is open, so the check below must not use the
  // latest one: that would let this save replace a change made meanwhile.
  const [openedAt] = useState(note?.updated_at ?? null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dirty = title !== (note?.title ?? '') || body !== (note?.body ?? '') || yearly !== (note?.check_yearly ?? false);
  // Escape steps back out of a pending delete before it closes anything.
  const { confirmingClose, requestClose, keepEditing, escapeKey } = useCloseGuard({
    dirty,
    onClose: onCancel,
    listen: false,
    onEscape: () => {
      if (confirmingDelete) setConfirmingDelete(false);
      else requestClose();
    },
  });

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function save(e) {
    e.preventDefault();
    if (saving) return;
    if (!title.trim()) {
      setError('Give it a title.');
      return;
    }
    setSaving(true);
    setError('');
    const payload = { title: title.trim(), body, check_yearly: yearly, updated_by: me?.id ?? null };
    // An edit saves only over the version it was opened from. Both partners
    // can edit the same note, and the second save used to replace the first
    // without a word.
    const { data: saved, error: saveError } = note
      ? await supabase.from('household_notes').update(payload).eq('id', note.id).eq('updated_at', openedAt).select('id')
      : await supabase.from('household_notes').insert({ ...payload, household_id: householdId, position });
    setSaving(false);
    if (saveError) {
      setError(saveError.message);
      return;
    }
    if (note && (saved ?? []).length === 0) {
      setError('This note was changed after you opened it, here or elsewhere, so yours was not saved over it. Copy what you wrote, then Cancel and open the note again.');
      return;
    }
    await onSaved();
  }

  async function remove() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setSaving(true);
    const { error: delError } = await supabase.from('household_notes').delete().eq('id', note.id);
    setSaving(false);
    if (delError) {
      setError(delError.message);
      return;
    }
    await onSaved();
  }

  const footer = (
    <div className="nt-foot">
      {error && (
        <p className="ds-warn-ink nt-error" role="alert">
          {error}
        </p>
      )}
      <div className="nt-foot-row">
        {note && !gone && (
          <button type="button" className={`ds-btn${confirmingDelete ? ' nt-danger' : ''}`} onClick={remove} disabled={saving}>
            {confirmingDelete ? 'Confirm delete?' : 'Delete'}
          </button>
        )}
        <span className="nt-grow" />
        {confirmingClose ? (
          <DiscardPrompt onDiscard={onCancel} onKeepEditing={keepEditing} />
        ) : (
          <>
            <button type="button" className="ds-btn" onClick={requestClose}>
              Cancel
            </button>
            {!gone && (
              <button type="submit" form={formId} className="ds-btn ds-btn-primary" disabled={saving}>
                {saving ? 'Saving…' : note ? 'Save' : 'Add note'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );

  return (
    <Drawer kicker={note ? 'Edit note' : 'New note'} title={note ? note.title : 'Add a note'} dirty={dirty} wide onClose={requestClose} onEscape={escapeKey} footer={footer}>
      <form id={formId} className="nt-form" onSubmit={save} noValidate>
        {gone && <WarningRow tone="neg">This note was deleted elsewhere. Copy what you need from your draft, then Cancel.</WarningRow>}
        <label className="nt-field">
          <span className="nt-label">Title</span>
          <input aria-label="Title" className="ds-select nt-input" type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Who pays what" />
        </label>
        <label className="nt-field">
          <span className="nt-label">Note</span>
          <textarea aria-label="Note" className="ds-select nt-textarea" value={body} onChange={(e) => setBody(e.target.value)} rows={12} placeholder="Why the plan is what it is" />
          <span className="ds-muted nt-hint">“# ” starts a heading, “- ” a bullet, **bold** is bold, and a blank line starts a new paragraph.</span>
        </label>
        <div className="nt-switch">
          <div>
            <div className="nt-label-strong">Check once a year</div>
            <div className="ds-muted nt-hint">
              For insurance, wills and nominations. Overview asks for it a year after it was last checked, and at once until it first is.
            </div>
          </div>
          <Switch label="Check once a year" checked={yearly} onChange={setYearly} />
        </div>
      </form>
    </Drawer>
  );
}
