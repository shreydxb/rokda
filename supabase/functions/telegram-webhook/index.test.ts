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
  telegramDeleted: number[];
  requests: Array<{ method: string; path: string }>;
  faults: {
    // Make claim_telegram_update fail the way a live database can.
    claimError?: { code: string; message: string };
    // Make Telegram fail: on every call, or only the first N sendMessage calls.
    telegramDns?: boolean;
    failFirstSends?: number;
    // Telegram answers ok:false (a 429, say): nothing is sent, nothing thrown.
    refuseFirstSends?: number;
    // The write recording a proposal question's message id fails this many times.
    failPromptRecord?: number;
    // Reading bot_proposals fails.
    failProposalReads?: boolean;
  };
  // What OpenRouter's router answers for a message: a tool name plus args.
  route?: { tool: string; args: Row };
  // What the parser extracts from a message; unset, it answers prose, which
  // the handler treats as a failed parse.
  parse?: Row[];
  parsePrompts: string[];
  applyCalls: number;
  approveCalls: number;
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
      bot_proposals: [],
    },
    log: new Map(),
    telegramSent: [],
    telegramDeleted: [],
    requests: [],
    faults: {},
    parsePrompts: [],
    applyCalls: 0,
    approveCalls: 0,
  };
}

// Unique keys the real schema enforces, and the fake must too, or the tests
// would pass by the fake's permissiveness rather than the handler's care.
const UNIQUE: Record<string, string[]> = {
  intake: ["household_id", "source", "source_ref"],
  goal_contributions: ["goal_id", "source", "source_ref"],
  bot_proposals: ["household_id", "source_ref"],
};

// Column defaults the real schema fills in. A proposal's times are on the
// real clock, because the handler compares them with Date.now().
const DEFAULTS: Record<string, () => Row> = {
  bot_proposals: () => ({
    status: "proposed",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    prompt_message_id: null,
    decided_at: null,
    result: null,
  }),
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
    if (table === "bot_proposals" && backend.faults.failProposalReads) {
      return json({ code: "57014", message: "canceling statement due to statement timeout" }, 500);
    }
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
      const row = { id: crypto.randomUUID(), created_at: new Date(backend.now).toISOString(), ...(DEFAULTS[table]?.() ?? {}), ...r };
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
    if (table === "bot_proposals" && "prompt_message_id" in patch && backend.faults.failPromptRecord) {
      backend.faults.failPromptRecord -= 1;
      return json({ code: "57014", message: "canceling statement due to statement timeout" }, 500);
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

// Mirrors apply_bot_proposal in the bot_proposals migration closely enough
// for the handler's side of it. The function itself -- one transaction, the
// row lock, refusing another household's ids -- is proven against Postgres in
// migration-behaviour.test.sql and scripts/verify-concurrency.sh.
function applyProposal(id: string, memberId: string): Row {
  const p = backend.tables.bot_proposals.find((r) => r.id === id);
  if (!p) return { outcome: "not_found" };
  if (p.member_id !== memberId) return { outcome: "not_yours" };
  if (p.status !== "proposed") return { outcome: p.status, result: p.result };
  const payload = p.payload as Row;
  const applied: Row[] = [];
  const skipped: Row[] = [];
  if (p.kind === "account_balances") {
    for (const item of (payload.items as Row[]) ?? []) {
      const a = backend.tables.accounts.find((x) => x.id === item.account_id && x.household_id === p.household_id && x.archived_at == null);
      if (!a) {
        skipped.push({ name: item.name, reason: "unavailable" });
        continue;
      }
      if (Number(a.balance) !== Number(item.old_balance)) {
        skipped.push({ name: a.name, type: a.type, currency: a.currency, reason: "changed", balance: a.balance });
        continue;
      }
      applied.push({ name: a.name, type: a.type, currency: a.currency, old_balance: a.balance, new_balance: item.new_balance });
      a.balance = item.new_balance;
      a.balance_as_of = new Date(backend.now).toISOString();
    }
  } else {
    const goal = backend.tables.goals.find((g) => g.id === payload.goal_id && g.household_id === p.household_id);
    if (!goal) {
      skipped.push({ reason: "unavailable" });
    } else {
      const row = { goal_id: goal.id, amount: payload.amount, occurred_at: payload.occurred_at, source: "telegram", source_ref: p.source_ref ?? p.id };
      const already = violatesUnique("goal_contributions", row);
      if (!already) backend.tables.goal_contributions.push({ id: crypto.randomUUID(), ...row });
      applied.push({ name: goal.name, amount: payload.amount, occurred_at: payload.occurred_at, already_recorded: already });
    }
  }
  const result = { kind: p.kind, applied, skipped };
  // The real clock, like the table's defaults: the handler compares it with Date.now().
  Object.assign(p, { status: "applied", decided_at: new Date().toISOString(), result });
  return { outcome: "applied", ...result };
}

async function rpc(req: Request, fn: string): Promise<Response> {
  const args = await req.json().catch(() => ({}));
  if (fn === "get_telegram_webhook_secret") return json(SECRET);
  if (fn === "apply_bot_proposal") {
    backend.applyCalls += 1;
    return json(applyProposal(String(args.p_proposal_id), String(args.p_member_id)));
  }
  if (fn === "approve_intake") backend.approveCalls += 1;
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
    if (backend.faults.refuseFirstSends && sendCount <= backend.faults.refuseFirstSends) {
      return json({ ok: false, error_code: 429, description: "Too Many Requests: retry after 5" });
    }
    backend.telegramSent.push({ method, body });
    return json({ ok: true, result: { message_id: 1000 + sendCount } });
  }
  if (method === "deleteMessage") backend.telegramDeleted.push(Number(body.message_id));
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
  const text = JSON.stringify(body.messages ?? []);
  if (text.includes("Extract ALL")) {
    backend.parsePrompts.push(text);
    if (backend.parse) {
      return json({ choices: [{ message: { content: JSON.stringify({ items: backend.parse }) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
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
const { accountsForCheckin, buildBalanceCheckinMessage, datedItems, forwardedDay, merchantHistoryMatches, pickAccountByHint, pickCheckinAccount, undatedNote } = await import("./index.ts");
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

// A message sent as a Telegram reply to one of the bot's messages.
function replyUpdate(updateId: number, text: string, replyTo: number): Request {
  return new Request("http://edge.test/telegram-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": SECRET },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: 2,
        date: 1,
        text,
        reply_to_message: { message_id: replyTo },
        chat: { id: TELEGRAM_USER, type: "private" },
        from: { id: TELEGRAM_USER, is_bot: false, first_name: "T" },
      },
    }),
  });
}

// A reaction placed on one of the bot's messages.
function reactionUpdate(updateId: number, messageId: number, emoji: string): Request {
  return new Request("http://edge.test/telegram-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": SECRET },
    body: JSON.stringify({
      update_id: updateId,
      message_reaction: {
        chat: { id: TELEGRAM_USER, type: "private" },
        user: { id: TELEGRAM_USER, is_bot: false, first_name: "T" },
        message_id: messageId,
        date: 1,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji }],
      },
    }),
  });
}

