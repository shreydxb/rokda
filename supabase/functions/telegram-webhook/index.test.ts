// Handler-level tests for the Telegram webhook (SHR-303).
//
// Everything else about the bot is unit-tested against the pure resolvers in
// _shared/applib, which is how several defects survived review: the resolver
// was right and the handler used it wrongly, or never reached it. These tests
// import the REAL index.ts and drive the handler that Deno.serve receives.
// Only the network is fake: every outbound request is answered by the
// in-memory backend below, which mirrors PostgREST, claim_telegram_update,
// Telegram and OpenRouter closely enough to exercise the production paths,
// and lets a test inject the faults a live system produces.
//
// What this does NOT prove: that Postgres enforces the claim atomically, or
// that the unique indexes exist. Those are proven against a real database in
// supabase/test/migration-behaviour.test.sql and scripts/verify-concurrency.sh.
// This file proves the handler reacts correctly to what the database says.

import { assert, assertEquals } from "jsr:@std/assert@1";

const SUPABASE_URL = "http://supabase.test";
const TOKEN = "123456:SYNTHETIC-TEST-TOKEN-not-real";
const SECRET = "test-webhook-secret";
const LEASE_MS = 3 * 60 * 1000;

const HOUSEHOLD = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";
const GOAL = "55555555-5555-4555-8555-555555555555";
const TELEGRAM_USER = 424242;

// ---------------------------------------------------------------------------
// The fake backend
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

type Backend = {
  now: number;
  tables: Record<string, Row[]>;
  log: Map<number, { status: string; claimed_at: number; attempts: number }>;
  telegramSent: Array<{ method: string; body: Row }>;
  requests: Array<{ method: string; path: string }>;
  faults: {
    // Make claim_telegram_update fail the way a live database can.
    claimError?: { code: string; message: string };
    // Make Telegram fail: on every call, or only the first N sendMessage calls.
    telegramDns?: boolean;
    failFirstSends?: number;
  };
  // What OpenRouter's router answers for a message: a tool name plus args.
  route?: { tool: string; args: Row };
};

let backend: Backend;
let sendCount = 0;

function reset(): void {
  sendCount = 0;
  backend = {
    now: Date.parse("2026-09-24T10:00:00Z"),
    tables: {
      household_members: [
        { id: MEMBER, household_id: HOUSEHOLD, display_name: "Tester", telegram_user_id: TELEGRAM_USER, role: "owner" },
      ],
      households: [{ id: HOUSEHOLD, name: "Test" }],
      intake: [],
      goals: [{ id: GOAL, household_id: HOUSEHOLD, name: "House" }],
      goal_contributions: [],
      categories: [],
      accounts: [],
      telegram_update_log: [],
      telegram_call_log: [],
    },
    log: new Map(),
    telegramSent: [],
    requests: [],
    faults: {},
  };
}

// Unique keys the real schema enforces, and the fake must too, or the tests
// would pass by the fake's permissiveness rather than the handler's care.
const UNIQUE: Record<string, string[]> = {
  intake: ["household_id", "source", "source_ref"],
  goal_contributions: ["goal_id", "source", "source_ref"],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function matches(row: Row, params: URLSearchParams): boolean {
  for (const [col, raw] of params) {
    if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(col)) continue;
    const negate = raw.startsWith("not.");
    const expr = negate ? raw.slice(4) : raw;
    const dot = expr.indexOf(".");
    const op = expr.slice(0, dot);
    const value = expr.slice(dot + 1);
    const cell = row[col];
    let ok: boolean;
    switch (op) {
      case "eq":
        ok = String(cell) === value;
        break;
      case "neq":
        ok = String(cell) !== value;
        break;
      case "is":
        ok = value === "null" ? cell == null : String(cell) === value;
        break;
      case "gt":
        ok = cell != null && String(cell) > value;
        break;
      case "gte":
        ok = cell != null && String(cell) >= value;
        break;
      case "lt":
        ok = cell != null && String(cell) < value;
        break;
      case "in":
        ok = value.replace(/^\(|\)$/g, "").split(",").includes(String(cell));
        break;
      default:
        // An operator this fake does not model filters nothing rather than
        // everything, so an unmodelled query can only over-return.
        ok = true;
    }
    if (negate ? ok : !ok) return false;
  }
  return true;
}

