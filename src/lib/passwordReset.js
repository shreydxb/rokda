// Password reset: the pieces of it that are plain logic. They live here rather
// than in supabaseClient.js, which throws without its environment variables
// and so cannot be loaded by a test.

// Where the reset email sends the person back to: the app's own root, base
// path included. A host that serves Rokda from a sub-path (GitHub Pages used
// /<repo>/) puts `${origin}/login` outside the app entirely, and the root is
// the one address that loads the app on every host, whatever its deep-link
// fallback.
// AuthContext picks the recovery up from there.
export function resetRedirectUrl(origin, base) {
  return new URL(base, origin).href;
}

function fragmentParams(hash) {
  return new URLSearchParams(String(hash ?? '').replace(/^#/, ''));
}

// True when this page load came from a reset email. Supabase puts the recovery
// session in the URL fragment: `#access_token=...&type=recovery`.
export function isRecoveryRedirect(hash) {
  return fragmentParams(hash).get('type') === 'recovery';
}

// What to tell someone whose reset link did not sign them in, or '' when the
// page was not opened from a failed link. Supabase sends them back with the
// reason in the fragment (`#error=access_denied&error_code=otp_expired&...`),
// or in the query string, and otherwise they would land on Sign in with no
// word about why. The message is fixed text: the description in the URL is
// never shown, because anyone can write a link that carries one.
export function resetLinkError(hash, search = '') {
  const query = new URLSearchParams(String(search ?? ''));
  const fragment = fragmentParams(hash);
  const param = (name) => query.get(name) ?? fragment.get(name);
  // The same three names supabase-js treats as a failed sign-in link.
  if (['error', 'error_code', 'error_description'].every((name) => param(name) === null)) return '';
  if (param('error_code') === 'otp_expired') return 'That reset link has expired or has already been used. Send yourself a new one below.';
  return 'That link did not sign you in. Send yourself a new reset link below.';
}
