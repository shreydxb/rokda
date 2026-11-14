import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { renderScreen } from '../test/renderScreen';

const setTheme = vi.fn();
const signOut = vi.fn();
let inboxCount = 0;

vi.mock('../lib/supabaseClient', () => ({ supabase: {} }));
vi.mock('../lib/AuthContext', () => ({ useAuth: () => ({ user: { email: 'partner@example.com' }, signOut }) }));
vi.mock('../lib/ThemeContext', () => ({ useTheme: () => ({ theme: 'light', setTheme, toggleTheme: vi.fn() }) }));
vi.mock('./useInboxCount', () => ({ useInboxCount: () => inboxCount }));
vi.mock('../lib/useHousehold', () => ({
  useHousehold: () => ({
    household: { id: 'hh', name: 'Test household', inr_per_aed: 25 },
    me: { id: 'm1', display_name: 'Partner A' },
    members: [
      { id: 'm1', display_name: 'Partner A' },
      { id: 'm2', display_name: 'Partner B' },
    ],
  }),
}));

const { default: AppShell } = await import('./AppShell');

const shell = (path = '/') =>
  renderScreen(
    <MemoryRouter initialEntries={[path]}>
      <AppShell />
    </MemoryRouter>,
  );

const openAccount = () => fireEvent.click(screen.getByRole('button', { name: /Partner A/ }));

beforeEach(() => {
  inboxCount = 0;
  setTheme.mockClear();
  signOut.mockClear();
});

// Round 2 of the outside review, E2-8: which household scope and which
// display currency are chosen was shown only by data-active, which a screen
// reader does not announce. Each is a toggle button that says whether it is
// pressed.
describe('AppShell: the scope and currency choices', () => {
  it('say which one is chosen, and follow a new choice', () => {
    shell();
    const scope = within(screen.getByRole('group', { name: 'Household scope' }));
    expect(scope.getByRole('button', { name: 'Both' }).getAttribute('aria-pressed')).toBe('true');
    expect(scope.getByRole('button', { name: 'Me' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(scope.getByRole('button', { name: 'Me' }));
    expect(scope.getByRole('button', { name: 'Me' }).getAttribute('aria-pressed')).toBe('true');
    expect(scope.getByRole('button', { name: 'Both' }).getAttribute('aria-pressed')).toBe('false');

    // The revamp: the currency is changed rarely, so it sits in the account
    // menu at the foot of the sidebar.
    openAccount();
    const currency = within(screen.getByRole('group', { name: 'Display currency' }));
    expect(currency.getByRole('button', { name: 'AED' }).getAttribute('aria-pressed')).toBe('true');
    expect(currency.getByRole('button', { name: 'INR' }).getAttribute('aria-pressed')).toBe('false');
  });
});

// The shell (November 2026): the build id is for checking a deploy, so it is
// on Settings, not in the sidebar every screen shows.
describe('AppShell: no technical details', () => {
  it('shows no build id in the sidebar', () => {
    shell();
    expect(screen.queryByText(/^build /)).toBeNull();
  });
});

// The revamp (review N1): the Inbox is worked every day, so it is its own
// item in the sidebar with its count beside it.
describe('AppShell: the Inbox in the sidebar', () => {
  it('links to the Inbox and shows how many wait', () => {
    inboxCount = 3;
    shell();
    const link = screen.getByRole('link', { name: /Inbox/ });
    expect(link.getAttribute('href')).toBe('/money?tab=inbox');
    expect(within(link).getByText('3')).toBeTruthy();
  });

  it('shows no count when nothing waits', () => {
    shell();
    expect(screen.getByRole('link', { name: 'Inbox' })).toBeTruthy();
  });

  it('is the item marked as current on the Inbox, not Money', () => {
    shell('/money?tab=inbox');
    expect(screen.getByRole('link', { name: 'Inbox' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Money' }).getAttribute('aria-current')).toBeNull();
  });

  it('leaves Money current on its other tabs', () => {
    shell('/money?tab=budget');
    expect(screen.getByRole('link', { name: 'Money' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Inbox' }).getAttribute('aria-current')).toBeNull();
  });
});

// The revamp (review N10): display currency, light or dark, and sign-out sit
// in one account menu at the foot of the sidebar.
describe('AppShell: the account menu', () => {
  it('is closed until asked for, and says who is signed in', () => {
    shell();
    const button = screen.getByRole('button', { name: /Partner A/ });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(within(button).getByText('Test household')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Display currency' })).toBeNull();
  });

  it('switches between light and dark', () => {
    shell();
    openAccount();
    const theme = within(screen.getByRole('group', { name: 'Theme' }));
    expect(theme.getByRole('button', { name: 'Light' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(theme.getByRole('button', { name: 'Dark' }));
    expect(setTheme).toHaveBeenCalledWith('dark');
  });

  it('signs out, and says as whom', () => {
    shell();
    openAccount();
    expect(screen.getByText('partner@example.com')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledOnce();
  });

  it('closes on Escape', () => {
    shell();
    openAccount();
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByRole('group', { name: 'Display currency' })).toBeNull();
    expect(screen.getByRole('button', { name: /Partner A/ }).getAttribute('aria-expanded')).toBe('false');
  });
});
