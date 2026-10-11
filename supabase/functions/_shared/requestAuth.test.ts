// Unit tests for the request checks shared by the Edge Functions. The
// handler-level behaviour (who each function lets in) is in
// scheduledCallers.test.ts.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { bearerToken, isServiceRoleRequest, jwtClaims, secretsMatch } from "./requestAuth.ts";

// An unsigned token with the given claims. The functions never check a
// signature themselves -- the platform's verify_jwt does -- so the tests do
// not need a real one.
function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

function withAuthorization(value: string | null): Request {
  return new Request("http://edge.test/fn", { method: "POST", headers: value === null ? {} : { Authorization: value } });
}

Deno.test("a bearer token is read from the Authorization header and nothing else", () => {
  assertEquals(bearerToken(withAuthorization("Bearer abc.def.ghi")), "abc.def.ghi");
  assertEquals(bearerToken(withAuthorization("bearer abc.def.ghi")), "abc.def.ghi");
  assertEquals(bearerToken(withAuthorization(null)), null);
  assertEquals(bearerToken(withAuthorization("Basic abc")), null);
  assertEquals(bearerToken(withAuthorization("Bearer")), null);
  assertEquals(bearerToken(withAuthorization("Bearer a b")), null);
});

Deno.test("claims are read from a JWT's payload, and anything else reads as none", () => {
  assertEquals(jwtClaims(fakeJwt({ role: "service_role", sub: "x" })), { role: "service_role", sub: "x" });
  // A payload whose base64url carries both "-" and "_" (base64 "+" and "/"),
  // which atob rejects unless they are mapped back, with its padding
  // stripped the way a JWT's is.
  const token = fakeJwt({ role: "authenticated", sub: "?>.??" });
  const payload = token.split(".")[1];
  assert(payload.includes("-") && payload.includes("_") && !payload.endsWith("="), token);
  assertEquals(jwtClaims(token), { role: "authenticated", sub: "?>.??" });
  for (const bad of ["", "abc", "a.b", "a..c", "a.!!!.c", `a.${btoa("[1,2]")}.c`, `a.${btoa("null")}.c`, "sb_publishable_xxxxxxxx"]) {
    assertEquals(jwtClaims(bad), null, bad);
  }
});

Deno.test("only a service-role token counts as the scheduler", () => {
  assert(isServiceRoleRequest(withAuthorization(`Bearer ${fakeJwt({ role: "service_role" })}`)));
  for (const role of ["anon", "authenticated", "SERVICE_ROLE", "service_role ", undefined]) {
    assert(!isServiceRoleRequest(withAuthorization(`Bearer ${fakeJwt(role === undefined ? {} : { role })}`)), String(role));
  }
  assert(!isServiceRoleRequest(withAuthorization(null)));
  assert(!isServiceRoleRequest(withAuthorization("Bearer sb_secret_notajwt")));
});

Deno.test("a secret matches only itself, and an unset secret matches nothing", () => {
  const secret = "0123456789abcdef0123456789abcdef";
  assert(secretsMatch(secret, secret));
  assert(!(secretsMatch(secret.slice(0, -1) + "0", secret)));
  assert(!(secretsMatch(secret + "0", secret)));
  assert(!(secretsMatch(secret.slice(0, -1), secret)));
  assert(!(secretsMatch("", secret)));
  assert(!(secretsMatch(null, secret)));
  assert(!(secretsMatch(secret, "")));
  assert(!(secretsMatch(secret, null)));
  assert(!(secretsMatch("", "")));
  // A prefix repeated to the right length is not the secret either.
  assert(!(secretsMatch(secret.slice(0, 16), secret)));
  assert(!(secretsMatch(secret.slice(0, 8).repeat(4), secret)));
});
