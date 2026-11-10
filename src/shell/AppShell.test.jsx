import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { renderScreen } from '../test/renderScreen';

vi.mock('../lib/supabaseClient', () => ({ supabase: {} }));
vi.mock('../lib/AuthContext', () => ({ useAuth: () => ({ user: { email: 'partner@example.com' }, signOut: vi.fn() }) }));
vi.mock('../lib/ThemeContext', () => ({ useTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }) }));
vi.mock('../lib/useHousehold', () => ({
  useHousehold: () => ({
    household: { id: 'hh', name: 'Test', inr_per_aed: 25 },
    me: { id: 'm1', display_name: 'Partner A' },
    members: [
      { id: 'm1', display_name: 'Partner A' },
      { id: 'm2', display_name: 'Partner B' },
    ],
  }),
}));

const { default: AppShell } = await import('./AppShell');

// Round 2 of the outside review, E2-8: which household scope and which
// display currency are chosen was shown only by data-active, which a screen
// reader does not announce. Each is a toggle button that says whether it is
// pressed.
describe('AppShell: the scope and currency choices', () => {
  it('say which one is chosen, and follow a new choice', () => {
    renderScreen(
      <MemoryRouter>
        <AppShell />
      </MemoryRouter>,
    );
    const scope = within(screen.getByRole('group', { name: 'Household scope' }));
    expect(scope.getByRole('button', { name: 'Both' }).getAttribute('aria-pressed')).toBe('true');
    expect(scope.getByRole('button', { name: 'Me' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(scope.getByRole('button', { name: 'Me' }));
    expect(scope.getByRole('button', { name: 'Me' }).getAttribute('aria-pressed')).toBe('true');
    expect(scope.getByRole('button', { name: 'Both' }).getAttribute('aria-pressed')).toBe('false');

    const currency = within(screen.getByRole('group', { name: 'Display currency' }));
    expect(currency.getByRole('button', { name: 'AED' }).getAttribute('aria-pressed')).toBe('true');
    expect(currency.getByRole('button', { name: 'INR' }).getAttribute('aria-pressed')).toBe('false');
  });
});
