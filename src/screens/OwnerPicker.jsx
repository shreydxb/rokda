const SHARED = { id: 'shared', display_name: 'Shared' };

// Whose a record is: Shared, or one member of the household. Seven editors
// and the Inbox kept a copy of these buttons, and only two said which was
// pressed (the round 2 cleanup, SHR-383). `labelledBy` is the id of the
// editor's own label for it, which makes it a named group.
export default function OwnerPicker({ value, members, onChange, labelledBy }) {
  return (
    <div className="om-scope-list" role={labelledBy ? 'group' : undefined} aria-labelledby={labelledBy} style={{ marginTop: 10 }}>
      {[SHARED, ...members].map((m) => (
        <button key={m.id} type="button" className="om-scope" data-active={value === m.id} aria-pressed={value === m.id} onClick={() => onChange(m.id)}>
          {m.display_name}
        </button>
      ))}
    </div>
  );
}
