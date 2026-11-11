import { useEffect, useState } from 'react';

// How every editor drawer is left: at once when nothing was changed, and with
// "Discard changes?" first when something was. A second Escape, or Discard,
// then closes it; Keep editing goes back. Fourteen editors each kept their own
// copy of this (the round 2 cleanup, SHR-383); DiscardPrompt is its buttons.
//
// `dirty` is whatever counts as unsaved work in that editor (a trade being
// typed counts in the holding editor). `onEscape` is for an editor that has
// something to step back from before closing (a pending confirmation, a
// drawer open on top of it); it is called instead of requestClose.
export function useCloseGuard({ dirty, onClose, onEscape }) {
  const [confirmingClose, setConfirmingClose] = useState(false);

  function requestClose() {
    if (dirty && !confirmingClose) {
      setConfirmingClose(true);
      return;
    }
    onClose();
  }

  // Subscribed afresh on each render, so Escape always reads the editor as it
  // is now rather than as it was when the listener was added.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (onEscape) onEscape(e);
      else requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return { confirmingClose, setConfirmingClose, requestClose, keepEditing: () => setConfirmingClose(false) };
}
