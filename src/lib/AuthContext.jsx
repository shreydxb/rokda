import { createContext, useContext, useEffect, useState } from 'react';
import { arrivedWithLinkError, openedFromRecoveryLink, supabase } from './supabaseClient';

const AuthContext = createContext(undefined);

// Set while the person is choosing a new password after a reset link, and kept
// in sessionStorage so that reloading that screen comes back to it. Cleared
// when the password is saved, on sign-out, or when there is no session.
const RECOVERY_KEY = 'rokda:password-recovery';

function readRecoveryFlag() {
  try {
    return sessionStorage.getItem(RECOVERY_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeRecoveryFlag(on) {
  try {
    if (on) sessionStorage.setItem(RECOVERY_KEY, 'true');
    else sessionStorage.removeItem(RECOVERY_KEY);
  } catch {
    // Storage refused (private mode): the flag lasts for this page load only.
  }
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [recovering, setRecovering] = useState(() => openedFromRecoveryLink || readRecoveryFlag());
  // Why a reset link that failed brought the person to Sign in. Held here
  // rather than in Login, which mounts again after every sign-out: once
  // anyone is signed in, the old link no longer matters.
  const [linkError, setLinkError] = useState(arrivedWithLinkError);

  useEffect(() => {
    if (openedFromRecoveryLink) writeRecoveryFlag(true);

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
      if (data.session) {
        setLinkError('');
      } else {
        // A reset link that produced no session (expired, already used)
        // leaves nothing to set a password on; sign-in takes over.
        writeRecoveryFlag(false);
        setRecovering(false);
      }
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession);
      if (nextSession) setLinkError('');
      // supabase-js announces a reset link with PASSWORD_RECOVERY, once. It
      // also emits SIGNED_IN on every reload and whenever the tab regains
      // focus, so SIGNED_IN must not end recovery: only saving the password
      // or signing out does.
      if (event === 'PASSWORD_RECOVERY') {
        writeRecoveryFlag(true);
        setRecovering(true);
      } else if (event === 'SIGNED_OUT') {
        writeRecoveryFlag(false);
        setRecovering(false);
      }
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  const value = {
    session,
    user: session?.user ?? null,
    loading,
    recovering,
    linkError,
    finishRecovery: () => {
      writeRecoveryFlag(false);
      setRecovering(false);
    },
    signOut: () => supabase.auth.signOut(),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (ctx === undefined) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