function violatesUnique(table: string, row: Row): boolean {
  const key = UNIQUE[table];
  if (!key || row.source_ref == null) return false;
  return backend.tables[table].some((r) => key.every((k) => r[k] === row[k]));
}

async function postgrest(req: Request, url: URL): Promise<Response> {
  const table = url.pathname.replace("/rest/v1/", "");
  const rows = (backend.tables[table] ??= []);
  const wantsObject = (req.headers.get("Accept") ?? "").includes("vnd.pgrst.object");
  const wantsRows = (req.headers.get("Prefer") ?? "").includes("return=representation");

  if (req.method === "GET") {
    let found = rows.filter((r) => matches(r, url.searchParams));
    const limit = url.searchParams.get("limit");
    if (limit) found = found.slice(0, Number(limit));
    if (wantsObject) {
      return found.length === 1 ? json(found[0]) : json({ code: "PGRST116", message: "not one row" }, 406);
    }
    return json(found);
  }

  if (req.method === "POST") {
    const body = await req.json();
    const incoming: Row[] = Array.isArray(body) ? body : [body];
    const written: Row[] = [];
    for (const r of incoming) {
      const row = { id: crypto.randomUUID(), created_at: new Date(backend.now).toISOString(), ...r };
      if (violatesUnique(table, row)) {
        return json({ code: "23505", message: "duplicate key value violates unique constraint" }, 409);
      }
      rows.push(row);
      written.push(row);
    }
    if (!wantsRows) return new Response(null, { status: 201 });
    return wantsObject ? json(written[0], 201) : json(written, 201);
  }

  if (req.method === "PATCH") {
    const patch = await req.json();
    // Claims live in backend.log, the same state claim() reads, so a test can
    // seed any claim state directly. Settling updates it by update_id.
    if (table === "telegram_update_log") {
      const id = Number((url.searchParams.get("update_id") ?? "").replace(/^eq\./, ""));
      const entry = backend.log.get(id);
      if (entry && typeof patch.status === "string") entry.status = patch.status;
      return new Response(null, { status: 204 });
    }
    const hit = rows.filter((r) => matches(r, url.searchParams));
    for (const r of hit) Object.assign(r, patch);
    if (!wantsRows) return new Response(null, { status: 204 });
    return wantsObject ? json(hit[0] ?? null) : json(hit);
  }

  if (req.method === "DELETE") {
    backend.tables[table] = rows.filter((r) => !matches(r, url.searchParams));
    return new Response(null, { status: 204 });
  }
  return json({ message: "unsupported" }, 405);
}

// Mirrors claim_telegram_update in the SHR-303 migration.
function claim(updateId: number): string {
  const existing = backend.log.get(updateId);
  if (!existing) {
    backend.log.set(updateId, { status: "processing", claimed_at: backend.now, attempts: 1 });
    return "claimed";
  }
  const stale = existing.status === "processing" && existing.claimed_at < backend.now - LEASE_MS;
  if (existing.status === "failed" || stale) {
    existing.status = "processing";
    existing.claimed_at = backend.now;
    existing.attempts += 1;
    return "claimed";
  }
  return existing.status === "completed" ? "completed" : "busy";
}

async function rpc(req: Request, fn: string): Promise<Response> {
  const args = await req.json().catch(() => ({}));
  if (fn === "get_telegram_webhook_secret") return json(SECRET);
  if (fn === "claim_telegram_update") {
    if (backend.faults.claimError) return json(backend.faults.claimError, 500);
    return json(claim(Number(args.p_update_id)));
  }
  return json(null);
}

