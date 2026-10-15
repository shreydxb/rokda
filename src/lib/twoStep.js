// Two-step sign-in: a password, then a code from an authenticator app
// (docs/decisions.md, "Signing in takes a password and a code"; SHR-312).
//
// Supabase Auth carries the result in the session: aal1 after the password,
// aal2 once a code has been verified. The app shows nothing of the household
// until the session is aal2, and the database refuses an aal1 session for a
// member who has an authenticator (private.mfa_satisfied), so the rule holds
// outside the app as well.

// What the signed-in person has to do next, from the assurance levels
// supabase.auth.mfa.getAuthenticatorAssuranceLevel() reports.
//   'ok'        the session has passed its second step
//   'challenge' an authenticator is set up: enter its code
//   'enroll'    none is set up yet: add one, then enter its code
//   'error'     the check itself failed. Nothing is shown on a guess.
export function twoStepState(levels, error) {
  if (error || !levels) return 'error';
  if (levels.currentLevel === 'aal2') return 'ok';
  if (levels.nextLevel === 'aal2') return 'challenge';
  return 'enroll';
}

// The authenticator a code is checked against: the verified TOTP factor.
export function verifiedTotp(factors) {
  return (factors?.totp ?? []).find((f) => f.status === 'verified') ?? null;
}

// Authenticators someone started adding and never confirmed. They are
// removed before a fresh one is offered, so an abandoned attempt (a closed
// tab, a reload) never piles up or blocks the next.
export function abandonedTotp(factors) {
  return (factors?.all ?? []).filter((f) => f.factor_type === 'totp' && f.status !== 'verified');
}

// A code is six digits. Spaces are allowed, as authenticator apps show them
// in two groups of three.
export function cleanCode(input) {
  return String(input ?? '').replace(/\s+/g, '');
}

export function codeProblem(input) {
  const code = cleanCode(input);
  if (code === '') return 'Enter the 6-digit code from your authenticator app.';
  if (!/^\d{6}$/.test(code)) return 'The code is 6 digits.';
  return '';
}
