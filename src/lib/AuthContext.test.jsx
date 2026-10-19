import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { AuthProvider, useAuth } from './AuthContext';

// What supabaseClient.js read from the address bar at load, and the session
// the client hands back. Getters, so each test can set its own arrival.
const client = vi.hoisted(() => ({ emit: null, session: null, fromRecoveryLink: false, linkError: '', aal: null, aalCalls: [] }));

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
      mfa: {
        getAuthenticatorAssuranceLevel: async (token) => {
          client.aalCalls.push(token);
          if (client.aal instanceof Error) throw client.aal;
          return client.aal ?? { data: null, error: { message: 'no answer set' } };
        },
      },
    },
  },
}));

const KEY = 'rokda:password-recovery';
const SESSION = { user: { id: 'u1', email: 'owner@example.test' } };

function Probe() {
  const { recovering, finishRecovery, linkError, session } = useAuth();
  return (
    <>
      <span data-testid="recovering">{String(recovering)}</span>
      <span data-testid="signed-in">{String(Boolean(session))}</span>
      <span data-testid="link-error">{linkError}</span>
      <button type="button" onClick={finishRecovery}>Done</button>
    </>
  );
}

async function renderProvider() {
  render(<AuthProvider><Probe /></AuthProvider>);
  await act(async () => {}); // getSession() resolves
}

