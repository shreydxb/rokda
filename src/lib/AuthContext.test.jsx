import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { AuthProvider, useAuth } from './AuthContext';

// What supabaseClient.js read from the address bar at load, and the session
// the client hands back. Getters, so each test can set its own arrival.
const client = vi.hoisted(() => ({ emit: null, session: null, fromRecoveryLink: false, linkError: '' }));

vi.mock('./supabaseClient', () => ({
  get openedFromRecoveryLink() {
    return client.fromRecoveryLink;
  },
  get arrivedWithLinkError() {
    return client.linkError;
  },
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: client.session } }),
      onAuthStateChange: (callback) => {
        client.emit = callback;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
      signOut: async () => ({ error: null }),
    },
  },
}));

const KEY = 'rokda:password-recovery';
const SESSION = { user: { id: 'u1', email: 'owner@example.test' } };

function Probe() {
  const { recovering, finishRecovery, linkError } = useAuth();
  return (
    <>
      <span data-testid="recovering">{String(recovering)}</span>
      <span data-testid="link-error">{linkError}</span>
      <button type="button" onClick={finishRecovery}>Done</button>
    </>
  );
}

async function renderProvider() {
  render(<AuthProvider><Probe /></AuthProvider>);
  await act(async () => {}); // getSession() resolves
}

const recovering = () => screen.getByTestId('recovering').textContent;
const linkError = () => screen.getByTestId('link-error').textContent;

beforeEach(() => {
  sessionStorage.clear();
  client.session = SESSION;
  client.fromRecoveryLink = false;
  client.linkError = '';
});

describe('AuthProvider: password recovery', () => {
  it('starts on PASSWORD_RECOVERY, and SIGNED_IN does not end it', async () => {
    await renderProvider();
    expect(recovering()).toBe('false');
    act(() => client.emit('PASSWORD_RECOVERY', SESSION));
    expect(recovering()).toBe('true');
    expect(sessionStorage.getItem(KEY)).toBe('true');
    // supabase-js emits SIGNED_IN on every reload and when the tab regains focus.
    act(() => client.emit('SIGNED_IN', SESSION));
    expect(recovering()).toBe('true');
  });

  it('starts straight away when the page was opened from a reset link', async () => {
    client.fromRecoveryLink = true;
    await renderProvider();
    expect(recovering()).toBe('true');
    expect(sessionStorage.getItem(KEY)).toBe('true');
  });

  it('ends once the new password is saved', async () => {
    await renderProvider();
    act(() => client.emit('PASSWORD_RECOVERY', SESSION));
    fireEvent.click(screen.getByText('Done'));
    expect(recovering()).toBe('false');
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('comes back after a reload of the recovery screen', async () => {
    sessionStorage.setItem(KEY, 'true');
    await renderProvider();
    expect(recovering()).toBe('true');
  });

  it('ends on sign-out', async () => {
    sessionStorage.setItem(KEY, 'true');
    await renderProvider();
    act(() => client.emit('SIGNED_OUT', null));
    expect(recovering()).toBe('false');
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('is dropped when there is no session to set a password on', async () => {
    sessionStorage.setItem(KEY, 'true');
    client.session = null;
    await renderProvider();
    expect(recovering()).toBe('false');
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });
});

describe('AuthProvider: a reset link that failed', () => {
  const EXPIRED = 'That reset link has expired or has already been used. Send yourself a new one below.';

  it('keeps the reason for Sign in while nobody is signed in, and drops it at the next sign-in', async () => {
    client.session = null;
    client.linkError = EXPIRED;
    await renderProvider();
    expect(linkError()).toBe(EXPIRED);
    // Signing out later in the same page load must not bring the old link back.
    act(() => client.emit('SIGNED_IN', SESSION));
    expect(linkError()).toBe('');
    act(() => client.emit('SIGNED_OUT', null));
    expect(linkError()).toBe('');
  });

  it('does not matter to someone already signed in', async () => {
    client.linkError = EXPIRED;
    await renderProvider();
    expect(linkError()).toBe('');
  });
});
