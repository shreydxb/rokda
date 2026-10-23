import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { useDrawerFocus } from './useDrawerFocus';

function Drawer({ onClose }) {
  const ref = useDrawerFocus();
  return (
    <div className="te-overlay">
      <div className="te-drawer" ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Edit thing">
        <input aria-label="First" />
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function Page() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <nav>
        <a href="#elsewhere">Elsewhere</a>
      </nav>
      <main>
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
        {open && <Drawer onClose={() => setOpen(false)} />}
      </main>
    </div>
  );
}

// The drawers said aria-modal while focus stayed behind them (Planning audit, 0b-F).
describe('useDrawerFocus', () => {
  it('takes focus, keeps Tab inside, makes the page behind inert, and gives focus back', () => {
    render(<Page />);
    const opener = screen.getByText('Open');
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Edit thing' });
    expect(document.activeElement).toBe(dialog);
    // Everything outside the drawer's own ancestors is inert.
    expect(document.querySelector('nav').hasAttribute('inert')).toBe(true);
    expect(opener.hasAttribute('inert')).toBe(true);
    expect(dialog.closest('[inert]')).toBeNull();

    // Tab from the last control comes round to the first, and back.
    const first = screen.getByLabelText('First');
    const close = screen.getByText('Close');
    close.focus();
    fireEvent.keyDown(close, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(close);

    fireEvent.click(close);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[inert]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
