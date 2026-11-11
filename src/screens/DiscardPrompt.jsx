// The question an editor asks before closing over unsaved changes
// (useCloseGuard), with its two answers. One copy, so every drawer asks it
// the same way (the round 2 cleanup, SHR-383).
export default function DiscardPrompt({ question = 'Discard changes?', onDiscard, onKeepEditing }) {
  return (
    <>
      <span className="ov-muted" style={{ marginRight: 8 }}>
        {question}
      </span>
      <button type="button" className="om-btn" onClick={onDiscard}>
        Discard
      </button>
      <button type="button" className="om-btn" onClick={onKeepEditing}>
        Keep editing
      </button>
    </>
  );
}
