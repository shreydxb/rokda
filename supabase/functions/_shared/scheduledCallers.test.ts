// Who may run fd-accrual and price-refresh, tested against the real handlers.
//
// Both are deployed with verify_jwt = false: the nightly jobs send the vault's
// scheduler secret, not a JWT, so the platform lets every request through and
// the handlers alone decide. Only the network is fake, including the
// get_scheduler_secret RPC, whose answer each test sets.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { SCHEDULER_SECRET_HEADER } from "./requestAuth.ts";

// An unsigned token with the given claims. Nothing here trusts one: the
// handlers send a user token to the Auth server, which knows only USERS.
function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

const SUPABASE_URL = "http://supabase.test";
const MEMBER_USER = "33333333-3333-4333-8333-333333333333";
const STRANGER_USER = "44444444-4444-4444-8444-444444444444";

// The legacy service-role JWT the jobs used to send. Its claims say
// service_role, but no handler reads claims any more.
const SERVICE = fakeJwt({ role: "service_role", iss: "supabase" });
const ANON = fakeJwt({ role: "anon", iss: "supabase" });
const MEMBER = fakeJwt({ role: "authenticated", sub: MEMBER_USER, aud: "authenticated" });
const STRANGER = fakeJwt({ role: "authenticated", sub: STRANGER_USER, aud: "authenticated" });
// Tokens the Auth server recognises as signed-in users.
const USERS: Record<string, string> = { [MEMBER]: MEMBER_USER, [STRANGER]: STRANGER_USER };

// What the vault's scheduler_secret holds for the current test, as the
// get_scheduler_secret RPC returns it: a string, null when unset, or a
// database error.
const SCHEDULER_SECRET = "0123456789abcdef".repeat(4);
let vaultSecret: string | null | "error" = SCHEDULER_SECRET;

let requests: string[] = [];

// The holdings price-refresh reads, what Yahoo answers for them, and every
// update the run writes back. Empty unless a test sets them.
let feedHoldings: Record<string, unknown>[] = [];
let yahooMeta: Record<string, unknown> = {};
let holdingPatches: Record<string, unknown>[] = [];
// Each price the run writes through set_holding_price, and the filter each
// read of the holdings asked for.
let priceWrites: Record<string, unknown>[] = [];
let holdingFilters: (string | null)[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  requests.push(`${req.method} ${url.hostname}${url.pathname}`);
  if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/user") {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
    const id = USERS[token];
    return id ? json({ id, aud: "authenticated", role: "authenticated" }) : json({ code: 401, message: "invalid JWT" }, 401);
  }
  if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/rpc/get_scheduler_secret") {
    if (vaultSecret === "error") return json({ code: "42501", message: "permission denied for function get_scheduler_secret" }, 403);
    return json(vaultSecret);
  }
  if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/household_members") {
    const rows = url.searchParams.get("user_id") === `eq.${MEMBER_USER}` ? [{ id: "m1" }] : [];
    const wantsObject = (req.headers.get("Accept") ?? "").includes("vnd.pgrst.object");
    if (wantsObject) return rows.length === 1 ? json(rows[0]) : json({ code: "PGRST116", message: "no rows" }, 406);
    return json(rows);
  }
  if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/rpc/set_holding_price") {
    priceWrites.push(await req.json());
    return json(3672.5);
  }
  if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/holdings") {
    if (req.method === "GET") {
      holdingFilters.push(url.searchParams.get("or"));
      return json(feedHoldings);
    }
    holdingPatches.push(await req.json());
    return new Response(null, { status: 204 });
  }
  if (url.hostname === "query1.finance.yahoo.com") {
    return json({ chart: { result: [{ meta: { regularMarketPrice: 100, regularMarketChangePercent: 1.5, ...yahooMeta } }] } });
  }
  if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/")) {
    if (req.method === "GET") return json([]);
    return new Response(null, { status: 204 });
  }
  if (url.hostname === "open.er-api.com") return json({ rates: { INR: 24 } });
  return json({ message: `unmodelled request ${req.method} ${url}` }, 404);
}) as typeof fetch;

type Handler = (req: Request) => Promise<Response>;
let captured: Handler | undefined;
(Deno as unknown as { serve: unknown }).serve = (h: Handler) => {
  captured = h;
  return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
};