// Deno's real fetch failure: a bland message, and a cause that quotes the URL
// -- including the bot token in its path. The token must not survive this.
function denoStyleFetchError(url: string): TypeError {
  return new TypeError("fetch failed", {
    cause: new Error(`error sending request for url (${url}): client error (Connect): dns error`),
  });
}

async function telegram(req: Request, url: URL): Promise<Response> {
  const method = url.pathname.split("/").pop() ?? "";
  if (backend.faults.telegramDns) throw denoStyleFetchError(url.toString());
  const body = await req.json().catch(() => ({}));
  if (method === "sendMessage") {
    sendCount += 1;
    if (backend.faults.failFirstSends && sendCount <= backend.faults.failFirstSends) {
      throw denoStyleFetchError(url.toString());
    }
    backend.telegramSent.push({ method, body });
    return json({ ok: true, result: { message_id: 1000 + sendCount } });
  }
  return json({ ok: true, result: {} });
}

async function openrouter(req: Request): Promise<Response> {
  const body = await req.json();
  // The router is the call that offers tools; parsing and phrasing do not.
  if (Array.isArray(body.tools) && backend.route) {
    return json({
      choices: [{
        message: {
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: backend.route.tool, arguments: JSON.stringify(backend.route.args) },
          }],
        },
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }
  return json({ choices: [{ message: { content: "Done." } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  backend.requests.push({ method: req.method, path: url.pathname });
  if (url.origin === SUPABASE_URL) {
    if (url.pathname.startsWith("/rest/v1/rpc/")) return await rpc(req, url.pathname.split("/").pop()!);
    if (url.pathname.startsWith("/rest/v1/")) return await postgrest(req, url);
    if (url.pathname.startsWith("/storage/")) return json({ Key: "ok" });
  }
  if (url.hostname === "api.telegram.org") return await telegram(req, url);
  if (url.hostname === "openrouter.ai") return await openrouter(req);
  return json({ message: `unmodelled request ${req.method} ${url}` }, 404);
}) as typeof fetch;

// Capture the handler instead of starting a server, and every line the
// handler logs, so a test can assert on exactly what would reach the logs.
let handler: (req: Request) => Promise<Response>;
(Deno as unknown as { serve: unknown }).serve = (h: typeof handler) => {
  handler = h;
  return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
};
const logged: string[] = [];
const realError = console.error;
console.error = (...args: unknown[]) => {
  logged.push(args.map(String).join(" "));
};

Deno.env.set("SUPABASE_URL", SUPABASE_URL);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-test");
Deno.env.set("TELEGRAM_BOT_TOKEN", TOKEN);
Deno.env.set("OPENROUTER_API_KEY", "openrouter-test");

reset();
await import("./index.ts");
assert(handler!, "index.ts did not register a handler with Deno.serve");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textUpdate(updateId: number, text: string): Request {
  return new Request("http://edge.test/telegram-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": SECRET },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: 1,
        date: 1,
        text,
        chat: { id: TELEGRAM_USER, type: "private" },
        from: { id: TELEGRAM_USER, is_bot: false, first_name: "T" },
      },
    }),
  });
}

function capturedIntake(): Row[] {
  return backend.tables.intake;
}

function assertNoTokenLeaked(): void {
  for (const line of logged) {
    assert(!line.includes(TOKEN), `bot token reached the log: ${line}`);
    assert(!line.includes("SYNTHETIC-TEST-TOKEN"), `part of the bot token reached the log: ${line}`);
  }
}

function freshTest(name: string, fn: () => Promise<void>): void {
  Deno.test({
    name,
    // The Supabase client keeps an auth refresh timer; not this test's concern.
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      reset();
      logged.length = 0;
      backend.route = { tool: "log_expense", args: {} };
      await fn();
    },
  });
}