function capturedIntake(): Row[] {
  return backend.tables.intake;
}

function lastReply(): string {
  return String(backend.telegramSent.at(-1)?.body.text ?? "");
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

freshTest("a goal contribution is proposed once however often it is delivered, and recorded once on a yes", async () => {
  // The question fails to send, so the update is released and re-run in full.
  backend.route = { tool: "log_goal_contribution", args: { goal_name: "House", amount: 500 } };
  backend.faults.failFirstSends = 1;
  const first = await handler(textUpdate(7008, "put 500 toward the house goal"));
  assertEquals(first.status, 500);
  // The question never arrived, so nothing is left for a later "yes" to apply.
  assertEquals(backend.tables.bot_proposals.length, 0, "a proposal nobody was asked about was kept");
  assertEquals(backend.tables.goal_contributions.length, 0, "a contribution was recorded before anyone said yes");
  assertEquals(capturedIntake().length, 0, "a goal contribution was also captured as an expense");

  const retry = await handler(textUpdate(7008, "put 500 toward the house goal"));
  assertEquals(retry.status, 200);
  assertEquals(backend.tables.bot_proposals.length, 1, "the redelivery proposed it a second time");
  assertEquals(backend.tables.goal_contributions.length, 0);
  assert(lastReply().includes("Record AED 500.00 toward House"), lastReply());
  const prompt = backend.tables.bot_proposals[0].prompt_message_id as number;
  assert(prompt, "the question was not tied to the proposal");

  await handler(replyUpdate(7009, "yes", prompt));
  assertEquals(backend.tables.goal_contributions.length, 1);
  assertEquals(backend.tables.goal_contributions[0].source_ref, "7008");
  assert(lastReply().startsWith("Recorded: AED 500.00 toward House"), lastReply());

  // A second yes repeats the answer and records nothing.
  await handler(replyUpdate(7010, "yes", prompt));
  assertEquals(backend.tables.goal_contributions.length, 1, "a second yes recorded it again");
  assert(lastReply().startsWith("Already recorded"), lastReply());
  assertEquals(capturedIntake().length, 0, "a yes was captured as an expense");
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

freshTest("a request without the exact secret is refused before anything else happens", async () => {
  // The secret is compared in constant time now; this pins that the compare
  // still refuses everything that is not the secret, including a value that
  // differs only in its last character and one that is the secret plus more.
  const near = SECRET.slice(0, -1) + (SECRET.endsWith("t") ? "u" : "t");
  for (const presented of [null, "", near, SECRET + "x", SECRET.toUpperCase()]) {
    backend.requests.length = 0;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (presented !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = presented;
    const res = await handler(new Request("http://edge.test/telegram-webhook", {
      method: "POST",
      headers,
      body: JSON.stringify({ update_id: 1, message: { message_id: 1, date: 1, text: "coffee 10", chat: { id: TELEGRAM_USER, type: "private" }, from: { id: TELEGRAM_USER, is_bot: false, first_name: "T" } } }),
    }));
    assertEquals(res.status, 401, `presented ${JSON.stringify(presented)}`);
    // Only the secret lookup itself: no claim, no capture, no reply.
    assertEquals(backend.requests.map((r) => r.path), ["/rest/v1/rpc/get_telegram_webhook_secret"]);
  }
  assertEquals(capturedIntake().length, 0);
  assertEquals(backend.telegramSent.length, 0);

  const ok = await handler(textUpdate(2, "hello"));
  assertEquals(ok.status, 200);
});

// ---------------------------------------------------------------------------
// Naming a card, and a router that names a tool the bot does not have
// ---------------------------------------------------------------------------

const MARRIOTT = { id: "66666666-6666-4666-8666-666666666666", household_id: HOUSEHOLD, name: "ENBD Marriott •0001", archived_at: null };
const NOON = { id: "77777777-7777-4777-8777-777777777777", household_id: HOUSEHOLD, name: "ENBD Noon •0002", archived_at: null };
const FAB_Z = { id: "88888888-8888-4888-8888-888888888888", household_id: HOUSEHOLD, name: "FAB Z •0003", archived_at: null };
const FAB = { id: "99999999-9999-4999-8999-999999999999", household_id: HOUSEHOLD, name: "FAB", archived_at: null };

Deno.test("a card named misspelt, shortened or with filler words still resolves to the one card it means", () => {
  const accounts = [MARRIOTT, NOON, FAB_Z, FAB];
  for (const hint of ["marriot", "Marriott", "ENBD Marriot", "marriot card", "my marriott credit card", "Mariott"]) {
    assertEquals(pickAccountByHint(accounts, hint)?.name, "ENBD Marriott •0001", hint);
  }
  assertEquals(pickAccountByHint(accounts, "noon")?.name, "ENBD Noon •0002");
  assertEquals(pickAccountByHint(accounts, "fab z card")?.name, "FAB Z •0003");
  // A name two accounts share, or a bank's name alone, abstains.
  assertEquals(pickAccountByHint(accounts, "enbd"), null);
  assertEquals(pickAccountByHint(accounts, "fab"), null);
  // Nothing close enough is not a guess.
  assertEquals(pickAccountByHint(accounts, "wio"), null);
  assertEquals(pickAccountByHint(accounts, "card"), null);
});

freshTest("an expense on a card named misspelt is filed to that card", async () => {
  backend.tables.accounts.push(MARRIOTT, NOON);
  backend.parse = [{ merchant: "Dewa", amount: 504, currency: null, occurred_at: "2026-09-24", category: null, card_last4: null, account_hint: "marriot", confidence: 1, kind: "expense" }];
  await handler(textUpdate(7101, "Dewa 504 marriot"));
  assertEquals(capturedIntake().length, 1);
  assertEquals(capturedIntake()[0].parsed_account_id, MARRIOTT.id);
  // The parser is told the household's own card names to choose from.
  assert(backend.parsePrompts[0].includes("ENBD Marriott"), "the parser was not given the account names");
  assert(!backend.parsePrompts[0].includes("0001"), "the card digits reached the parser as part of a name");
  // Noon's three services each have their own category.
  assert(backend.parsePrompts[0].includes("plain \\\"Noon\\\" on its own is Noon Food"), "the parser was not told how to tell Noon's services apart");
});

freshTest("a tool the bot does not have is captured as an expense, not answered with an error", async () => {
  backend.route = { tool: "log_expenses", args: {} };
  const res = await handler(textUpdate(7102, "spent 40 on lunch"));
  assertEquals(res.status, 200);
  assertEquals(capturedIntake().length, 1);
  const replies = backend.telegramSent.map((m) => String(m.body.text ?? ""));
  assert(!replies.some((t) => t.includes("unknown_tool")), `the member was told: ${replies.join(" | ")}`);
});

freshTest("a correction with nothing pending is captured as a new entry", async () => {
  backend.route = { tool: "update_last_expense", args: {} };
  await handler(textUpdate(7103, "actually 45"));
  assertEquals(capturedIntake().length, 1);
});

Deno.test("a bank SMS or receipt with no date is dated when it was sent, and marked a guess", () => {
  const base = { merchant: "Cafe", amount: 20, currency: null, categoryName: null, cardLast4: null, accountHint: null, confidence: 1, kind: "expense" as const };
  const [stated, typed, sms, receipt] = datedItems(
    [
      { ...base, occurred_at: "2026-09-20", dateStated: true, source: "bank_sms" },
      { ...base, occurred_at: null, dateStated: false, source: "typed" },
      { ...base, occurred_at: null, dateStated: false, source: "bank_sms" },
      { ...base, occurred_at: "2026-09-29", dateStated: false, source: "receipt" },
    ],
    "2026-09-29",
    "2026-09-27",
  );
  // A written date stands.
  assertEquals([stated.occurred_at, stated.dateGuessed], ["2026-09-20", false]);
  // "12 coffee" typed now is today, as it always was.
  assertEquals([typed.occurred_at, typed.dateGuessed], ["2026-09-29", false]);
  // Pasted later: the day it was forwarded, and flagged.
  assertEquals([sms.occurred_at, sms.dateGuessed], ["2026-09-27", true]);
  // A date the model filled in itself is not trusted either.
  assertEquals([receipt.occurred_at, receipt.dateGuessed], ["2026-09-27", true]);
  // Not forwarded: today, still flagged.
  assertEquals(datedItems([{ ...base, occurred_at: null, dateStated: false, source: "bank_sms" }], "2026-09-29")[0].occurred_at, "2026-09-29");
});

Deno.test("a forwarded message's day is read in Dubai time, from either field Telegram uses", () => {
  // 21:30 UTC on 27 Sep is already 28 Sep in Dubai.
  const late = Date.UTC(2026, 8, 27, 21, 30) / 1000;
  assertEquals(forwardedDay({ forward_origin: { type: "user", date: late } }), "2026-09-28");
  assertEquals(forwardedDay({ forward_date: late }), "2026-09-28");
  assertEquals(forwardedDay({ text: "hi" }), null);
  assertEquals(forwardedDay(undefined), null);
});

Deno.test("the capture reply says which entries had no date", () => {
  assertEquals(undatedNote([], 3), "");
  assert(undatedNote(["2026-09-29"], 1).includes("It had no date, so it's put on 2026-09-29"));
  assert(undatedNote(["2026-09-29", "2026-09-29"], 2).startsWith(" None had a date"));
  assert(undatedNote(["2026-09-29"], 3).startsWith(" 1 had no date, so those are put on 2026-09-29"));
});

freshTest("a pasted SMS with no date waits in the Inbox instead of being offered a yes", async () => {
  backend.tables.accounts.push(MARRIOTT, NOON);
  backend.tables.categories.push({ id: "cat-dining", household_id: HOUSEHOLD, name: "Dining Out", archived: false, is_savings: false });
  backend.parse = [{ merchant: "Noon", amount: 42, currency: "AED", occurred_at: "2026-09-24", date_stated: false, source: "bank_sms", category: "Dining Out", card_last4: null, account_hint: "ENBD Noon", confidence: 1, kind: "expense" }];
  await handler(textUpdate(7104, "AED 42.00 spent at NOON on your card"));
  const [row] = capturedIntake();
  assertEquals(row.date_guessed, true);
  // The model's own date is not trusted when it says none was written: the
  // entry is dated the day it was sent (not forwarded here, so today).
  assert(row.parsed_date !== "2026-09-24" && /^\d{4}-\d{2}-\d{2}$/.test(String(row.parsed_date)), `dated ${row.parsed_date}`);
  const replies = backend.telegramSent.map((m) => String(m.body.text ?? ""));
  assert(!replies.some((t) => t.includes('reply "yes"')), `a guessed date was offered for a yes: ${replies.join(" | ")}`);
  assert(replies.some((t) => t.includes("It had no date")), `the reply did not say the date was missing: ${replies.join(" | ")}`);
  // The parser is told not to invent a date.
  assert(backend.parsePrompts[0].includes("never fill in today's date yourself"), "the parser was not told to leave a missing date empty");
});

Deno.test("a brand does not inherit the category of its own sub-service", () => {
  // Plain "Noon" is the marketplace; "Noon Minutes" is grocery delivery.
  assertEquals(merchantHistoryMatches("Noon", "Noon Minutes"), false);
  assertEquals(merchantHistoryMatches("Careem", "Careem Food"), false);
  // The same merchant, however it was capitalised, still matches.
  assertEquals(merchantHistoryMatches("noon", "Noon"), true);
  assertEquals(merchantHistoryMatches("Noon Minutes", "NOON MINUTES"), true);
  // A shortened name still inherits from the fuller one it came from.
  assertEquals(merchantHistoryMatches("Alseer", "Moisturiser Alseer"), true);
  assertEquals(merchantHistoryMatches("Filli", "Filli Cafe LLC"), false);
  assertEquals(merchantHistoryMatches("Burger King", "Burger King Al Barsha"), false);
  assertEquals(merchantHistoryMatches("Mall of the Emirates", "BRED Mall of the Emirates"), true);
});

// ---------------------------------------------------------------------------
// The monthly balance check-in
// ---------------------------------------------------------------------------

const PARTNER = "33333333-3333-4333-8333-333333333333";
const ROSTER = [
  { id: MEMBER, display_name: "Alex", telegram_user_id: TELEGRAM_USER },
  { id: PARTNER, display_name: "Sam", telegram_user_id: null },
];
const acct = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, household_id: HOUSEHOLD, name, type: "checking", currency: "AED", balance: 0, balance_as_of: null, owner_member_id: MEMBER, is_shared: false, archived_at: null, ...over,
});
const MY_BANK = acct("a0000000-0000-4000-8000-000000000001", "Bank");
const SAM_BANK = acct("a0000000-0000-4000-8000-000000000002", "Bank", { owner_member_id: PARTNER });
const CARD = acct("a0000000-0000-4000-8000-000000000003", "Card •0004", { type: "credit_card" });
const EPF = acct("a0000000-0000-4000-8000-000000000004", "EPF", { type: "investment", currency: "INR" });
const FD = acct("a0000000-0000-4000-8000-000000000005", "Term deposit", { type: "fd" });
const MY_CURRENT = acct("a0000000-0000-4000-8000-000000000006", "Alex Current");

Deno.test("the check-in covers shared accounts, the member's own, and those of a member with no Telegram, never an FD", () => {
  const theirs = accountsForCheckin([MY_BANK, SAM_BANK, CARD, EPF, FD], ROSTER, MEMBER).map((a) => a.id);
  assertEquals(theirs, [MY_BANK.id, SAM_BANK.id, CARD.id, EPF.id]);
});

Deno.test("the check-in message lists each account with whose it is, what is on record, and how to reply", () => {
  const text = buildBalanceCheckinMessage([MY_BANK, { ...SAM_BANK, balance: 5000, balance_as_of: "2026-09-01T08:00:00Z" }, { ...CARD, balance: 1000 }, { ...EPF, balance: 300000 }], ROSTER, "September 2026");
  assert(text.startsWith("Month-end check-in for September 2026."), text);
  assert(text.includes("• Bank (Alex): AED 0.00, never confirmed"), text);
  assert(text.includes("• Bank (Sam): AED 5,000.00, confirmed 2026-09-01"), text);
  assert(text.includes("• Card •0004 (Alex): AED 1,000.00 owed"), text);
  assert(text.includes("• EPF (Alex): INR 3,00,000.00"), text);
  // The example names a member of this household, and says nothing is saved unasked.
  assert(text.includes("Sam bank 5,000"), text);
  assert(text.includes("before saving them"), text);
});

Deno.test("a balance confirmed just after midnight in Dubai shows Dubai's date in the check-in", () => {
  // 01:30 on 16 Sep in Dubai is 21:30 on 15 Sep in UTC, which is how the database returns it.
  const late = buildBalanceCheckinMessage([acct("a0000000-0000-4000-8000-000000000007", "Bank", { is_shared: true, balance: 100, balance_as_of: "2026-09-15T21:30:00+00:00" })], ROSTER, "September 2026");
  assert(late.includes("confirmed 2026-09-16"), late);
  // A day picked in the account editor is stored as UTC midnight of that day, and keeps it.
  const picked = buildBalanceCheckinMessage([acct("a0000000-0000-4000-8000-000000000008", "Bank", { is_shared: true, balance: 100, balance_as_of: "2026-09-01T00:00:00+00:00" })], ROSTER, "September 2026");
  assert(picked.includes("confirmed 2026-09-01"), picked);
});

Deno.test("a balance names its account the way a person says it", () => {
  const accounts = [MY_BANK, SAM_BANK, CARD, EPF, MY_CURRENT];
  // Two accounts called Bank: the sender's own, unless someone else is named.
  assertEquals(pickCheckinAccount(accounts, ROSTER, MEMBER, "Bank")?.id, MY_BANK.id);
  assertEquals(pickCheckinAccount(accounts, ROSTER, MEMBER, "Sam bank")?.id, SAM_BANK.id);
  assertEquals(pickCheckinAccount(accounts, ROSTER, MEMBER, "Sam's bank")?.id, SAM_BANK.id);
  assertEquals(pickCheckinAccount(accounts, ROSTER, MEMBER, "Alex current")?.id, MY_CURRENT.id);
  assertEquals(pickCheckinAccount(accounts, ROSTER, MEMBER, "card")?.id, CARD.id);
  assertEquals(pickCheckinAccount(accounts, ROSTER, MEMBER, "Sam card"), null);
  assertEquals(pickCheckinAccount(accounts, ROSTER, MEMBER, "ADCB"), null);
});

function seedCheckinHousehold(): void {
  backend.tables.household_members[0].display_name = "Alex";
  backend.tables.household_members.push({ id: PARTNER, household_id: HOUSEHOLD, display_name: "Sam", telegram_user_id: null, role: "member" });
  backend.tables.accounts.push({ ...MY_BANK }, { ...SAM_BANK }, { ...CARD }, { ...EPF });
}

function balancesOf(): Map<unknown, number> {
  return new Map(backend.tables.accounts.map((a) => [a.id, Number(a.balance)]));
}

freshTest("balances read from a message are only proposed, and a yes to that message saves them", async () => {
  seedCheckinHousehold();
  backend.route = {
    tool: "update_account_balances",
    args: { balances: [{ account: "Bank", balance: 10000 }, { account: "Sam bank", balance: 5000 }, { account: "Card", balance: -1000 }, { account: "EPF", balance: 300000 }, { account: "ADCB", balance: 10 }] },
  };
  await handler(textUpdate(7201, "Bank 10,000 · Sam bank 5,000 · Card 1,000 owed · EPF 3,00,000 · ADCB 10"));

  // Nothing is written yet; the question shows every change.
  for (const balance of balancesOf().values()) assertEquals(balance, 0);
  assertEquals(backend.applyCalls, 0);
  const question = lastReply();
  assert(question.includes("Nothing changes until you say yes"), question);
  assert(question.includes("• Bank: AED 0.00 → AED 10,000.00"), question);
  assert(question.includes("• Card •0004: AED 0.00 owed → AED 1,000.00 owed"), question);
  assert(question.includes(`"ADCB"`), question);
  assertEquals(backend.tables.bot_proposals.length, 1);
  assertEquals((backend.tables.bot_proposals[0].payload as { items: unknown[] }).items.length, 4);
  // A balance is not an expense.
  assertEquals(capturedIntake().length, 0);

  const prompt = backend.tables.bot_proposals[0].prompt_message_id as number;
  await handler(replyUpdate(7202, "yes", prompt));
  const after = balancesOf();
  assertEquals(after.get(MY_BANK.id), 10000);
  assertEquals(after.get(SAM_BANK.id), 5000);
  assertEquals(after.get(CARD.id), 1000);
  assertEquals(after.get(EPF.id), 300000);
  assert(backend.tables.accounts.find((a) => a.id === MY_BANK.id)!.balance_as_of, "the balance was not marked confirmed");
  assert(lastReply().startsWith("Saved, confirmed today:"), lastReply());
  assert(lastReply().includes("✓ Bank: AED 0.00 → AED 10,000.00"), lastReply());

  // A second yes changes nothing and says it was already saved.
  await handler(replyUpdate(7203, "yes", prompt));
  assert(lastReply().startsWith("Already saved"), lastReply());
  assertEquals(balancesOf().get(MY_BANK.id), 10000);
  assertEquals(capturedIntake().length, 0, "a yes was captured as an expense");
});

freshTest("a no drops a proposed balance, and a thumbs-up on the question saves one", async () => {
  seedCheckinHousehold();
  backend.route = { tool: "update_account_balances", args: { balances: [{ account: "Bank", balance: 10000 }] } };
  await handler(textUpdate(7211, "Bank 10,000"));
  const dropped = backend.tables.bot_proposals[0];
  await handler(replyUpdate(7212, "no", dropped.prompt_message_id as number));
  assertEquals(dropped.status, "cancelled");
  assertEquals(balancesOf().get(MY_BANK.id), 0);
  assert(lastReply().startsWith("Dropped"), lastReply());

  // Answering a dropped one again changes nothing.
  await handler(replyUpdate(7213, "yes", dropped.prompt_message_id as number));
  assertEquals(backend.applyCalls, 0);
  assertEquals(balancesOf().get(MY_BANK.id), 0);

  backend.route = { tool: "update_account_balances", args: { balances: [{ account: "Bank", balance: 20000 }] } };
  await handler(textUpdate(7214, "Bank 20,000"));
  const liked = backend.tables.bot_proposals[1];
  await handler(reactionUpdate(7215, liked.prompt_message_id as number, "👍"));
  assertEquals(liked.status, "applied");
  assertEquals(balancesOf().get(MY_BANK.id), 20000);
});

freshTest("a balance changed in the app after it was proposed is left alone, and the member told", async () => {
  seedCheckinHousehold();
  backend.route = { tool: "update_account_balances", args: { balances: [{ account: "Bank", balance: 10000 }, { account: "Card", balance: 1000 }] } };
  await handler(textUpdate(7221, "Bank 10,000 · Card 1,000 owed"));
  backend.tables.accounts.find((a) => a.id === MY_BANK.id)!.balance = 9999;

  // A bare yes: the only thing waiting is this proposal.
  await handler(textUpdate(7222, "yes"));
  assertEquals(balancesOf().get(MY_BANK.id), 9999, "a newer figure from the app was overwritten");
  assertEquals(balancesOf().get(CARD.id), 1000);
  assert(lastReply().includes("Not changed: Bank reads AED 9,999.00 in the app now"), lastReply());
});

freshTest("a bare yes with an expense also waiting asks which one, and records neither", async () => {
  seedCheckinHousehold();
  backend.route = { tool: "update_account_balances", args: { balances: [{ account: "Bank", balance: 10000 }] } };
  await handler(textUpdate(7231, "Bank 10,000"));
  backend.tables.intake.push({
    id: "99990000-0000-4000-8000-000000000001", household_id: HOUSEHOLD, member_id: MEMBER, status: "pending", raw_text: "coffee 20",
    created_at: new Date().toISOString(), parsed_merchant: "Cafe", parsed_amount: 20, parsed_date: "2026-09-24", parsed_category_id: "c1",
    parsed_account_id: MY_BANK.id, parsed_currency: "AED", parsed_kind: "expense", confidence: 0.95, date_guessed: false,
    confirm_chat_id: null, confirm_message_id: null,
  });

  await handler(textUpdate(7232, "yes"));
  assert(lastReply().includes("More than one thing is waiting"), lastReply());
  assertEquals(backend.applyCalls, 0);
  assertEquals(backend.approveCalls, 0);
  assertEquals(balancesOf().get(MY_BANK.id), 0);

  // Replying to the question is unambiguous.
  await handler(replyUpdate(7233, "yes", backend.tables.bot_proposals[0].prompt_message_id as number));
  assertEquals(balancesOf().get(MY_BANK.id), 10000);
  assertEquals(backend.approveCalls, 0, "answering the balance recorded the expense");
});

freshTest("a redelivered message read differently asks about, and saves, what was read the second time", async () => {
  backend.route = { tool: "log_goal_contribution", args: { goal_name: "House", amount: 500 } };
  backend.faults.failFirstSends = 1;
  assertEquals((await handler(textUpdate(7301, "Bank 10,000"))).status, 500);

  seedCheckinHousehold();
  backend.route = { tool: "update_account_balances", args: { balances: [{ account: "Bank", balance: 10000 }] } };
  assertEquals((await handler(textUpdate(7301, "Bank 10,000"))).status, 200);
  assertEquals(backend.tables.bot_proposals.length, 1);
  assertEquals(backend.tables.bot_proposals[0].kind, "account_balances");
  assert(lastReply().includes("• Bank: AED 0.00 → AED 10,000.00"), lastReply());

  await handler(replyUpdate(7302, "yes", backend.tables.bot_proposals[0].prompt_message_id as number));
  assertEquals(balancesOf().get(MY_BANK.id), 10000);
  assertEquals(backend.tables.goal_contributions.length, 0, "a yes to a balance question recorded a goal contribution");
});

freshTest("a question Telegram refuses to deliver leaves nothing for a later yes", async () => {
  seedCheckinHousehold();
  backend.route = { tool: "update_account_balances", args: { balances: [{ account: "Bank", balance: 10000 }] } };
  backend.faults.refuseFirstSends = 1;
  // Thrown back so Telegram delivers the message again, rather than answered 200 with nothing said.
  assertEquals((await handler(textUpdate(7311, "Bank 10,000"))).status, 500);
  assertEquals(backend.tables.bot_proposals.length, 0);

  backend.route = { tool: "log_expense", args: {} };
  await handler(textUpdate(7312, "ok"));
  assertEquals(backend.applyCalls, 0, "an ok applied a change the member was never shown");
  assertEquals(balancesOf().get(MY_BANK.id), 0);
});

freshTest("a redelivery finds the proposal it made: asked already, it is left alone; never asked, it becomes this reading", async () => {
  seedCheckinHousehold();
  backend.route = { tool: "update_account_balances", args: { balances: [{ account: "Bank", balance: 10000 }] } };
  // Asked already: the member has the question; a second one would be noise, or worse, about a different reading.
  backend.tables.bot_proposals.push({
    id: "b0000000-0000-4000-8000-000000000001", household_id: HOUSEHOLD, member_id: MEMBER, kind: "goal_contribution",
    payload: { goal_id: GOAL, goal_name: "House", amount: 500 }, chat_id: TELEGRAM_USER, source_ref: "7321", status: "proposed",
    prompt_message_id: 999, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), decided_at: null, result: null,
  });
  await handler(textUpdate(7321, "Bank 10,000"));
  assertEquals(backend.telegramSent.length, 0, "a second question was sent for a proposal already asked about");
  assertEquals(backend.tables.bot_proposals[0].kind, "goal_contribution");

  // Never asked (a crash between saving and asking): rewritten to this reading, then asked.
  backend.tables.bot_proposals.push({
    id: "b0000000-0000-4000-8000-000000000002", household_id: HOUSEHOLD, member_id: MEMBER, kind: "goal_contribution",
    payload: { goal_id: GOAL, goal_name: "House", amount: 500 }, chat_id: TELEGRAM_USER, source_ref: "7322", status: "proposed",
    prompt_message_id: null, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), decided_at: null, result: null,
  });
  await handler(textUpdate(7322, "Bank 10,000"));
  const rewritten = backend.tables.bot_proposals[1];
  assertEquals(rewritten.kind, "account_balances");
  assert(rewritten.prompt_message_id, "the rewritten proposal was not asked about");
  await handler(replyUpdate(7323, "yes", rewritten.prompt_message_id as number));
  assertEquals(balancesOf().get(MY_BANK.id), 10000);
  assertEquals(backend.tables.goal_contributions.length, 0);
});