Deno.env.set("SUPABASE_URL", SUPABASE_URL);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-test");

function registered(name: string): Handler {
  const handler = captured;
  captured = undefined;
  if (!handler) throw new Error(`${name} did not register a handler with Deno.serve`);
  return handler;
}
await import("../fd-accrual/index.ts");
const fdAccrual = registered("fd-accrual");
await import("../price-refresh/index.ts");
const priceRefresh = registered("price-refresh");

// A request as the cron job or the browser would send it: `token` goes in the
// Authorization header, `secret` in the scheduler header.
function call(handler: Handler, method: string, token: string | null, secret: string | null = null): Promise<Response> {
  requests = [];
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (secret !== null) headers[SCHEDULER_SECRET_HEADER] = secret;
  return handler(new Request("http://edge.test/fn", { method, headers, body: method === "POST" ? "{}" : undefined }));
}

function test(name: string, fn: () => Promise<void>): void {
  // The Supabase client keeps an auth refresh timer; not these tests' concern.
  Deno.test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      vaultSecret = SCHEDULER_SECRET;
      feedHoldings = [];
      yahooMeta = {};
      holdingPatches = [];
      priceWrites = [];
      holdingFilters = [];
      await fn();
    },
  });
}

const LOOKUP = "POST supabase.test/rest/v1/rpc/get_scheduler_secret";
// Secrets that are not the vault's: one character off at either end, one
// short, one long, a different case, and empty.
const WRONG_SECRETS = [
  "",
  "x" + SCHEDULER_SECRET.slice(1),
  SCHEDULER_SECRET.slice(0, -1) + "x",
  SCHEDULER_SECRET.slice(0, -1),
  SCHEDULER_SECRET + "0",
  SCHEDULER_SECRET.toUpperCase(),
];

test("fd-accrual runs for the daily job's scheduler secret", async () => {
  const res = await call(fdAccrual, "POST", null, SCHEDULER_SECRET);
  assertEquals(res.status, 200);
  assertEquals(requests[0], LOOKUP);
  assert(requests.some((r) => r.includes("/rest/v1/accounts")), "it never looked for FDs");
  assert(!requests.some((r) => r.includes("/auth/v1/user")));
});

test("fd-accrual refuses every caller without the secret, and touches nothing", async () => {
  // The legacy service-role JWT included: its claims are no longer read.
  for (const token of [null, SERVICE, ANON, MEMBER, STRANGER, "not-a-jwt"]) {
    const res = await call(fdAccrual, "POST", token);
    assertEquals(res.status, 403, String(token));
    assertEquals(requests, [], `${token} reached the database`);
    await res.body?.cancel();
  }
});

test("fd-accrual refuses a wrong scheduler secret after only looking the real one up", async () => {
  for (const secret of WRONG_SECRETS) {
    const res = await call(fdAccrual, "POST", SERVICE, secret);
    assertEquals(res.status, 403, JSON.stringify(secret));
    assertEquals(requests, [LOOKUP], `${JSON.stringify(secret)} went past the check`);
    await res.body?.cancel();
  }
});

test("fd-accrual fails closed when the vault has no usable secret", async () => {
  // Unset: an empty or "null" header must not match a missing secret.
  for (const [vault, presented] of [[null, ""], [null, "null"], ["error", SCHEDULER_SECRET], ["short", "short"]] as const) {
    vaultSecret = vault;
    const res = await call(fdAccrual, "POST", null, presented);
    assertEquals(res.status, 403, `${vault} / ${presented}`);
    assertEquals(requests, [LOOKUP]);
    await res.body?.cancel();
  }
});

test("price-refresh answers the browser's preflight without refreshing anything", async () => {
  const res = await call(priceRefresh, "OPTIONS", null);
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert((res.headers.get("Access-Control-Allow-Headers") ?? "").includes("authorization"));
  assertEquals(requests, []);
});

test("price-refresh runs for the weekday job's scheduler secret without asking the Auth server", async () => {
  const res = await call(priceRefresh, "POST", null, SCHEDULER_SECRET);
  assertEquals(res.status, 200);
  assertEquals(requests[0], LOOKUP);
  assert(!requests.some((r) => r.includes("/auth/v1/user")));
  assert(requests.some((r) => r.startsWith("GET open.er-api.com")), "it never fetched the rate");
  await res.body?.cancel();
});

