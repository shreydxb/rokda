import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeProvider, useTheme } from './ThemeContext';

function Probe() {
  const { theme, setTheme } = useTheme();
  return (
    <>
      <span data-testid="theme">{theme}</span>
      <button type="button" onClick={() => setTheme('light')}>
        light
      </button>
    </>
  );
}

const prefers = (dark) => {
  window.matchMedia = vi.fn((q) => ({ matches: q === '(prefers-color-scheme: dark)' ? dark : false, media: q, addEventListener() {}, removeEventListener() {} }));
};

afterEach(() => {
  localStorage.clear();
  delete window.matchMedia;
});

// The revamp (November 2026): a first visit follows the device's light or
// dark setting; a choice made in the app is remembered and wins after that.
describe('ThemeProvider', () => {
  it('follows the device on a first visit', () => {
    prefers(false);
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('theme').textContent).toBe('light');
  });

  it('follows a dark device too', () => {
    prefers(true);
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('theme').textContent).toBe('dark');
  });

  it('keeps the choice made in the app over the device', () => {
    prefers(true);
    const { unmount } = render(<ThemeProvider><Probe /></ThemeProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'light' }));
    unmount();
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('theme').textContent).toBe('light');
  });
});
