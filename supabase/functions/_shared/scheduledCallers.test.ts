// Who may run fd-accrual and price-refresh, tested against the real handlers.
//
// Both are deployed with verify_jwt = true, so the platform rejects a request
// without a token signed by this project before either runs. These tests
// start after that point: every token here is one the platform would have
// let through, and the question is what the handler does with it. Only the
// network is fake.

import { assert, assertEquals } from "jsr:@std/assert@1";

// An unsigned token with the given claims: the handlers leave signatures to
// the platform's verify_jwt.
function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

const SUPABASE_URL = "http://supabase.test";
const MEMBER_USER = "33333333-3333-4333-8333-333333333333";
const STRANGER_USER = "44444444-4444-4444-8444-444444444444";

const SERVICE = fakeJwt({ role: "service_role", iss: "supabase" });
const ANON = fakeJwt({ role: "anon", iss: "supabase" });
const MEMBER = fakeJwt({ role: "authenticated", sub: MEMBER_USER, aud: "authenticated" });
const STRANGER = fakeJwt({ role: "authenticated", sub: STRANGER_USER, aud: "authenticated" });
// Tokens the Auth server recognises as signed-in users.
const USERS: Record<string, string> = { [MEMBER]: MEMBER_USER, [STRANGER]: STRANGER_USER };

let requests: string[] = [];

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
  if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/household_members") {
    const rows = url.searchParams.get("user_id") === `eq.${MEMBER_USER}` ? [{ id: "m1" }] : [];
    const wantsObject = (req.headers.get("Accept") ?? "").includes("vnd.pgrst.object");
    if (wantsObject) return rows.length === 1 ? json(rows[0]) : json({ code: "PGRST116", message: "no rows" }, 406);
    return json(rows);
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

function call(handler: Handler, method: string, token: string | null): Promise<Response> {
  requests = [];
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return handler(new Request("http://edge.test/fn", { method, headers, body: method === "POST" ? "{}" : undefined }));
}

function test(name: string, fn: () => Promise<void>): void {
  // The Supabase client keeps an auth refresh timer; not these tests' concern.
  Deno.test({ name, sanitizeOps: false, sanitizeResources: false, fn });
}

test("fd-accrual runs for the daily job's service-role token", async () => {
  const res = await call(fdAccrual, "POST", SERVICE);
  assertEquals(res.status, 200);
  assert(requests.some((r) => r.includes("/rest/v1/accounts")), "it never looked for FDs");
});

test("fd-accrual refuses everyone else and touches nothing", async () => {
  for (const token of [null, ANON, MEMBER, STRANGER, "not-a-jwt"]) {
    const res = await call(fdAccrual, "POST", token);
    assertEquals(res.status, 403, String(token));
    assertEquals(requests, [], `${token} reached the database`);
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

test("price-refresh runs for the weekday job without asking the Auth server", async () => {
  const res = await call(priceRefresh, "POST", SERVICE);
  assertEquals(res.status, 200);
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
});

test("price-refresh refuses no token, the anonymous role, and a login that belongs to no household", async () => {
  for (const token of [null, ANON, STRANGER, "not-a-jwt"]) {
    const res = await call(priceRefresh, "POST", token);
    assertEquals(res.status, 403, String(token));
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
    assert(!requests.some((r) => r.includes("open.er-api.com") || r.includes("fx_rates") || r.includes("holdings")), `${token} started a refresh`);
    await res.body?.cancel();
  }
});

test("price-refresh does nothing for a GET", async () => {
  const res = await call(priceRefresh, "GET", SERVICE);
  assertEquals(res.status, 405);
  assertEquals(requests, []);
  await res.body?.cancel();
});
