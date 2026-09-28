import { Fragment, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { parseNote } from '../../lib/notes';

// The plan in words: why the goals, budget and split are what they are, and
// what is still to decide. The figures live on the other tabs; these notes
// keep the reasoning next to them, behind the household's login.
export default function Notes({ household, me, members = [], data, loading }) {
  const notes = data?.notes ?? [];
  const [editing, setEditing] = useState(null); // null | 'new' | note id

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  const nameOf = (id) => members.find((m) => m.id === id)?.display_name;
  const nextPosition = notes.reduce((max, n) => Math.max(max, n.position ?? 0), 0) + 1;
  const done = async () => {
    setEditing(null);
    await data.reload();
  };

  return (
    <div>
      <div className="mn-filters">
        <div className="ov-muted" style={{ fontSize: 12.5 }}>
          The reasons behind the plan, and what is still open. Only your household can see these.
        </div>
        <button type="button" className="om-btn mn-add" onClick={() => setEditing('new')} disabled={editing !== null}>
          + Add note
        </button>
      </div>

      {editing === 'new' && (
        <NoteEditor householdId={household?.id} me={me} position={nextPosition} onCancel={() => setEditing(null)} onSaved={done} />
      )}

      {notes.length === 0 && editing !== 'new' ? (
        <div className="ov-empty">
          <div className="ov-empty-kicker">No notes</div>
          <div className="ov-empty-body">Write down why the plan is what it is: who pays what, which goal comes first, what is still to decide.</div>
        </div>
      ) : (
        notes.map((note) =>
          editing === note.id ? (
            <NoteEditor key={note.id} note={note} householdId={household?.id} me={me} onCancel={() => setEditing(null)} onSaved={done} />
          ) : (
            <article key={note.id} className="nt-card" aria-label={note.title}>
              <div className="nt-head">
                <h2 className="nt-title">{note.title}</h2>
                <button type="button" className="om-link nt-edit" onClick={() => setEditing(note.id)} disabled={editing !== null}>
                  Edit
                </button>
              </div>
              <NoteBody body={note.body} />
              <div className="ov-muted nt-meta">
                Updated {new Date(note.updated_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                {nameOf(note.updated_by) && ` by ${nameOf(note.updated_by)}`}
              </div>
            </article>
          ),
        )
      )}
    </div>
  );
}

function Spans({ spans }) {
  return spans.map((s, i) => (s.bold ? <strong key={i}>{s.text}</strong> : <Fragment key={i}>{s.text}</Fragment>));
}

function NoteBody({ body }) {
  const blocks = parseNote(body);
  if (blocks.length === 0) return <p className="ov-muted">Empty.</p>;
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

function NoteEditor({ note, householdId, me, position = 0, onCancel, onSaved }) {
  const [title, setTitle] = useState(note?.title ?? '');
  const [body, setBody] = useState(note?.body ?? '');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save(e) {
    e.preventDefault();
    if (!title.trim()) {
      setError('Give it a title.');
      return;
    }
    setSaving(true);
    setError('');
    const payload = { title: title.trim(), body, updated_by: me?.id ?? null, updated_at: new Date().toISOString() };
    const { error: saveError } = note
      ? await supabase.from('household_notes').update(payload).eq('id', note.id)
      : await supabase.from('household_notes').insert({ ...payload, household_id: householdId, position });
    setSaving(false);
    if (saveError) {
      setError(saveError.message);
      return;
    }
    await onSaved();
  }

  async function remove() {
    setSaving(true);
    const { error: delError } = await supabase.from('household_notes').delete().eq('id', note.id);
    setSaving(false);
    if (delError) {
      setError(delError.message);
      return;
    }
    await onSaved();
  }

  return (
    <form className="nt-card nt-editing" onSubmit={save} aria-label={note ? `Edit ${note.title}` : 'New note'}>
      <label className="te-fieldcell">
        <span className="te-fieldlabel">Title</span>
        <input className="te-fieldvalue" type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Who pays what" />
      </label>
      <label className="te-fieldcell" style={{ marginTop: 14 }}>
        <span className="te-fieldlabel">Note</span>
        <textarea className="nt-textarea" value={body} onChange={(e) => setBody(e.target.value)} rows={14} />
      </label>
      <div className="ov-muted" style={{ marginTop: 6 }}>
        “# ” for a heading, “- ” for a bullet, **bold**, a blank line between paragraphs.
      </div>
      {error && (
        <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
          {error}
        </p>
      )}
      <div className="nt-actions">
        {note &&
          (confirmingDelete ? (
            <>
              <span className="ov-muted">Delete this note?</span>
              <button type="button" className="om-btn" onClick={remove} disabled={saving}>
                Delete
              </button>
              <button type="button" className="om-btn" onClick={() => setConfirmingDelete(false)}>
                Keep
              </button>
            </>
          ) : (
            <button type="button" className="om-btn" onClick={() => setConfirmingDelete(true)}>
              Delete
            </button>
          ))}
        <span style={{ flex: 1 }} />
        <button type="button" className="om-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="om-btn ov-btn-primary" disabled={saving}>
          {saving ? 'Saving…' : note ? 'Save' : 'Add note'}
        </button>
      </div>
    </form>
  );
}