// ---------------------------------------------------------------------------
// The acceptance cases
// ---------------------------------------------------------------------------

freshTest("an ordinary expense is captured once and its claim completed", async () => {
  const res = await handler(textUpdate(7001, "spent 40 on lunch"));
  assertEquals(res.status, 200);
  assertEquals(capturedIntake().length, 1);
  assertEquals(capturedIntake()[0].source_ref, "7001");
  assertEquals(backend.log.get(7001)?.status, "completed");
});

freshTest("a database error on the claim processes nothing and asks Telegram to retry", async () => {
  // Before SHR-303 any error that was not a duplicate key returned "not seen"
  // and processing carried on unlogged. A statement timeout must stop it.
  backend.faults.claimError = { code: "57014", message: "canceling statement due to statement timeout" };
  const res = await handler(textUpdate(7002, "spent 40 on lunch"));
  assertEquals(res.status, 503);
  assertEquals(capturedIntake().length, 0);
  assertEquals(backend.telegramSent.length, 0);
  assert(!backend.requests.some((r) => r.path === "/rest/v1/intake"), "the handler went on to touch intake");

  // The retry, once the database answers, is processed normally.
  backend.faults.claimError = undefined;
  const retry = await handler(textUpdate(7002, "spent 40 on lunch"));
  assertEquals(retry.status, 200);
  assertEquals(capturedIntake().length, 1);
});

freshTest("a completed update is answered 200 and not processed again", async () => {
  await handler(textUpdate(7003, "spent 40 on lunch"));
  const sentBefore = backend.telegramSent.length;
  const again = await handler(textUpdate(7003, "spent 40 on lunch"));
  assertEquals(again.status, 200);
  assertEquals(capturedIntake().length, 1);
  assertEquals(backend.telegramSent.length, sentBefore, "a completed update replied again");
});

freshTest("an update still being processed is answered non-200, not treated as done", async () => {
  // The state a live run leaves. Answering 200 here would tell Telegram the
  // update was delivered, and if that run then failed, nothing would retry.
  backend.log.set(7004, { status: "processing", claimed_at: backend.now - 10_000, attempts: 1 });
  const res = await handler(textUpdate(7004, "spent 40 on lunch"));
  assertEquals(res.status, 503);
  assertEquals(capturedIntake().length, 0);
});

freshTest("a crash between claim and capture is recovered on redelivery, not lost", async () => {
  // A run that was claimed and then killed -- no handler code ran, so nothing
  // settled the claim -- leaves exactly this behind. Before SHR-303 the
  // redelivery was dropped as already handled and the expense vanished.
  backend.log.set(7005, { status: "processing", claimed_at: backend.now - LEASE_MS - 1_000, attempts: 1 });
  const res = await handler(textUpdate(7005, "spent 40 on lunch"));
  assertEquals(res.status, 200);
  assertEquals(capturedIntake().length, 1, "the abandoned update was not captured on redelivery");
  assertEquals(backend.log.get(7005)?.attempts, 2);
  assertEquals(backend.log.get(7005)?.status, "completed");
});

freshTest("a failure after capture releases the claim, and the retry does not duplicate", async () => {
  // Telegram is unreachable for the confirmation reply, after the expense is
  // already captured. The handler must release the claim and answer 500 so
  // the retry runs -- and intake's own delivery key must make that retry
  // harmless.
  backend.faults.failFirstSends = 1;
  const first = await handler(textUpdate(7006, "spent 40 on lunch"));
  assertEquals(first.status, 500);
  assertEquals(backend.log.get(7006)?.status, "failed");
  assertEquals(capturedIntake().length, 1);

  const retry = await handler(textUpdate(7006, "spent 40 on lunch"));
  assertEquals(retry.status, 200);
  assertEquals(capturedIntake().length, 1, "the retry captured the expense a second time");
  assertEquals(backend.log.get(7006)?.status, "completed");
  // The first run's acknowledgement never arrived, so the retry must say so
  // rather than succeed silently.
  assertEquals(backend.telegramSent.length, 1, "the member was never told it was recorded");
  assert(String(backend.telegramSent[0].body.text).includes("Inbox"));
});

