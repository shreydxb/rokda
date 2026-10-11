// Who is calling an Edge Function, decided before it does any work.
//
// price-refresh and fd-accrual are deployed with verify_jwt = false
// (supabase/config.toml, checked against production by verify:functions):
// the nightly jobs send a scheduler secret rather than a JWT, so the platform
// checks nothing and every caller reaches the function. Each function decides
// for itself. The scheduler is recognised by a secret from the vault, compared
// in constant time; price-refresh also admits a signed-in household member,
// whose token it checks with the Auth server rather than decoding it.

// The bearer token on a request, or null when there is none.
export function bearerToken(req: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec((req.headers.get("Authorization") ?? "").trim());
  return match ? match[1] : null;
}

// The header the nightly jobs put the vault's scheduler_secret in (see the
// scheduler_secret migration). Not a CORS-allowed header: no browser sends it.
export const SCHEDULER_SECRET_HEADER = "X-Rokda-Scheduler-Secret";

// The owner's steps make a 64-character secret. Anything shorter than this is
// a mistake (a placeholder, a truncated paste, an empty value), and is treated
// as no secret at all, so no scheduled call is accepted until it is fixed.
export const MIN_SCHEDULER_SECRET_LENGTH = 32;

// The scheduler secret a request presents, or null when it sends none. An
// empty header counts as presented: it is a scheduled call that is wrong, not
// a member's request.
export function presentedSchedulerSecret(req: Request): string | null {
  return req.headers.get(SCHEDULER_SECRET_HEADER);
}

// Whether a presented scheduler secret is the vault's. `loadExpected` reads
// it (the get_scheduler_secret RPC), and is called only when something was
// presented, so a request without the header costs no database round trip.
// Fails closed: a lookup that errors or throws, a secret that is unset, and
// one shorter than MIN_SCHEDULER_SECRET_LENGTH each refuse every call.
export async function schedulerSecretMatches(
  presented: string | null,
  loadExpected: () => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<boolean> {
  if (presented === null) return false;
  let expected: string | null = null;
  try {
    const { data, error } = await loadExpected();
    if (!error && typeof data === "string") expected = data;
  } catch {
    expected = null;
  }
  if (expected === null || expected.length < MIN_SCHEDULER_SECRET_LENGTH) return false;
  return secretsMatch(presented, expected);
}

// Compares a presented secret with the expected one in time that does not
// depend on where they first differ, or on the presented secret's length.
// `!==` stops at the first differing character, which lets anyone who can
// time the endpoint learn the secret a character at a time. This always
// walks the whole expected secret, and only it, so the time depends on the
// secret's length alone, which is fixed. Synchronous on purpose: an awaited
// digest finishes on another thread at an unpredictable moment, which made
// concurrent deliveries of one update race differently from run to run. An
// unset expected secret matches nothing.
const encoder = new TextEncoder();

export function secretsMatch(provided: string | null, expected: string | null): boolean {
  if (!provided || !expected) return false;
  const given = encoder.encode(provided);
  const wanted = encoder.encode(expected);
  let difference = given.length ^ wanted.length;
  for (let i = 0; i < wanted.length; i++) difference |= given[i % given.length] ^ wanted[i];
  return difference === 0;
}
