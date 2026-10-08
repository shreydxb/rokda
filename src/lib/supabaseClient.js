import { createClient } from '@supabase/supabase-js';
import { isRecoveryRedirect, resetLinkError } from './passwordReset';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. Copy .env.example to .env and fill in your Supabase project values.'
  );
}

// "Keep me signed in" (login screen) chooses whether the session survives
// closing the browser (localStorage) or not (sessionStorage). The choice
// itself has to live in localStorage so it's readable before a session exists.
const KEEP_SIGNED_IN_KEY = 'rokda:keep-signed-in';

export function setKeepSignedIn(keep) {
  localStorage.setItem(KEEP_SIGNED_IN_KEY, keep ? 'true' : 'false');
}

function activeStorage() {
  return localStorage.getItem(KEEP_SIGNED_IN_KEY) === 'false' ? sessionStorage : localStorage;
}

const dynamicStorage = {
  getItem: (k) => activeStorage().getItem(k),
  setItem: (k, v) => activeStorage().setItem(k, v),
  removeItem: (k) => activeStorage().removeItem(k),
};

// Read before createClient: supabase-js consumes a reset link's fragment and
// clears it from the address bar. AuthContext opens "Set a new password" from
// the first straight away, rather than showing the app until the client gets
// round to announcing PASSWORD_RECOVERY. The second is why a link that failed
// (expired, or already used) brought the person here, which Sign in says.
export const openedFromRecoveryLink = isRecoveryRedirect(window.location.hash);
export const arrivedWithLinkError = resetLinkError(window.location.hash, window.location.search);

export const supabase = createClient(url, key, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storage: dynamicStorage,
  },
});