freshTest("a balance read as negative shows its sign in the question, and a card in credit says so", async () => {
  seedCheckinHousehold();
  backend.tables.accounts.find((a) => a.id === MY_BANK.id)!.balance = 10000;
  backend.route = { tool: "update_account_balances", args: { balances: [{ account: "Bank", balance: -10000 }] } };
  await handler(textUpdate(7331, "Bank 10,000"));
  assert(lastReply().includes("• Bank: AED 10,000.00 → AED -10,000.00"), lastReply());

  // A card stored at -50 is in credit; "Card 50 owed" is a real change, and must look like one.
  backend.tables.accounts.find((a) => a.id === CARD.id)!.balance = -50;
  backend.route = { tool: "update_account_balances", args: { balances: [{ account: "Card", balance: 50 }] } };
  await handler(textUpdate(7332, "Card 50 owed"));
  assert(lastReply().includes("• Card •0004: AED 50.00 in credit → AED 50.00 owed"), lastReply());
});

freshTest("a proposal never asked about is not applied by a bare yes", async () => {
  // Left behind by a run that died between saving and asking, when the
  // redelivery read the message as something else and never came back to it.
  seedCheckinHousehold();
  backend.tables.bot_proposals.push({
    id: "b0000000-0000-4000-8000-000000000003", household_id: HOUSEHOLD, member_id: MEMBER, kind: "account_balances",
    payload: { items: [{ account_id: MY_BANK.id, name: "Bank", type: "checking", currency: "AED", old_balance: 0, new_balance: 100000 }] },
    chat_id: TELEGRAM_USER, source_ref: "7361", status: "proposed", prompt_message_id: null,
    created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), decided_at: null, result: null,
  });
  backend.route = { tool: "log_expense", args: {} };
  await handler(textUpdate(7362, "ok"));
  assertEquals(backend.applyCalls, 0, "a bare ok applied a change the member was never asked about");
  assertEquals(balancesOf().get(MY_BANK.id), 0);
});

