import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Login from './Login';

const auth = vi.hoisted(() => ({ resetPasswordForEmail: vi.fn(async () => ({ error: null })), linkError: '' }));

vi.mock('../lib/supabaseClient', () => ({
  supabase: { auth: { resetPasswordForEmail: auth.resetPasswordForEmail } },
  setKeepSignedIn: () => {},
}));

vi.mock('../lib/AuthContext', () => ({
  useAuth: () => ({ linkError: auth.linkError }),
}));

const EXPIRED = 'That reset link has expired or has already been used. Send yourself a new one below.';

function renderLogin() {
  render(
    <MemoryRouter initialEntries={['/login']}>
      <Login />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  auth.resetPasswordForEmail.mockClear();
  auth.linkError = '';
});

describe('Login: forgot password', () => {
  it('sends the reset link back to the app root, not to a path outside it', async () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'owner@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    await screen.findByText(/a reset link is on its way/);
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith('owner@example.test', {
      redirectTo: `${window.location.origin}${import.meta.env.BASE_URL}`,
    });
  });
});

describe('Login: a reset link that failed', () => {
  it('opens on Reset password and says the link has expired or was used', () => {
    auth.linkError = EXPIRED;
    renderLogin();
    expect(screen.getByRole('heading', { name: 'Reset password' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(EXPIRED);
    expect(screen.getByRole('button', { name: 'Send reset link' })).toBeTruthy();
  });

  it('drops the message on the way back to sign in', () => {
    auth.linkError = EXPIRED;
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is an ordinary sign-in when no link failed', () => {
    renderLogin();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
