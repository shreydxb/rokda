import { useEffect, useRef } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// An editor drawer is a modal dialog in fact as well as in name. The drawers
// said aria-modal, but focus stayed on the button that opened them and Tab
// walked on through the page behind (Planning audit, 0b-F). While the drawer
// is open it holds focus, Tab and Shift+Tab go round inside it, and the rest
// of the page is inert: it cannot be focused or clicked, and screen readers
// leave it out. When it closes, focus goes back to whatever opened it.
//
// Returns the ref for the .te-drawer element, which also needs tabIndex={-1}
// so it can take focus itself. Focusing the drawer rather than its first
// field announces the dialog by name and keeps a phone's keyboard closed
// until a field is chosen.
export function useDrawerFocus() {
  const ref = useRef(null);
  useEffect(() => {
    const drawer = ref.current;
    if (!drawer) return undefined;
    const opener = document.activeElement;

    // Everything outside the drawer's own line of ancestors, up to the body.
    const inert = [];
    for (let node = drawer; node.parentElement && node !== document.body; node = node.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling !== node && !sibling.hasAttribute('inert')) {
          sibling.setAttribute('inert', '');
          inert.push(sibling);
        }
      }
    }
    if (!drawer.contains(document.activeElement)) drawer.focus();

    const onKey = (e) => {
      if (e.key !== 'Tab') return;
      const items = [...drawer.querySelectorAll(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === drawer)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    drawer.addEventListener('keydown', onKey);
    return () => {
      drawer.removeEventListener('keydown', onKey);
      for (const el of inert) el.removeAttribute('inert');
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return ref;
}