freshTest("a bare no says what it dropped, and asks which one when an expense is also waiting", async () => {
  seedCheckinHousehold();
  backend.route = { tool: "update_account_balances", args: { balances: [{ account: "Bank", balance: 10000 }, { account: "Card", balance: 1000 }] } };
  await handler(textUpdate(7341, "Bank 10,000 · Card 1,000 owed"));
  backend.tables.intake.push({
    id: "99990000-0000-4000-8000-000000000002", household_id: HOUSEHOLD, member_id: MEMBER, status: "pending", raw_text: "coffee 20",
    created_at: new Date().toISOString(), parsed_merchant: "Cafe", parsed_amount: 20, parsed_date: "2026-09-24", parsed_category_id: "c1",
    parsed_account_id: MY_BANK.id, parsed_currency: "AED", parsed_kind: "expense", confidence: 0.95, date_guessed: false,
    confirm_chat_id: null, confirm_message_id: null,
  });
  await handler(textUpdate(7342, "no"));
  assert(lastReply().includes("More than one thing is waiting"), lastReply());
  // A 👍 would save the change; someone who said "no" is not pointed at it,
  // and is told an expense is thrown away in the Inbox, not with a "no".
  assert(!lastReply().includes("👍"), lastReply());
  assert(lastReply().includes("use the Inbox"), lastReply());
  assertEquals(backend.tables.bot_proposals[0].status, "proposed");

  backend.tables.intake.length = 0;
  await handler(textUpdate(7343, "no"));
  assertEquals(backend.tables.bot_proposals[0].status, "cancelled");
  assertEquals(lastReply(), "Dropped the balances for Bank and Card •0004. Nothing was changed.");
});