// PASSWORD_RECOVERY and USER_UPDATED are handled after a turn of the event
// loop (AuthContext reads this tab's own session then); every event is sent
// through this, which waits for that.
async function emit(event, session) {
  await act(async () => {
    client.emit(event, session);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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
    await emit('PASSWORD_RECOVERY', SESSION);
    expect(recovering()).toBe('true');
    expect(sessionStorage.getItem(KEY)).toBe('true');
    // supabase-js emits SIGNED_IN on every reload and when the tab regains focus.
    await emit('SIGNED_IN', SESSION);
    expect(recovering()).toBe('true');
  });

  it('starts straight away when the page was opened from a reset link', async () => {
    client.fromRecoveryLink = true;
    await renderProvider();
    expect(recovering()).toBe('true');
    expect(sessionStorage.getItem(KEY)).toBe('true');
  });

  it('ends in every tab once the password is saved in one of them', async () => {
    // The tab that saved calls finishRecovery(); the others hear USER_UPDATED.
    await renderProvider();
    await emit('PASSWORD_RECOVERY', SESSION);
    await emit('USER_UPDATED', SESSION);
    expect(recovering()).toBe('false');
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('ends once the new password is saved', async () => {
    await renderProvider();
    await emit('PASSWORD_RECOVERY', SESSION);
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
    await emit('SIGNED_OUT', null);
    expect(recovering()).toBe('false');
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('does not start in a tab that holds no session of its own, whatever another tab relays', async () => {
    // "Keep me signed in" off: the session the link made lives in the other
    // tab's sessionStorage. This tab hears the relayed event and stays on Sign in.
    client.session = null;
    await renderProvider();
    await emit('PASSWORD_RECOVERY', SESSION);
    expect(recovering()).toBe('false');
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(screen.getByTestId('signed-in').textContent).toBe('false');
    // And the other tab saving its password does not sign this one in.
    await emit('USER_UPDATED', SESSION);
    expect(screen.getByTestId('signed-in').textContent).toBe('false');
  });

  it('belongs to the member who reset: a tab signed in as someone else is not moved by it', async () => {
    // "Keep me signed in" off, two members in two tabs of one browser.
    const PARTNER = { user: { id: 'u2', email: 'partner@example.test' } };
    client.session = PARTNER;
    await renderProvider();
    await emit('PASSWORD_RECOVERY', SESSION);
    expect(recovering()).toBe('false');
    expect(sessionStorage.getItem(KEY)).toBeNull();

    // And the partner's own reset is not ended by the owner saving theirs.
    await emit('PASSWORD_RECOVERY', PARTNER);
    expect(recovering()).toBe('true');
    await emit('USER_UPDATED', SESSION);
    expect(recovering()).toBe('true');
    await emit('USER_UPDATED', PARTNER);
    expect(recovering()).toBe('false');
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
    await emit('SIGNED_IN', SESSION);
    expect(linkError()).toBe('');
    await emit('SIGNED_OUT', null);
    expect(linkError()).toBe('');
  });

  it('does not matter to someone already signed in', async () => {
    client.linkError = EXPIRED;
    await renderProvider();
    expect(linkError()).toBe('');
  });
});

describe('the second step of signing in', () => {
  function TwoStepProbe() {
    const { twoStep } = useAuth();
    return <span data-testid="two-step">{twoStep}</span>;
  }
  const twoStep = () => screen.getByTestId('two-step').textContent;

  beforeEach(() => {
    client.aalCalls = [];
    client.aal = null;
  });

  async function renderWith(session) {
    client.session = session;
    render(<AuthProvider><TwoStepProbe /></AuthProvider>);
    await act(async () => {});
    await act(async () => {});
  }

  it('asks the server, with the session\'s own token, and lets an aal2 session through', async () => {
    client.aal = { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null };
    await renderWith({ ...SESSION, access_token: 'token-a' });
    expect(client.aalCalls).toEqual(['token-a']);
    expect(twoStep()).toBe('ok');
  });

  it('asks for a code when the member has an authenticator', async () => {
    client.aal = { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null };
    await renderWith({ ...SESSION, access_token: 'token-b' });
    expect(twoStep()).toBe('challenge');
  });

  it('checks again when the session changes, as it does once a code is verified', async () => {
    client.aal = { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null };
    await renderWith({ ...SESSION, access_token: 'token-c' });
    client.aal = { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null };
    await emit('MFA_CHALLENGE_VERIFIED', { ...SESSION, access_token: 'token-d' });
    await act(async () => {});
    expect(client.aalCalls).toEqual(['token-c', 'token-d']);
    expect(twoStep()).toBe('ok');
  });

  // A token is refreshed about hourly, in this tab or another, and each new
  // one is checked again. Showing the two-step screen while that check runs
  // took every screen away, and with it whatever an open editor held.
  describe('when the same member’s token is refreshed', () => {
    const OK = { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null };
    function HistoryProbe({ seen }) {
      const { twoStep } = useAuth();
      seen.push(twoStep);
      return <span data-testid="two-step">{twoStep}</span>;
    }
    async function passedThenRefreshed(answer) {
      const seen = [];
      client.aal = OK;
      client.session = { ...SESSION, access_token: 'token-1' };
      render(<AuthProvider><HistoryProbe seen={seen} /></AuthProvider>);
      await act(async () => {});
      await act(async () => {});
      expect(twoStep()).toBe('ok');
      seen.length = 0;
      client.aal = answer;
      await emit('TOKEN_REFRESHED', { ...SESSION, access_token: 'token-2' });
      await act(async () => {});
      return seen;
    }

    it('keeps the app on screen while the new token is checked', async () => {
      const seen = await passedThenRefreshed(OK);
      expect(client.aalCalls).toEqual(['token-1', 'token-2']);
      expect(seen).not.toContain('checking');
      expect(twoStep()).toBe('ok');
    });

    it('still stops a session the server says has not passed', async () => {
      await passedThenRefreshed({ data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null });
      expect(twoStep()).toBe('challenge');
    });

    it('stays through a check that could not be made: the database still asks for the code on every read', async () => {
      const seen = await passedThenRefreshed({ data: null, error: { message: 'network' } });
      expect(seen).not.toContain('error');
      expect(twoStep()).toBe('ok');
    });

    it('checks a different member from the start', async () => {
      const seen = await passedThenRefreshed(OK);
      expect(seen).not.toContain('checking');
      seen.length = 0;
      client.aal = { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null };
      await emit('SIGNED_IN', { user: { id: 'u2' }, access_token: 'token-3' });
      await act(async () => {});
      expect(seen).toContain('checking');
      expect(twoStep()).toBe('challenge');
    });

    it('checks from the start again after signing out and back in', async () => {
      await passedThenRefreshed(OK);
      await emit('SIGNED_OUT', null);
      expect(twoStep()).toBe('checking');
      client.aal = { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null };
      await emit('SIGNED_IN', { ...SESSION, access_token: 'token-4' });
      await act(async () => {});
      expect(twoStep()).toBe('challenge');
    });
  });

  it('lets nothing through when the check fails or throws', async () => {
    client.aal = { data: null, error: { message: 'network' } };
    await renderWith({ ...SESSION, access_token: 'token-e' });
    expect(twoStep()).toBe('error');
  });

  it('treats a thrown check as failed too', async () => {
    client.aal = new Error('bad token');
    await renderWith({ ...SESSION, access_token: 'token-f' });
    expect(twoStep()).toBe('error');
  });
});