freshTest("concurrent deliveries of one update capture it once", async () => {
  // In-process only: this proves the handler honours the claim's answer. That
  // Postgres gives exactly one caller 'claimed' is proven separately, with two
  // real sessions, in scripts/verify-concurrency.sh.
  const [a, b] = await Promise.all([
    handler(textUpdate(7007, "spent 40 on lunch")),
    handler(textUpdate(7007, "spent 40 on lunch")),
  ]);
  assertEquals([a.status, b.status].sort(), [200, 503]);
  assertEquals(capturedIntake().length, 1);
});

freshTest("a redelivered goal contribution is recorded once", async () => {
  // The one side effect that had no delivery key. The contribution is written,
  // then the reply fails, so the update is released and re-run in full.
  backend.route = { tool: "log_goal_contribution", args: { goal_name: "House", amount: 500 } };
  backend.faults.failFirstSends = 1;
  const first = await handler(textUpdate(7008, "put 500 toward the house goal"));
  // Before this fix the reply failure fell through to intake capture: 200,
  // one contribution AND one pending expense for the same 500.
  assertEquals(first.status, 500);
  assertEquals(backend.tables.goal_contributions.length, 1);
  assertEquals(capturedIntake().length, 0, "a goal contribution was also captured as an expense");

  const retry = await handler(textUpdate(7008, "put 500 toward the house goal"));
  assertEquals(retry.status, 200);
  assertEquals(backend.tables.goal_contributions.length, 1, "the redelivery recorded a second contribution");
  assertEquals(backend.tables.goal_contributions[0].source_ref, "7008");
  assertEquals(capturedIntake().length, 0, "the retry captured the contribution as an expense");
  // The redelivery's 23505 is the same outcome as the first write, so the
  // member is told it worked rather than that it failed.
  assert(!backend.telegramSent.some((m) => String(m.body.text).includes("couldn")), "the retry reported a failure");
});

freshTest("a DNS failure reaching Telegram never puts the bot token in the logs", async () => {
  // Reproduces the audited leak: Deno's fetch error quotes the URL in its
  // cause, and the URL carries the token.
  backend.faults.telegramDns = true;
  const res = await handler(textUpdate(7009, "spent 40 on lunch"));
  assertEquals(res.status, 500);
  assert(logged.length > 0, "a handler failure was not logged at all");
  assertNoTokenLeaked();

  // Metadata only: a parseable event naming where and which update, with the
  // error's class and nothing that could quote a URL, a row or a message.
  const event = JSON.parse(logged[logged.length - 1]);
  assertEquals(event.event, "telegram_webhook_failure");
  assertEquals(event.update_id, 7009);
  assertEquals(Object.keys(event).sort(), ["error", "event", "update_id", "where"]);
  assert(!JSON.stringify(event).includes("lunch"), "the member's message reached the log");
});

freshTest("a failure outside update processing is caught by the last line of defence", async () => {
  // ?setup=1 registers the webhook with Telegram, outside any update and so
  // outside processUpdate's wrapper. Before SHR-303 nothing caught a failure
  // here: the exception reached the runtime, which printed its cause chain,
  // bot token included.
  backend.faults.telegramDns = true;
  const res = await handler(new Request("http://edge.test/telegram-webhook?setup=1", {
    method: "GET",
    headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET },
  }));
  assertEquals(res.status, 500);
  assertNoTokenLeaked();
  const event = JSON.parse(logged[logged.length - 1]);
  assertEquals(event.where, "request");
  assertEquals(event.update_id, null);
});

// Restore globals for anything that runs after this module.
addEventListener("unload", () => {
  globalThis.fetch = realFetch;
  console.error = realError;
});
