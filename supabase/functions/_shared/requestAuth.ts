// Who is calling an Edge Function, decided before it does any work.
//
// price-refresh and fd-accrual are deployed with verify_jwt = true
// (supabase/config.toml, checked against production by verify:functions), so
// the platform has already checked a bearer token's signature before the
// function runs. That proves only that the token was issued by this project:
// the publishable key's anonymous role and any signed-in user pass it too. So
// each function also asks which role the token carries.

// The bearer token on a request, or null when there is none.
export function bearerToken(req: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec((req.headers.get("Authorization") ?? "").trim());
  return match ? match[1] : null;
}

// The claims of a JWT, read without checking its signature: callers rely on
// the platform's verify_jwt for that. Null for anything that is not a JWT
// with a JSON object as its payload.
export function jwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === "") return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
    return claims !== null && typeof claims === "object" && !Array.isArray(claims) ? claims : null;
  } catch {
    return null;
  }
}

// True only for the service role: the scheduled jobs send the service-role
// key from the vault (see the schedule_all_jobs migration). Never true for a
// request with no token, the anonymous role or a signed-in user.
export function isServiceRoleRequest(req: Request): boolean {
  const token = bearerToken(req);
  return token !== null && jwtClaims(token)?.role === "service_role";
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