freshTest("a second bare yes, or the first delivered twice, says what was saved and is not captured", async () => {
  seedCheckinHousehold();
  backend.route = { tool: "update_account_balances", args: { balances: [{ account: "Bank", balance: 10000 }] } };
  await handler(textUpdate(7351, "Bank 10,000"));
  // The "Saved" reply fails, so Telegram delivers the same "yes" again.
  backend.route = { tool: "log_expense", args: {} };
  backend.faults.failFirstSends = sendCount + 1;
  assertEquals((await handler(textUpdate(7352, "yes"))).status, 500);
  assertEquals(balancesOf().get(MY_BANK.id), 10000);
  assertEquals((await handler(textUpdate(7352, "yes"))).status, 200);
  assert(lastReply().startsWith("Already saved"), lastReply());

  await handler(textUpdate(7353, "yes"));
  assert(lastReply().startsWith("Already saved"), lastReply());
  assertEquals(capturedIntake().length, 0, "a repeated yes was captured as an expense");
  assertEquals(backend.applyCalls, 1);
});

freshTest("a question whose id could not be recorded is withdrawn and asked again, and that one is answerable", async () => {
  seedCheckinHousehold();
  backend.route = { tool: "update_account_balances", args: { balances: [{ account: "Bank", balance: 10000 }] } };
  // Both the write and its one retry fail.
  backend.faults.failPromptRecord = 2;
  assertEquals((await handler(textUpdate(7371, "Bank 10,000"))).status, 500);
  assertEquals(backend.tables.bot_proposals[0].prompt_message_id, null);
  // The member is not left with a question nothing can answer, whose reading the retry may change.
  assertEquals(backend.telegramDeleted, [1001]);

  assertEquals((await handler(textUpdate(7371, "Bank 10,000"))).status, 200);
  const prompt = backend.tables.bot_proposals[0].prompt_message_id as number;
  assertEquals(prompt, 1002);
  await handler(replyUpdate(7372, "yes", prompt));
  assertEquals(balancesOf().get(MY_BANK.id), 10000);
});

