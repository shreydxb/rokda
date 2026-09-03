import { createClient } from '@supabase/supabase-js';

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

export const supabase = createClient(url, key, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storage: dynamicStorage,
  },
});
