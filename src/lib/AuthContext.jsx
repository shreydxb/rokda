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
      // supabase-js announces a reset link with PASSWORD_RECOVERY, once, and
      // saving the new password emits USER_UPDATED. It relays both to every
      // open tab, session included: a Sign in tab that asked for the link
      // hears the first, and the second must return it to the app. For these
      // two this tab's own session is read instead of the relayed one. With
      // "Keep me signed in" off each tab keeps its session in its own
      // sessionStorage, so a relayed session is one this tab's client does
      // not hold: it could neither save a password nor read anything with it,
      // and such a tab stays on Sign in. Deferred, because the callback runs
      // inside supabase-js's auth lock, which getSession() would wait on.
      if (event === 'PASSWORD_RECOVERY' || event === 'USER_UPDATED') {
        setTimeout(() => {
          supabase.auth.getSession().then(({ data }) => {
            setSession(data.session);
            if (data.session) setLinkError('');
            if (event === 'USER_UPDATED') {
              writeRecoveryFlag(false);
              setRecovering(false);
            } else if (data.session) {
              writeRecoveryFlag(true);
              setRecovering(true);
            }
          });
        }, 0);
        return;
      }

      setSession(nextSession);
      if (nextSession) setLinkError('');
      // supabase-js also emits SIGNED_IN on every reload and whenever the tab
      // regains focus, so SIGNED_IN must not end recovery: only saving the
      // password or signing out does.
      if (event === 'SIGNED_OUT') {
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
