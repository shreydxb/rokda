import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';

const auth = vi.hoisted(() => ({ value: null }));
vi.mock('./lib/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('./lib/supabaseClient', () => ({ supabase: { auth: {} }, setKeepSignedIn: () => {} }));

const USER = { email: 'owner@example.test' };
const base = { user: USER, loading: false, linkError: '', finishRecovery: () => {}, signOut: () => {} };

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
