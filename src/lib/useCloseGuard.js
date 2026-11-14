import { useEffect, useState } from 'react';

// How an editor drawer is left: at once when nothing was changed, and with
// "Discard changes?" first when something was. A second Escape, or Discard,
// then closes it; Keep editing goes back. Fifteen editors each kept their own
// copy of this (the round 2 cleanup, SHR-383); DiscardPrompt is its buttons.
// The transfer editor keeps its own, which shares one prompt among close,
// delete and unlink.
//
// `dirty` is whatever counts as unsaved work in that editor (a trade being
// typed counts in the holding editor). `onEscape` is for an editor that has
// something to step back from before closing (a pending confirmation, a
// drawer open on top of it); it is called instead of requestClose.
//
// An editor drawn in the shared kit's Drawer passes `listen: false` and hands
// `escapeKey` to the Drawer, which answers Escape on itself and stops it
// there: one key press, one step back, and a drawer underneath or a popover
// inside is left alone (fresh review of the kit).
export function useCloseGuard({ dirty, onClose, onEscape, listen = true }) {
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
  const escapeKey = (e) => {
    if (onEscape) onEscape(e);
    else requestClose();
  };
  useEffect(() => {
    if (!listen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') escapeKey(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return { confirmingClose, setConfirmingClose, requestClose, escapeKey, keepEditing: () => setConfirmingClose(false) };
}