freshTest("a question whose id is recorded on the retry stays, and nothing is withdrawn", async () => {
  seedCheckinHousehold();
  backend.route = { tool: "update_account_balances", args: { balances: [{ account: "Bank", balance: 10000 }] } };
  backend.faults.failPromptRecord = 1;
  assertEquals((await handler(textUpdate(7381, "Bank 10,000"))).status, 200);
  assertEquals(backend.tables.bot_proposals[0].prompt_message_id, 1001);
  assertEquals(backend.telegramDeleted, []);
});

freshTest("a no whose lookup fails says nothing was dropped, and never to approve anything", async () => {
  seedCheckinHousehold();
  backend.route = { tool: "update_account_balances", args: { balances: [{ account: "Bank", balance: 10000 }] } };
  await handler(textUpdate(7391, "Bank 10,000"));
  backend.faults.failProposalReads = true;
  await handler(textUpdate(7392, "no"));
  assert(lastReply().includes("nothing was dropped or changed"), lastReply());
  assert(!/approve|Inbox/i.test(lastReply()), lastReply());
  assertEquals(backend.tables.bot_proposals[0].status, "proposed");
});

// Restore globals for anything that runs after this module.
addEventListener("unload", () => {
  globalThis.fetch = realFetch;
  console.error = realError;
});
