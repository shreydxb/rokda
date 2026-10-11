// Unit tests for the request checks shared by the Edge Functions. The
// handler-level behaviour (who each function lets in) is in
// scheduledCallers.test.ts.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { bearerToken, MIN_SCHEDULER_SECRET_LENGTH, presentedSchedulerSecret, SCHEDULER_SECRET_HEADER, schedulerSecretMatches, secretsMatch } from "./requestAuth.ts";

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

function withSchedulerSecret(value: string | null): Request {
  return new Request("http://edge.test/fn", { method: "POST", headers: value === null ? {} : { [SCHEDULER_SECRET_HEADER]: value } });
}

Deno.test("a scheduler secret is read from its own header, and an empty one still counts as presented", () => {
  assertEquals(presentedSchedulerSecret(withSchedulerSecret("abc")), "abc");
  assertEquals(presentedSchedulerSecret(withSchedulerSecret("")), "");
  assertEquals(presentedSchedulerSecret(withSchedulerSecret(null)), null);
  assertEquals(presentedSchedulerSecret(withAuthorization("Bearer abc")), null);
});

const SECRET = "0123456789abcdef".repeat(4);

// A stand-in for the get_scheduler_secret RPC that records whether it ran.
function vault(answer: { data: unknown; error: unknown } | Error) {
  const lookups = { count: 0 };
  const load = () => {
    lookups.count += 1;
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer);
  };
  return { load, lookups };
}

Deno.test("the scheduler secret matches the vault's, and only it", async () => {
  const { load } = vault({ data: SECRET, error: null });
  assert(await schedulerSecretMatches(SECRET, load));
  for (const wrong of ["", SECRET.slice(0, -1), SECRET + "0", SECRET.toUpperCase(), ` ${SECRET}`]) {
    assert(!(await schedulerSecretMatches(wrong, load)), JSON.stringify(wrong));
  }
});

Deno.test("no presented secret is refused without asking the vault", async () => {
  const { load, lookups } = vault({ data: SECRET, error: null });
  assert(!(await schedulerSecretMatches(null, load)));
  assertEquals(lookups.count, 0);
});

Deno.test("a missing, short or unreadable vault secret refuses every call", async () => {
  const short = "x".repeat(MIN_SCHEDULER_SECRET_LENGTH - 1);
  const cases: Array<[string, { data: unknown; error: unknown } | Error, string]> = [
    ["unset", { data: null, error: null }, ""],
    ["unset, presented as the text null", { data: null, error: null }, "null"],
    ["shorter than the minimum, presented exactly", { data: short, error: null }, short],
    ["empty, presented empty", { data: "", error: null }, ""],
    ["lookup error", { data: SECRET, error: { message: "permission denied" } }, SECRET],
    ["lookup throws", new Error("network down"), SECRET],
    ["not text", { data: { secret: SECRET }, error: null }, SECRET],
  ];
  for (const [name, answer, presented] of cases) {
    const { load, lookups } = vault(answer);
    assert(!(await schedulerSecretMatches(presented, load)), name);
    assertEquals(lookups.count, 1, name);
  }
  // Exactly the minimum length is accepted.
  const minimum = "y".repeat(MIN_SCHEDULER_SECRET_LENGTH);
  assert(await schedulerSecretMatches(minimum, vault({ data: minimum, error: null }).load));
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