test("price-refresh runs for a signed-in household member, and the browser may read the answer", async () => {
  const res = await call(priceRefresh, "POST", MEMBER);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  const body = await res.json();
  assertEquals(body.fx.ok, true);
  assert(requests.some((r) => r.includes("/auth/v1/user")), "the token was not checked with the Auth server");
  assert(!requests.includes(LOOKUP), "a member's request looked up the scheduler secret");
});

test("price-refresh refuses no token, the old service-role token, the anonymous role, and a login that belongs to no household", async () => {
  for (const token of [null, SERVICE, ANON, STRANGER, "not-a-jwt"]) {
    const res = await call(priceRefresh, "POST", token);
    assertEquals(res.status, 403, String(token));
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
    assert(!requests.some((r) => r.includes("open.er-api.com") || r.includes("fx_rates") || r.includes("holdings")), `${token} started a refresh`);
    await res.body?.cancel();
  }
});

test("price-refresh refuses a wrong scheduler secret, even beside a member's login", async () => {
  for (const secret of WRONG_SECRETS) {
    const res = await call(priceRefresh, "POST", MEMBER, secret);
    assertEquals(res.status, 403, JSON.stringify(secret));
    assertEquals(requests, [LOOKUP], `${JSON.stringify(secret)} went past the check`);
    await res.body?.cancel();
  }
});

test("price-refresh fails closed when the vault has no usable secret", async () => {
  for (const [vault, presented] of [[null, ""], [null, "null"], ["error", SCHEDULER_SECRET], ["short", "short"]] as const) {
    vaultSecret = vault;
    const res = await call(priceRefresh, "POST", null, presented);
    assertEquals(res.status, 403, `${vault} / ${presented}`);
    assertEquals(requests, [LOOKUP]);
    await res.body?.cancel();
  }
});

test("price-refresh does nothing for a GET", async () => {
  const res = await call(priceRefresh, "GET", null, SCHEDULER_SECRET);
  assertEquals(res.status, 405);
  assertEquals(requests, []);
  await res.body?.cancel();
});

const RELIANCE = { id: "h1", currency: "INR", quantity: "10", price_symbol: "RELIANCE.NS", price_provider: "yahoo", price_fetch_fail_count: 0 };

test("price-refresh dates a price by the exchange's quote, and records when it fetched it", async () => {
  feedHoldings = [RELIANCE];
  const quoted = Date.parse("2026-10-09T10:00:00Z");
  yahooMeta = { regularMarketTime: quoted / 1000 };
  const before = Date.now();
  const res = await call(priceRefresh, "POST", null, SCHEDULER_SECRET);
  assertEquals(res.status, 200);
  await res.body?.cancel();
  // The value is worked in the database from the units at that moment
  // (set_holding_price), so the run sends the price and its times only.
  const [write] = priceWrites;
  assertEquals(write.p_holding_id, "h1");
  assertEquals(write.p_price, 100);
  assertEquals(write.p_quoted_at, "2026-10-09T10:00:00.000Z");
  assert(Date.parse(String(write.p_fetched_at)) >= before, "the fetch time is not this run's time");
  assertEquals(holdingPatches.filter((p) => "current_price" in p || "value_aed" in p), []);
});

test("price-refresh leaves priced_at alone when the provider gives no quote time", async () => {
  feedHoldings = [RELIANCE];
  const res = await call(priceRefresh, "POST", null, SCHEDULER_SECRET);
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const [write] = priceWrites;
  assertEquals(write.p_price, 100);
  assertEquals(write.p_quoted_at, null, "a price with no quote time was dated now");
  assert(typeof write.p_fetched_at === "string");
});

// A holding sold to zero is closed and needs no price (SHR-367).
// Only a holding its trades sold to zero is closed. One without trades whose
// units were set to zero by hand is still priced, so its value falls to zero
// rather than keeping the last one.
test("price-refresh skips only holdings their trades have closed", async () => {
  feedHoldings = [RELIANCE];
  const res = await call(priceRefresh, "POST", null, SCHEDULER_SECRET);
  await res.body?.cancel();
  assertEquals(holdingFilters, ["(quantity.is.null,quantity.gt.0,trades_version.eq.0)"]);
});
