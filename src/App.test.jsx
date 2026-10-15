import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';

const auth = vi.hoisted(() => ({ value: null }));
vi.mock('./lib/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('./lib/supabaseClient', () => ({
  supabase: { auth: { mfa: { listFactors: () => new Promise(() => {}), enroll: () => new Promise(() => {}) } } },
  setKeepSignedIn: () => {},
}));

const USER = { email: 'owner@example.test' };
const base = { user: USER, loading: false, linkError: '', twoStep: 'ok', recheckTwoStep: () => {}, finishRecovery: () => {}, signOut: () => {} };

describe('App: password recovery', () => {
  it('asks for a new password whatever the path', () => {
    auth.value = { ...base, session: { user: USER }, recovering: true };
    render(
      <MemoryRouter initialEntries={['/money']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Set a new password' })).toBeTruthy();
  });

  it('leaves sign-in alone when there is no session', () => {
    auth.value = { ...base, user: null, session: null, recovering: true };
    render(
      <MemoryRouter initialEntries={['/login']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy();
  });
});

describe('App: two-step sign-in', () => {
  function renderAt(path, value) {
    auth.value = { ...base, session: { user: USER }, recovering: false, ...value };
    return render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  }

  it('asks for the code before anything else, on any path', () => {
    renderAt('/money', { twoStep: 'challenge' });
    expect(screen.getByRole('heading', { name: 'Enter your code' })).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('has a member with no authenticator add one first', () => {
    renderAt('/', { twoStep: 'enroll' });
    expect(screen.getByRole('heading', { name: 'Add an authenticator' })).toBeTruthy();
  });

  it('shows nothing of the household while the check is running or has failed', () => {
    renderAt('/', { twoStep: 'checking' });
    expect(screen.getByText('Checking your sign-in…')).toBeTruthy();
    renderAt('/', { twoStep: 'error' });
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('asks for the code before a reset link\'s new password', () => {
    renderAt('/', { twoStep: 'challenge', recovering: true });
    expect(screen.getByRole('heading', { name: 'Enter your code' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Set a new password' })).toBeNull();
  });
});
