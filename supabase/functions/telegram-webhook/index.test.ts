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
    failStatementBinding?: number;
    // Reading bot_proposals fails.
    failProposalReads?: boolean;
    // Reading any of these tables fails.
    failReads?: string[];
    // Writing to any of these tables fails.
    failWrites?: string[];
    // OpenRouter answers 429 (too many requests) to its first N calls.
    aiBusyFirst?: number;
  };
  // Calls OpenRouter has received.
  aiCalls: number;
  // What the router was told, as it was sent.
  routerPrompts: string[];
  // Every database function the handler called, with its arguments.
  rpcCalls: Array<{ fn: string; args: Row }>;
  // What a trade preview answers, by function; unset, a plain buy or sale.
  previews: Record<string, Row>;
  // What applying a trade proposal answers; unset, it is saved.
  tradeOutcome?: Row;
  // What OpenRouter's router answers for a message: a tool name plus args.
  route?: { tool: string; args: Row };
  // What the parser extracts from a message; unset, it answers prose, which
  // the handler treats as a failed parse.
  parse?: Row[];
  parsePrompts: string[];
  // What the phrasing call was given: the tool's result, among other things.
  phrasePrompts: string[];
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
      goals: [{ id: GOAL, household_id: HOUSEHOLD, name: "House", done_at: null }],
      goal_contributions: [],
      categories: [],
      accounts: [],
      telegram_update_log: [],
      telegram_call_log: [],
      bot_proposals: [],
      recurring: [],
      transactions: [],
      statement_reconciliations: [],
      category_rules: [],
      telegram_notification_prefs: [],
    },
    log: new Map(),
    telegramSent: [],
    telegramDeleted: [],
    requests: [],
    faults: {},
    parsePrompts: [],
    phrasePrompts: [],
    applyCalls: 0,
    approveCalls: 0,
    aiCalls: 0,
    routerPrompts: [],
    rpcCalls: [],
    previews: {},
  };
}

// Unique keys the real schema enforces, and the fake must too, or the tests
// would pass by the fake's permissiveness rather than the handler's care.
const UNIQUE: Record<string, string[]> = {
  intake: ["household_id", "source", "source_ref"],
  goal_contributions: ["goal_id", "source", "source_ref"],
  bot_proposals: ["household_id", "source_ref"],
  statement_reconciliations: ["account_id", "statement_date"],
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
  statement_reconciliations: () => ({ status: "waiting", asked_message_ids: [], asked_prompts: [], last_asked_on: null, closed_at: null, closed_by_member_id: null }),
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// One PostgREST condition, "op.value", on one cell.
function cellMatches(cell: unknown, op: string, value: string): boolean {
  switch (op) {
    case "eq":
      return String(cell) === value;
    case "gt":
      return cell != null && String(cell) > value;
    case "lt":
      return cell != null && String(cell) < value;
    case "cs": {
      // Array containment, as asked_message_ids @> {n}.
      if (Array.isArray(cell) && /^\{[^"{}]*\}$/.test(value)) {
        const want = value.slice(1, -1).split(",").filter(Boolean).map(Number);
        return want.every((x) => (cell as unknown[]).includes(x));
      }
      // JSON array containment, as asked_prompts @> [{"chat_id": c, ...}]:
      // every object given matches some element on every key it gives.
      const wanted = JSON.parse(value) as unknown;
      if (Array.isArray(wanted)) {
        return Array.isArray(cell) && wanted.every((w) =>
          (cell as Row[]).some((c) => Object.entries(w as Row).every(([k, v]) => c?.[k] === v))
        );
      }
      // JSON containment, as payload @> {"asked_message_ids": [n]}: every key
      // given is present, and every array element given is in the cell's array.
      const want = wanted as Row;
      const have = (cell ?? {}) as Row;
      return Object.entries(want).every(([k, v]) =>
        Array.isArray(v) ? Array.isArray(have[k]) && v.every((x) => (have[k] as unknown[]).includes(x)) : have[k] === v
      );
    }
    default:
      return true;
  }
}

function matches(row: Row, params: URLSearchParams): boolean {
  for (const [col, raw] of params) {
    if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(col)) continue;
    // or=(a.op.v,b.op.v): any one of them.
    if (col === "or") {
      const parts = raw.replace(/^\(|\)$/g, "").split(",");
      const any = parts.some((part) => {
        const [c, op, ...rest] = part.split(".");
        return cellMatches(row[c], op, rest.join("."));
      });
      if (!any) return false;
      continue;
    }
    if (raw.startsWith("cs.")) {
      if (!cellMatches(row[col], "cs", raw.slice(3))) return false;
      continue;
    }
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
      // Numbers compare as numbers (an amount range), anything else as text
      // (an ISO date), as PostgREST does by column type.
      case "gte":
        ok = cell != null && (typeof cell === "number" ? cell >= Number(value) : String(cell) >= value);
        break;
      case "lte":
        ok = cell != null && (typeof cell === "number" ? cell <= Number(value) : String(cell) <= value);
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
  if (!key || (key.includes("source_ref") && row.source_ref == null)) return false;
  return backend.tables[table].some((r) => key.every((k) => r[k] === row[k]));
}

async function postgrest(req: Request, url: URL): Promise<Response> {
  const table = url.pathname.replace("/rest/v1/", "");
  const rows = (backend.tables[table] ??= []);
  const wantsObject = (req.headers.get("Accept") ?? "").includes("vnd.pgrst.object");
  const wantsRows = (req.headers.get("Prefer") ?? "").includes("return=representation");

  // A count with no rows (select with head: true), as the brief counts the Inbox.
  if (req.method === "HEAD") {
    if (backend.faults.failReads?.includes(table)) return new Response(null, { status: 500 });
    const n = rows.filter((r) => matches(r, url.searchParams)).length;
    return new Response(null, { status: 200, headers: { "Content-Range": n ? `0-${n - 1}/${n}` : "*/0" } });
  }

  if (req.method === "GET") {
    if (table === "bot_proposals" && backend.faults.failProposalReads) {
      return json({ code: "57014", message: "canceling statement due to statement timeout" }, 500);
    }
    if (backend.faults.failReads?.includes(table)) {
      return json({ code: "57014", message: "canceling statement due to statement timeout" }, 500);
    }
    let found = rows.filter((r) => matches(r, url.searchParams));
    // order=col.asc, as the paged reads end every query with a unique column.
    const order = url.searchParams.get("order");
    if (order) {
      const [col, dir] = order.split(".");
      found = [...found].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (dir === "desc" ? -1 : 1));
    }
    // A split transaction's lines, embedded as transaction_splits(...).
    if (table === "transactions" && (url.searchParams.get("select") ?? "").includes("transaction_splits")) {
      found = found.map((r) => ({ ...r, transaction_splits: (backend.tables.transaction_splits ?? []).filter((l) => l.transaction_id === r.id) }));
    }
    // The embedded accounts(name) a statement is read with.
    if (table === "statement_reconciliations") {
      found = found.map((r) => ({ ...r, accounts: { name: backend.tables.accounts.find((a) => a.id === r.account_id)?.name ?? null } }));
    }
    // PostgREST's default cap: at most 1,000 rows, whatever was asked for,
    // with nothing in the response to say it stopped.
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = url.searchParams.get("limit");
    found = found.slice(offset, offset + Math.min(limit ? Number(limit) : Infinity, 1000));
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
    if (table === "statement_reconciliations" && "asked_prompts" in patch && backend.faults.failStatementBinding) {
      backend.faults.failStatementBinding -= 1;
      return json({ code: "57014", message: "canceling statement due to statement timeout" }, 500);
    }
    if (table === "bot_proposals" && "prompt_message_id" in patch && backend.faults.failPromptRecord) {
      backend.faults.failPromptRecord -= 1;
      return json({ code: "57014", message: "canceling statement due to statement timeout" }, 500);
    }
    if (backend.faults.failWrites?.includes(table)) {
      return json({ code: "42501", message: "new row violates row-level security policy" }, 403);
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
  // A trade or an undo: saved, unless the test scripts another outcome, as
  // the database answers it (stale and refused expire the proposal).
  if (p.kind === "trade" || p.kind === "trade_undo") {
    const scripted = backend.tradeOutcome;
    p.decided_at = new Date().toISOString();
    if (scripted && scripted.outcome !== "applied") {
      p.status = "expired";
      p.result = { kind: p.kind, error: scripted.error ?? scripted.outcome };
      return { ...scripted, kind: p.kind };
    }
    const effect = { ...tradePreview({ p_kind: payload.kind, p_units: payload.units, p_price: payload.price, p_fees: payload.fees }), trade_id: crypto.randomUUID() };
    p.status = "applied";
    p.result = { kind: p.kind, effect };
    return { outcome: "applied", kind: p.kind, effect };
  }
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
  } else if (p.kind === "autopay_payment") {
    const bill = backend.tables.recurring.find((r) => r.id === payload.recurring_id && r.household_id === p.household_id);
    if (!bill) {
      skipped.push({ reason: "unavailable" });
    } else {
      const already = backend.tables.transactions.some((t) => t.account_id === bill.account_id && t.occurred_at === payload.due_date);
      if (!already) {
        backend.tables.transactions.push({ id: crypto.randomUUID(), household_id: p.household_id, account_id: bill.account_id, amount: -Number(payload.amount), occurred_at: payload.due_date, merchant: bill.name });
      }
      applied.push({ name: bill.name, amount: payload.amount, occurred_at: payload.due_date, next_due: payload.next_due, already_recorded: already });
    }
  } else if (p.kind === "transfer") {
    const from = backend.tables.accounts.find((a) => a.id === payload.from_account_id && a.household_id === p.household_id && a.archived_at == null);
    const to = backend.tables.accounts.find((a) => a.id === payload.to_account_id && a.household_id === p.household_id && a.archived_at == null);
    if (!from || !to) {
      skipped.push({ reason: "unavailable" });
    } else {
      const already = backend.tables.transactions.some((t) => t.kind === "transfer" && t.account_id === from.id && Number(t.amount) === -Number(payload.amount));
      if (!already) {
        for (const [account, sign] of [[from, -1], [to, 1]] as const) {
          backend.tables.transactions.push({ id: crypto.randomUUID(), household_id: p.household_id, account_id: account.id, amount: sign * Number(payload.amount), kind: "transfer", occurred_at: payload.occurred_at });
        }
      }
      applied.push({ from_name: from.name, to_name: to.name, amount: payload.amount, occurred_at: payload.occurred_at, joined_out: false, joined_in: false, already_recorded: already });
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

// A trade preview as the database answers one, from the trade asked about:
// ABC held at 15 shares averaging 110, its dollar fund at 1,000.
function tradePreview(args: Row): Row {
  const units = Number(args.p_units);
  const price = Number(args.p_price ?? 0);
  const fees = Number(args.p_fees ?? 0);
  const sale = args.p_kind === "sell";
  const cash = sale ? units * price - fees : -(units * price + fees);
  return {
    ok: true, units, price, fees, tax_withheld: 0, trades_version: 3, units_before: 15, avg_before: 110,
    holding_units_after: sale ? 15 - units : 15 + units, holding_avg_after: sale ? 110 : (15 * 110 + units * price) / (15 + units),
    realised: sale ? units * (price - 110) - fees : null,
    funds_account_id: args.p_funds_account_id ??
      (backend.tables.holdings ?? []).find((h) => h.id === args.p_holding_id)?.funds_account_id ?? "a3700000-0000-4000-8000-0000000000f1",
    funds_moves: true, funds_delta: cash, funds_balance_before: 1000, funds_balance_after: 1000 + cash, warnings: [],
  };
}

async function rpc(req: Request, fn: string): Promise<Response> {
  const args = await req.json().catch(() => ({}));
  backend.rpcCalls.push({ fn, args });
  if (fn === "preview_trade") return json(backend.previews.preview_trade ?? tradePreview(args));
  if (fn === "preview_new_holding_trade") {
    const holding = args.p_new_holding as Row;
    if (!holding?.funds_account_id) return json({ ok: false, error: "fund_required" });
    return json(backend.previews.preview_new_holding_trade ?? {
      ...tradePreview({ ...args, p_kind: "buy", p_funds_account_id: holding.funds_account_id }),
      trades_version: 1, units_before: 0, avg_before: null, holding_units_after: Number(args.p_units), holding_avg_after: Number(args.p_price),
      new_holding: true,
    });
  }
  if (fn === "get_telegram_webhook_secret") return json(SECRET);
  if (fn === "apply_bot_proposal") {
    backend.applyCalls += 1;
    return json(applyProposal(String(args.p_proposal_id), String(args.p_member_id)));
  }
  if (fn === "approve_intake") backend.approveCalls += 1;
  // Mirrors merchant_category_counts in the statement_reconciliations migration.
  if (fn === "merchant_category_counts") {
    const tally = new Map<string, Row>();
    for (const t of backend.tables.transactions) {
      if (t.household_id !== args.p_household_id || t.merchant == null || t.category_id == null || (t.kind ?? "expense") !== "expense") continue;
      const key = `${t.merchant}|${t.category_id}`;
      const seen = tally.get(key) ?? { merchant: t.merchant, category_id: t.category_id, uses: 0, last_used: "" };
      seen.uses = Number(seen.uses) + 1;
      if (String(t.occurred_at) > String(seen.last_used)) seen.last_used = t.occurred_at;
      tally.set(key, seen);
    }
    return json([...tally.values()]);
  }
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
  backend.aiCalls += 1;
  if (backend.faults.aiBusyFirst && backend.aiCalls <= backend.faults.aiBusyFirst) {
    return json({ error: { code: 429, message: "Rate limit exceeded" } }, 429);
  }
  // The router is the call that offers tools; parsing and phrasing do not.
  if (Array.isArray(body.tools)) backend.routerPrompts.push(JSON.stringify(body.messages ?? []));
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
  backend.phrasePrompts.push(text);
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
const { accountsForCheckin, buildBalanceCheckinMessage, datedItems, figuresUnavailableMessage, forwardedDay, inboxReason, isSpendingAccount, merchantHistoryMatches, pickAccountByHint, pickCheckinAccount, proposalOutcomeMessage, transferDraftFrom, undatedNote } = await import("./index.ts");
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

freshTest("a goal marked done takes no contribution, and the reply is told it is done", async () => {
  backend.tables.goals[0].done_at = "2026-09-01T00:00:00Z";
  backend.tables.goals.push({ id: "a9100000-0000-4000-8000-0000000000e2", household_id: HOUSEHOLD, name: "Car", done_at: null });
  backend.route = { tool: "log_goal_contribution", args: { goal_name: "House", amount: 500 } };
  await handler(textUpdate(7011, "put 500 toward the house goal"));
  assertEquals(backend.tables.bot_proposals.length, 0, "a contribution to a done goal was proposed");
  assertEquals(backend.tables.goal_contributions.length, 0);
  assertEquals(capturedIntake().length, 0, "a goal contribution was captured as an expense");
  const given = backend.phrasePrompts.join("\n");
  assert(given.includes("goal_done") && given.includes("House"), given);
});

freshTest("a goal list that could not be read records nothing and says so", async () => {
  backend.faults.failReads = ["goals"];
  backend.route = { tool: "log_goal_contribution", args: { goal_name: "House", amount: 500 } };
  await handler(textUpdate(7012, "put 500 toward the house goal"));
  assertEquals(backend.tables.bot_proposals.length, 0);
  assertEquals(backend.tables.goal_contributions.length, 0);
  assertEquals(capturedIntake().length, 0, "an unreadable goal list sent the message to the Inbox");
  assert(lastReply().startsWith("I couldn't read your goals just now"), lastReply());
});

freshTest("a transfer between the household's own accounts is proposed, and recorded as one only on a yes", async () => {
  backend.tables.accounts.push(
    { id: "acc-current", household_id: HOUSEHOLD, name: "Current account", archived_at: null },
    { id: "acc-card", household_id: HOUSEHOLD, name: "Bank card •0001", archived_at: null },
  );
  backend.route = { tool: "log_transfer", args: { from_account: "current account", to_account: "bank card", amount: 3000, occurred_at: "2026-09-20" } };
  await handler(textUpdate(7101, "paid the card 3000 from the current account"));
  assertEquals(backend.tables.bot_proposals.length, 1);
  assertEquals(backend.tables.bot_proposals[0].kind, "transfer");
  assertEquals(backend.tables.transactions.length, 0, "a transfer was recorded before anyone said yes");
  assertEquals(capturedIntake().length, 0, "a transfer was also captured as an expense");
  assert(lastReply().startsWith("Record a transfer of AED 3000.00 from Current account to Bank card •0001, dated 2026-09-20?"), lastReply());

  const prompt = backend.tables.bot_proposals[0].prompt_message_id as number;
  await handler(replyUpdate(7102, "yes", prompt));
  assertEquals(backend.tables.transactions.map((t) => [t.account_id, t.amount, t.kind]), [["acc-current", -3000, "transfer"], ["acc-card", 3000, "transfer"]]);
  assert(lastReply().startsWith("Recorded the transfer: AED 3000.00 from Current account to Bank card •0001"), lastReply());

  await handler(replyUpdate(7103, "yes", prompt));
  assertEquals(backend.tables.transactions.length, 2, "a second yes recorded it again");
  assert(lastReply().startsWith("Already recorded"), lastReply());
});

freshTest("a transfer naming an account that matches nothing proposes nothing and captures nothing", async () => {
  backend.tables.accounts.push({ id: "acc-current", household_id: HOUSEHOLD, name: "Current account", archived_at: null });
  backend.route = { tool: "log_transfer", args: { from_account: "current account", to_account: "somewhere else", amount: 100 } };
  await handler(textUpdate(7104, "moved 100 to somewhere else"));
  assertEquals(backend.tables.bot_proposals.length, 0);
  assertEquals(backend.tables.transactions.length, 0);
  assertEquals(capturedIntake().length, 0, "a transfer that could not be matched was captured as an expense");
});

Deno.test("a transfer is drafted only when each side names exactly one open account", () => {
  const accounts = [
    { id: "a", name: "Current account" },
    { id: "b", name: "Bank card •0001" },
    { id: "c", name: "Savings" },
  ];
  const ok = transferDraftFrom(accounts, { from_account: "current", to_account: "card", amount: -250.5 }, "2026-10-16");
  assertEquals(ok, { from: accounts[0], to: accounts[1], amount: 250.5, occurredAt: "2026-10-16", note: null });
  assertEquals((transferDraftFrom(accounts, { to_account: "card", amount: 5 }, "2026-10-16") as { error: string }).error, "from_account_missing");
  assertEquals((transferDraftFrom(accounts, { from_account: "nowhere", to_account: "card", amount: 5 }, "2026-10-16") as { error: string }).error, "from_account_not_found");
  assertEquals((transferDraftFrom(accounts, { from_account: "savings", to_account: "savings", amount: 5 }, "2026-10-16") as { error: string }).error, "same_account");
  assertEquals((transferDraftFrom(accounts, { from_account: "savings", to_account: "card", amount: 0 }, "2026-10-16") as { error: string }).error, "invalid_amount");
});

Deno.test("a recorded transfer says which sides were already in Rokda", () => {
  const message = proposalOutcomeMessage({
    outcome: "applied",
    kind: "transfer",
    applied: [{ from_name: "Current account", to_name: "Bank card", amount: 450, occurred_at: "2026-10-13", joined_out: true, joined_in: false, already_recorded: false }],
    skipped: [],
  });
  assert(message.includes("the payment out of Current account was already in Rokda"), message);
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

// ---------------------------------------------------------------------------
// Autopay bills: asked on the due date, every morning after, until answered
// ---------------------------------------------------------------------------

const EMI = "a7000000-0000-4000-8000-0000000000e1";
const BANK = "a7000000-0000-4000-8000-0000000000b1";

function dubaiToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function dailyCheck(): Request {
  return new Request("http://edge.test/telegram-webhook?run_recurring_check=1", {
    method: "GET",
    headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET },
  });
}

// A day this many days before today in Dubai, as stored.
function dubaiDaysAgo(n: number): string {
  const [y, m, d] = dubaiToday().split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d - n));
  return day.toISOString().slice(0, 10);
}

freshTest("a bill paid after the first thousand records of its window still counts as paid", async () => {
  backend.tables.recurring_nudges = [];
  backend.tables.recurring.push({
    id: "a9000000-0000-4000-8000-0000000000e1", household_id: HOUSEHOLD, name: "Rent", owner_member_id: null, is_shared: true, amount: -500,
    next_due_date: dubaiDaysAgo(4), ends_on: null, cadence: "monthly", interval_count: 1, account_id: BANK, category_id: null, active: true, autopay: false,
  });
  // A thousand small records in the same window, on the same account.
  for (let i = 0; i < 1000; i++) {
    backend.tables.transactions.push({ id: `filler-${i}`, household_id: HOUSEHOLD, account_id: BANK, amount: -5, occurred_at: dubaiDaysAgo(4) });
  }

  // Unpaid: asked about, so the check itself is running.
  const unpaid = await handler(dailyCheck());
  await unpaid.body?.cancel();
  assert(backend.telegramSent.some((m) => String(m.body.text).startsWith('I don\'t see a transaction for "Rent"')), "an unpaid bill was not asked about");

  // Paid, as the 1,001st record of the window: not asked about.
  backend.tables.recurring_nudges = [];
  backend.telegramSent.length = 0;
  backend.tables.transactions.push({ id: "rent-paid", household_id: HOUSEHOLD, account_id: BANK, amount: -500, occurred_at: dubaiDaysAgo(4) });
  const paid = await handler(dailyCheck());
  await paid.body?.cancel();
  assert(!backend.telegramSent.some((m) => String(m.body.text).startsWith("I don't see a transaction")), "a paid bill was asked about");
});

// A bill on autopay from a bank account, due today.
function seedAutopayBill(): void {
  backend.tables.recurring.push({
    id: EMI, household_id: HOUSEHOLD, name: "Car EMI", owner_member_id: null, is_shared: true, amount: -2000,
    next_due_date: dubaiToday(), ends_on: null, cadence: "monthly", interval_count: 1, account_id: BANK, category_id: null,
    active: true, autopay: true, accounts: { name: "Bank" },
  });
}

function autopayQuestions(): Array<{ method: string; body: Row }> {
  return backend.telegramSent.filter((m) => /deducted/.test(String(m.body.text)));
}

async function askedEmi(): Promise<Row> {
  seedAutopayBill();
  const res = await handler(dailyCheck());
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const proposal = backend.tables.bot_proposals.find((p) => p.kind === "autopay_payment");
  assert(proposal, "no autopay question was saved");
  return proposal;
}

freshTest("an autopay bill is asked about on its due date, once a day", async () => {
  const proposal = await askedEmi();
  const questions = autopayQuestions();
  assertEquals(questions.length, 1);
  assert(/Car EMI \(AED 2,000.00\) was due today/.test(String(questions[0].body.text)), String(questions[0].body.text));
  assertEquals((proposal.payload as Row).asked_message_ids, [proposal.prompt_message_id]);
  assertEquals((proposal.payload as Row).last_asked_on, dubaiToday());

  // The same morning's check running again asks nothing more.
  const again = await handler(dailyCheck());
  await again.body?.cancel();
  assertEquals(autopayQuestions().length, 1);
  assertEquals(backend.tables.bot_proposals.filter((p) => p.kind === "autopay_payment").length, 1);
});

freshTest("the next morning's reminder can be answered, and so can the first question", async () => {
  const proposal = await askedEmi();
  const first = Number(proposal.prompt_message_id);
  // Tomorrow morning: asked again, as a reminder, on the same question.
  (proposal.payload as Row).last_asked_on = "2000-01-01";
  const res = await handler(dailyCheck());
  await res.body?.cancel();
  const questions = autopayQuestions();
  assertEquals(questions.length, 2);
  assert(String(questions[1].body.text).startsWith("Reminder: has Car EMI"), String(questions[1].body.text));
  assertEquals(((proposal.payload as Row).asked_message_ids as number[]).length, 2);

  // A 👍 on yesterday's message still records it.
  await handler(reactionUpdate(9101, first, "👍"));
  assertEquals(backend.tables.transactions.length, 1);
  assertEquals(backend.tables.transactions[0].amount, -2000);
  assert(/^Recorded: Car EMI, AED 2000.00/.test(lastReply()), lastReply());
  assertEquals(proposal.status, "applied");
});

freshTest("a bare \"paid\" hours after the question records the bill", async () => {
  const proposal = await askedEmi();
  // Asked this morning, answered this afternoon: past the few minutes a bare
  // "yes" normally counts for.
  proposal.created_at = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  await handler(textUpdate(9102, "it's paid ✅"));
  assertEquals(backend.applyCalls, 1);
  assertEquals(backend.tables.transactions.length, 1);
  assert(/^Recorded: Car EMI/.test(lastReply()), lastReply());
  assertEquals(capturedIntake().length, 0);
});

freshTest("\"not yet\" keeps the question open, and a \"paid\" later the same day still counts", async () => {
  const proposal = await askedEmi();
  await handler(replyUpdate(9103, "not yet", Number(proposal.prompt_message_id)));
  assertEquals(backend.applyCalls, 0);
  assertEquals(proposal.status, "proposed");
  assertEquals((proposal.payload as Row).not_yet_on, dubaiToday());
  assert(/I'll ask again tomorrow morning/.test(lastReply()), lastReply());

  await handler(replyUpdate(9104, "deducted", Number(proposal.prompt_message_id)));
  assertEquals(backend.tables.transactions.length, 1);
});

freshTest("a 👎 on the question means not yet", async () => {
  const proposal = await askedEmi();
  await handler(reactionUpdate(9105, Number(proposal.prompt_message_id), "👎"));
  assertEquals(backend.applyCalls, 0);
  assertEquals(proposal.status, "proposed");
  assert(/I'll ask again tomorrow morning/.test(lastReply()), lastReply());
});

freshTest("an amount given with the answer is the amount recorded", async () => {
  const proposal = await askedEmi();
  await handler(replyUpdate(9106, "paid 2,050", Number(proposal.prompt_message_id)));
  assertEquals((proposal.payload as Row).amount, 2050);
  assertEquals((proposal.payload as Row).scheduled_amount, 2000);
  assertEquals(backend.tables.transactions[0].amount, -2050);
});

freshTest("a bill already in Rokda is not asked about", async () => {
  seedAutopayBill();
  backend.tables.transactions.push({ id: "t1", household_id: HOUSEHOLD, account_id: BANK, amount: -2000, occurred_at: dubaiToday() });
  const res = await handler(dailyCheck());
  await res.body?.cancel();
  assertEquals(autopayQuestions().length, 0);
  assertEquals(backend.tables.bot_proposals.length, 0);
});

freshTest("\"paid\" is not an answer to a balance change", async () => {
  backend.tables.accounts.push({ id: "acc1", household_id: HOUSEHOLD, name: "Bank", type: "checking", currency: "AED", balance: 100, archived_at: null });
  backend.tables.bot_proposals.push({
    id: "bp1", household_id: HOUSEHOLD, member_id: MEMBER, kind: "account_balances", chat_id: TELEGRAM_USER, source_ref: "x1",
    payload: { items: [{ account_id: "acc1", name: "Bank", old_balance: 100, new_balance: 200 }] },
    status: "proposed", prompt_message_id: 555, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(),
  });
  await handler(replyUpdate(9107, "paid", 555));
  assertEquals(backend.applyCalls, 0);
  assertEquals(backend.tables.accounts[0].balance, 100);
  // Neither applied nor dropped: still waiting for its own "yes" or "no".
  assertEquals(backend.tables.bot_proposals[0].status, "proposed");
});


// ---------------------------------------------------------------------------
// Categories from the household's own rules and history
// ---------------------------------------------------------------------------

const FUEL = "c3000000-0000-4000-8000-0000000000f1";
const WASH = "c3000000-0000-4000-8000-0000000000f2";
const CAR = "c3000000-0000-4000-8000-0000000000f3";

function seedFuelHistory(): void {
  backend.tables.categories.push(
    { id: FUEL, household_id: HOUSEHOLD, name: "Fuel", kind: "expense", archived: false, is_savings: false },
    { id: WASH, household_id: HOUSEHOLD, name: "Car Wash", kind: "expense", archived: false, is_savings: false },
    { id: CAR, household_id: HOUSEHOLD, name: "Car", kind: "expense", archived: false, is_savings: false },
  );
  // Fuel from a card statement long ago, then 300 newer transactions
  // elsewhere: past the 200 the bot used to read.
  for (let i = 0; i < 3; i++) {
    backend.tables.transactions.push({ id: crypto.randomUUID(), household_id: HOUSEHOLD, merchant: "EPPCO SITE 1077", category_id: FUEL, kind: "expense", amount: -100, occurred_at: "2026-01-0" + (i + 1) });
  }
  for (let i = 0; i < 300; i++) {
    backend.tables.transactions.push({ id: crypto.randomUUID(), household_id: HOUSEHOLD, merchant: "Cafe", category_id: WASH, kind: "expense", amount: -5, occurred_at: "2026-09-01" });
  }
  backend.parse = [{ merchant: "Eppco", amount: 120, currency: "AED", occurred_at: "2026-09-24", category: "Car Wash", card_last4: null, account_hint: null, confidence: 1, kind: "expense" }];
}

freshTest("a typed expense takes the category the household used for that merchant, however long ago", async () => {
  seedFuelHistory();
  await handler(textUpdate(9201, "eppco 120"));
  assertEquals(capturedIntake().length, 1);
  assertEquals(capturedIntake()[0].parsed_category_id, FUEL);
});

freshTest("a household rule outranks the merchant's history", async () => {
  seedFuelHistory();
  backend.tables.category_rules.push({ id: "r1", household_id: HOUSEHOLD, pattern: "eppco", match_type: "contains", category_id: CAR, archived: false, created_at: "2026-01-01" });
  await handler(textUpdate(9202, "eppco 120"));
  assertEquals(capturedIntake()[0].parsed_category_id, CAR);
});

freshTest("a merchant the household has not seen keeps the model's category", async () => {
  seedFuelHistory();
  backend.parse = [{ ...(backend.parse as Row[])[0], merchant: "Car spa", category: "Car Wash" }];
  await handler(textUpdate(9203, "car spa 40"));
  assertEquals(capturedIntake()[0].parsed_category_id, WASH);
});

// ---------------------------------------------------------------------------
// Card statements: asked about from the day after they close, until done
// ---------------------------------------------------------------------------

const STATEMENT_CARD = "a8000000-0000-4000-8000-0000000000c1";

// A card whose statement closed yesterday, and that statement's date.
function seedStatementCard(over: Row = {}): string {
  const today = dubaiToday();
  const day = Number(today.slice(8));
  const statementDay = day > 1 ? day - 1 : 28;
  backend.tables.accounts.push({
    id: STATEMENT_CARD, household_id: HOUSEHOLD, name: "Bank card", type: "credit_card", owner_member_id: MEMBER, is_shared: false,
    balance: 0, balance_aed: 0, currency: "AED", statement_day: statementDay, due_day: null, archived_at: null, ...over,
  });
  if (day > 1) return `${today.slice(0, 8)}${String(statementDay).padStart(2, "0")}`;
  const d = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 28);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-28`;
}

function statementQuestions(): Array<{ method: string; body: Row }> {
  return backend.telegramSent.filter((m) => /^(Your .* statement closed on|Reminder: the .* statement from)/.test(String(m.body.text)));
}

async function askedStatement(): Promise<Row> {
  const statementDate = seedStatementCard();
  const res = await handler(dailyCheck());
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const row = backend.tables.statement_reconciliations[0];
  assert(row, "no statement was recorded");
  assertEquals(row.statement_date, statementDate);
  return row;
}

freshTest("a card statement is asked about the day after it closes, once a day", async () => {
  const row = await askedStatement();
  const questions = statementQuestions();
  assertEquals(questions.length, 1);
  assert(/^Your Bank card statement closed on /.test(String(questions[0].body.text)), String(questions[0].body.text));
  assertEquals(row.status, "waiting");
  assertEquals(row.asked_prompts, [{ chat_id: TELEGRAM_USER, message_id: (row.asked_prompts as Row[])[0].message_id, member_id: MEMBER }]);
  assertEquals(row.last_asked_on, dubaiToday());

  const again = await handler(dailyCheck());
  await again.body?.cancel();
  assertEquals(statementQuestions().length, 1);
  assertEquals(backend.tables.statement_reconciliations.length, 1);
});

freshTest("the next morning asks again, and a 👍 on the first question marks it done", async () => {
  const row = await askedStatement();
  const first = Number((row.asked_prompts as Row[])[0].message_id);
  row.last_asked_on = "2000-01-01";
  const res = await handler(dailyCheck());
  await res.body?.cancel();
  assertEquals(statementQuestions().length, 2);
  assert(String(statementQuestions()[1].body.text).startsWith("Reminder: the Bank card statement"), String(statementQuestions()[1].body.text));

  await handler(reactionUpdate(9211, first, "👍"));
  assertEquals(row.status, "confirmed");
  assertEquals(row.closed_by_member_id, MEMBER);
  assert(/is marked as done\.$/.test(lastReply()), lastReply());

  // Done means no more questions.
  row.last_asked_on = "2000-01-01";
  const later = await handler(dailyCheck());
  await later.body?.cancel();
  assertEquals(statementQuestions().length, 2);
});

freshTest("a bare \"done\" answers the only waiting statement, but a bare \"yes\" does not", async () => {
  const row = await askedStatement();
  await handler(textUpdate(9212, "yes"));
  assertEquals(row.status, "waiting");
  const captured = capturedIntake().length;
  await handler(textUpdate(9213, "done ✅"));
  assertEquals(row.status, "confirmed");
  // An answer, not an expense.
  assertEquals(capturedIntake().length, captured);
});

freshTest("\"not yet\" as a reply keeps the statement waiting", async () => {
  const row = await askedStatement();
  await handler(replyUpdate(9214, "not yet", Number((row.asked_prompts as Row[])[0].message_id)));
  assertEquals(row.status, "waiting");
  assert(/again tomorrow morning/.test(lastReply()), lastReply());
});

freshTest("a statement question that can't be tied to its statement is withdrawn, and asked again the next morning", async () => {
  seedStatementCard();
  backend.faults.failStatementBinding = 2;
  const first = await handler(dailyCheck());
  await first.body?.cancel();
  const row = backend.tables.statement_reconciliations[0];
  const sent = statementQuestions();
  assertEquals(sent.length, 1);
  // Withdrawn: a "done" to it would have settled nothing.
  assertEquals(backend.telegramDeleted.length, 1);
  assertEquals((row.asked_prompts as Row[] | undefined)?.length ?? 0, 0);
  assertEquals(row.last_asked_on ?? null, null);

  const again = await handler(dailyCheck());
  await again.body?.cancel();
  assertEquals(statementQuestions().length, 2);
  assertEquals((row.asked_prompts as Row[]).length, 1);
  await handler(replyUpdate(9220, "done", Number((row.asked_prompts as Row[])[0].message_id)));
  assertEquals(row.status, "confirmed");
});

freshTest("statement questions switched off, or a closed card, ask nothing", async () => {
  seedStatementCard({ archived_at: "2026-09-01T00:00:00Z" });
  backend.tables.accounts.push({ ...backend.tables.accounts[0], id: "a8000000-0000-4000-8000-0000000000c2", archived_at: null });
  backend.tables.telegram_notification_prefs.push({ household_id: HOUSEHOLD, statement_enabled: false });
  const res = await handler(dailyCheck());
  await res.body?.cancel();
  assertEquals(statementQuestions().length, 0);
  assertEquals(backend.tables.statement_reconciliations.length, 0);
});

// The household's other member, with their own chat with the bot.
const PARTNER_MEMBER = "22222222-2222-4222-8222-2222222222b2";
const PARTNER_TELEGRAM = 535353;

function addPartner(): void {
  backend.tables.household_members.push({ id: PARTNER_MEMBER, household_id: HOUSEHOLD, display_name: "Partner", telegram_user_id: PARTNER_TELEGRAM, role: "member" });
}

// A message or reaction from the partner, in the partner's own chat.
function partnerUpdate(updateId: number, body: Row): Request {
  const from = { id: PARTNER_TELEGRAM, is_bot: false, first_name: "P" };
  const chat = { id: PARTNER_TELEGRAM, type: "private" };
  const update = "new_reaction" in body
    ? { update_id: updateId, message_reaction: { chat, user: from, date: 1, old_reaction: [], ...body } }
    : { update_id: updateId, message: { message_id: 3, date: 1, chat, from, ...body } };
  return new Request("http://edge.test/telegram-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": SECRET },
    body: JSON.stringify(update),
  });
}

function firstPrompt(row: Row): number {
  return Number((row.asked_prompts as Row[])[0].message_id);
}

freshTest("a reply in another chat to a message with the same id does not settle a statement", async () => {
  addPartner();
  // The card is the first member's own, so only they are asked.
  const row = await askedStatement();
  // The partner's chat has its own message with that id, an expense
  // question say, and the partner answers it.
  await handler(partnerUpdate(9220, { text: "yes", reply_to_message: { message_id: firstPrompt(row) } }));
  await handler(partnerUpdate(9221, { text: "done", reply_to_message: { message_id: firstPrompt(row) } }));
  assertEquals(row.status, "waiting");
  assert(!backend.telegramSent.some((m) => /marked as done/.test(String(m.body.text))), "a statement was reported done");
});

freshTest("a reaction in another chat on a message with the same id does not settle a statement", async () => {
  addPartner();
  const row = await askedStatement();
  await handler(partnerUpdate(9222, { message_id: firstPrompt(row), new_reaction: [{ type: "emoji", emoji: "👍" }] }));
  assertEquals(row.status, "waiting");
});

freshTest("a bare \"done\" from a member who was not asked about a statement does not settle it", async () => {
  addPartner();
  const row = await askedStatement();
  await handler(partnerUpdate(9223, { text: "done" }));
  assertEquals(row.status, "waiting");
});

freshTest("a shared card's statement is asked in both chats, and either chat's answer settles it", async () => {
  addPartner();
  seedStatementCard({ is_shared: true, owner_member_id: null });
  const res = await handler(dailyCheck());
  await res.body?.cancel();
  const row = backend.tables.statement_reconciliations[0];
  const prompts = row.asked_prompts as Row[];
  assertEquals(prompts.map((p) => p.chat_id).sort(), [TELEGRAM_USER, PARTNER_TELEGRAM].sort());
  const partners = prompts.find((p) => p.chat_id === PARTNER_TELEGRAM)!;
  await handler(partnerUpdate(9224, { text: "done", reply_to_message: { message_id: partners.message_id } }));
  assertEquals(row.status, "confirmed");
  assertEquals(row.closed_by_member_id, PARTNER_MEMBER);
});

freshTest("a refused write is not reported as done", async () => {
  const row = await askedStatement();
  backend.faults.failWrites = ["statement_reconciliations"];
  await handler(replyUpdate(9225, "done", firstPrompt(row)));
  assertEquals(row.status, "waiting");
  assert(/couldn't save that/.test(lastReply()), lastReply());
});

freshTest("an answer to a statement settled in between says what it is now", async () => {
  const row = await askedStatement();
  // Checked in the meantime, and found not to match.
  Object.assign(row, { status: "mismatch", closed_at: new Date().toISOString() });
  await handler(replyUpdate(9226, "done", firstPrompt(row)));
  assertEquals(row.status, "mismatch");
  assert(/doesn't match Rokda/.test(lastReply()), lastReply());
});

freshTest("\"sent to Claude\" keeps the statement waiting, and the bot keeps asking", async () => {
  const row = await askedStatement();
  await handler(replyUpdate(9227, "sent to Claude", firstPrompt(row)));
  assertEquals(row.status, "waiting");
  assert(/until it has been checked/.test(lastReply()), lastReply());
  row.last_asked_on = "2000-01-01";
  const later = await handler(dailyCheck());
  await later.body?.cancel();
  assertEquals(statementQuestions().length, 2);
});

// ---------------------------------------------------------------------------
// An expense the bot cannot record yet says so, and why
// ---------------------------------------------------------------------------

Deno.test("an expense sent to the Inbox says it is not recorded yet, and what was missing", () => {
  const ready = { parsed_amount: 204.38, parsed_merchant: "du", parsed_account_id: "a", parsed_category_id: "c", parsed_currency: "AED", confidence: 1 };
  assert(inboxReason({ ...ready, parsed_merchant: null }).startsWith("Not recorded yet: I couldn't tell who was paid, so it's in the Inbox."));
  assertEquals(
    inboxReason({ ...ready, parsed_merchant: null, parsed_account_id: null, parsed_category_id: null }),
    "Not recorded yet: I couldn't tell who was paid, which card or account or the category, so it's in the Inbox. Approve it there, or send it again with that added.",
  );
  assert(inboxReason({ ...ready, parsed_currency: "USD" }).includes("It's in USD: approve it with the AED debited"));
  assert(!inboxReason({ ...ready, parsed_currency: "USD" }).includes("couldn't tell"), "a known currency was listed as something missing");
  assert(inboxReason({ ...ready, confidence: 0.6 }).includes("I wasn't sure I read it right"));
  assert(inboxReason(ready, { occurred_at: "2026-09-28" }).includes("already in Rokda from 2026-09-28"));
});

freshTest("a payment typed without a merchant the parser recognised is reported as not recorded", async () => {
  backend.tables.accounts.push({ id: "a9000000-0000-4000-8000-000000000001", household_id: HOUSEHOLD, name: "ENBD Marriott •8643", type: "credit_card", currency: "AED", archived_at: null });
  backend.parse = [{ merchant: null, amount: 204.38, currency: "AED", occurred_at: "2026-10-13", date_stated: true, source: "typed", category: null, card_last4: null, account_hint: "ENBD Marriott", confidence: 0.9, kind: "expense" }];
  await handler(textUpdate(9301, "Du wifi paid today using marriot card 204.38"));
  assertEquals(capturedIntake().length, 1);
  assert(/^Not recorded yet: I couldn't tell who was paid/.test(lastReply()), lastReply());
  // The parser is told that a biller named in passing is the merchant.
  assert(backend.parsePrompts[0].includes("is who was paid"), "the parser was not told what a merchant is");
});

// ---------------------------------------------------------------------------
// A figure the bot states is read in full, or not stated
// ---------------------------------------------------------------------------

const GROCERIES = "a9100000-0000-4000-8000-0000000000c1";

// `count` expenses of AED `amount` each on `day`, after any already there.
function seedExpenses(count: number, day: string, amount: number, prefix: string): void {
  for (let i = 0; i < count; i++) {
    backend.tables.transactions.push({
      id: `${prefix}-${String(i).padStart(5, "0")}`, household_id: HOUSEHOLD, account_id: "a9100000-0000-4000-8000-0000000000a1",
      category_id: GROCERIES, amount: -amount, kind: "expense", occurred_at: day, is_shared: true, owner_member_id: null, merchant: "Shop",
    });
  }
}

function thisMonthFirst(): string {
  return `${dubaiToday().slice(0, 8)}01`;
}

freshTest("this month's spending is found after a thousand older transactions", async () => {
  // Stored first, so a single unordered read returned only these and the
  // brief said AED 0.
  seedExpenses(1000, "2025-01-15", 10, "t-old");
  seedExpenses(85, thisMonthFirst(), 10, "t-new");
  await handler(textUpdate(9301, "brief"));
  assert(lastReply().includes("Spent this month: AED 850\n"), lastReply());
});

freshTest("a month with more than a thousand transactions is totalled in full", async () => {
  seedExpenses(1085, thisMonthFirst(), 10, "t-month");
  await handler(textUpdate(9302, "brief"));
  assert(lastReply().includes("Spent this month: AED 10,850\n"), lastReply());
  // Two pages each for the month's total and its budget alerts.
  assertEquals(backend.requests.filter((r) => r.method === "GET" && r.path === "/rest/v1/transactions").length, 4);
});

freshTest("a brief whose spending could not be read says so rather than AED 0", async () => {
  seedExpenses(3, thisMonthFirst(), 10, "t-fail");
  backend.faults.failReads = ["transactions"];
  await handler(textUpdate(9303, "brief"));
  const brief = lastReply();
  assert(brief.includes("Spent this month: couldn't be read just now."), brief);
  assert(!/Spent this month: AED/.test(brief), brief);
  // What could be read is still there.
  assert(brief.startsWith("Net worth: AED "), brief);
});

freshTest("a brief whose accounts could not be read states no net worth and no cash cover", async () => {
  backend.faults.failReads = ["accounts"];
  await handler(textUpdate(9304, "brief"));
  const brief = lastReply();
  assert(brief.includes("Net worth: couldn't be read just now."), brief);
  assert(brief.includes("Cash cover: couldn't be read just now."), brief);
  assert(brief.includes("Bills due: couldn't be read just now."), brief);
  assert(brief.includes("Inbox is clear."), brief);
});

freshTest("a split receipt counts only its line in the category asked about", async () => {
  const HOUSEHOLD_GOODS = "a9100000-0000-4000-8000-0000000000c2";
  backend.tables.categories.push(
    { id: GROCERIES, household_id: HOUSEHOLD, name: "Groceries", kind: "expense", archived: false, is_savings: false },
    { id: HOUSEHOLD_GOODS, household_id: HOUSEHOLD, name: "Household", kind: "expense", archived: false, is_savings: false },
  );
  // 500 at the supermarket: 400 groceries, 100 household goods.
  backend.tables.transactions.push({
    id: "split-1", household_id: HOUSEHOLD, account_id: "a9100000-0000-4000-8000-0000000000a1", category_id: null, is_split: true,
    amount: -500, kind: "expense", occurred_at: thisMonthFirst(), is_shared: true, owner_member_id: null, merchant: "Supermarket",
  });
  backend.tables.transaction_splits = [
    { id: "l1", household_id: HOUSEHOLD, transaction_id: "split-1", category_id: GROCERIES, amount: -400 },
    { id: "l2", household_id: HOUSEHOLD, transaction_id: "split-1", category_id: HOUSEHOLD_GOODS, amount: -100 },
  ];
  backend.route = { tool: "get_category_spend", args: { category: "Household", period: "this_month" } };
  await handler(textUpdate(9320, "how much on household this month?"));
  // The member asking carries half of a shared receipt: half of the 100
  // household line, not half of the 500 receipt.
  const given = backend.phrasePrompts.join("\n");
  assert(given.includes('\\"spend_aed\\":50}'), given);
});

for (const [tool, args, table] of [
  ["get_category_spend", { category: "Groceries", period: "this_month" }, "transactions"],
  ["get_budget_status", { category: "Groceries" }, "budgets"],
  ["get_net_worth", {}, "holdings"],
  ["get_account_balance", { account_name: "bank" }, "accounts"],
  ["get_holdings", { range: "1m" }, "holding_value_history"],
] as Array<[string, Row, string]>) {
  freshTest(`${tool} with ${table} unreadable answers that it cannot, and records nothing`, async () => {
    backend.tables.categories.push({ id: GROCERIES, household_id: HOUSEHOLD, name: "Groceries", kind: "expense", archived: false, is_savings: false });
    backend.tables.holdings = [{ id: "a9100000-0000-4000-8000-0000000000d1", household_id: HOUSEHOLD, name: "Fund", asset_class: "equity", value_aed: 100, is_shared: true, owner_member_id: null }];
    backend.route = { tool, args };
    backend.faults.failReads = [table];
    await handler(textUpdate(9310, "how are we doing?"));
    assertEquals(lastReply(), figuresUnavailableMessage());
    assertEquals(capturedIntake().length, 0);
  });
}

// A broker's uninvested cash is never where an expense was paid from: "paid
// on Wio" must not land in the broker's funds account (SHR-367).
Deno.test("a broker funds account is never offered for spending", () => {
  assertEquals(isSpendingAccount({ type: "broker_funds" }), false);
  assertEquals(isSpendingAccount({ type: "checking" }), true);
  assertEquals(isSpendingAccount({ type: "credit_card" }), true);
});

// The AI service answers "too many requests" now and then, for a second or
// so. A question asked in that second was filed in the Inbox as an expense,
// with a reply that said nothing had gone wrong (SHR-373).
function aiCalls(): Array<[unknown, unknown]> {
  return backend.tables.telegram_call_log.map((r) => [r.call_kind, r.error_type]);
}

freshTest("a question asked while the AI service is briefly busy is still answered", async () => {
  backend.tables.holdings = [{ id: "a9100000-0000-4000-8000-0000000000d1", household_id: HOUSEHOLD, name: "Fund", asset_class: "equity", value_aed: 100, is_shared: true, owner_member_id: null }];
  backend.route = { tool: "get_net_worth", args: {} };
  backend.faults.aiBusyFirst = 1;
  await handler(textUpdate(7301, "whats our networth?"));
  assertEquals(capturedIntake().length, 0);
  assertEquals(lastReply(), "Done.");
  assertEquals(aiCalls().slice(0, 2), [["classify_and_route", "http_429"], ["classify_and_route", null]]);
});

freshTest("a message the AI service cannot read even on a second try is kept, and the reply says so", async () => {
  backend.faults.aiBusyFirst = 4;
  await handler(textUpdate(7302, "whats our networth?"));
  assertEquals(capturedIntake().length, 1);
  assertEquals(lastReply(), "I couldn't read that just now, so it's saved in the Inbox. If it was a question, ask again in a minute.");
  assertEquals(aiCalls(), [["classify_and_route", "http_429"], ["classify_and_route", "http_429"], ["parse_intake", "http_429"], ["parse_intake", "http_429"]]);
});

freshTest("an expense read while routing was busy gets the ordinary reply", async () => {
  backend.faults.aiBusyFirst = 2;
  backend.parse = [{ merchant: "Cafe", amount: 40, currency: "AED", occurred_at: "2026-09-24", date_stated: true, source: "typed", category: null, card_last4: null, account_hint: null, confidence: 1, kind: "expense" }];
  await handler(textUpdate(7303, "spent 40 at cafe"));
  assertEquals(capturedIntake().length, 1);
  assertEquals(capturedIntake()[0].parsed_amount, 40);
  assert(!lastReply().includes("couldn't read"), lastReply());
});

freshTest("an AI service that answers at once is asked once for each step", async () => {
  backend.parse = [{ merchant: "Cafe", amount: 40, currency: "AED", occurred_at: "2026-09-24", date_stated: true, source: "typed", category: null, card_last4: null, account_hint: null, confidence: 1, kind: "expense" }];
  await handler(textUpdate(7304, "spent 40 at cafe"));
  assertEquals(aiCalls(), [["classify_and_route", null], ["parse_intake", null]]);
});

// ---------------------------------------------------------------------------
// Share trades by message (SHR-370)
// ---------------------------------------------------------------------------

const ABC = "a3700000-0000-4000-8000-0000000000a1";
const USD_FUND = "a3700000-0000-4000-8000-0000000000f1";

// ABC, held by the sender at 15 shares, bought through their dollar fund.
function tradeFixtures(): void {
  backend.tables.holdings = [{
    id: ABC, household_id: HOUSEHOLD, name: "ABC", currency: "USD", asset_class: "us_equity", price_symbol: "ABC",
    price_provider: "twelvedata", owner_member_id: MEMBER, funds_account_id: USD_FUND, trades_version: 3, quantity: 15,
    current_price: 150, is_shared: false, value_aed: 8263.13,
  }];
  backend.tables.accounts.push({
    id: USD_FUND, household_id: HOUSEHOLD, name: "Dollar broker funds", type: "broker_funds", currency: "USD",
    owner_member_id: MEMBER, is_shared: false, archived_at: null, balance: 1000,
  });
}

freshTest("a share bought by message goes to the trade preview, never the Inbox", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC", units: 10, price: 120 } };
  await handler(textUpdate(7401, "bought 10 ABC at 120"));
  assertEquals(capturedIntake().length, 0);
  const preview = backend.rpcCalls.find((c) => c.fn === "preview_trade");
  assert(preview, "preview_trade was never called");
  assertEquals([preview.args.p_holding_id, preview.args.p_kind, preview.args.p_units, preview.args.p_price], [ABC, "buy", 10, 120]);
});

freshTest("a trade dated after today is refused before any preview", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC", units: 10, price: 120, trade_date: "2099-11-30" } };
  await handler(textUpdate(7402, "bought 10 ABC at 120 on 30 Nov 2099"));
  assert(lastReply().startsWith("That date hasn't happened yet"), lastReply());
  assertEquals(backend.rpcCalls.filter((c) => c.fn.startsWith("preview")).length, 0);
  assertEquals(capturedIntake().length, 0);
  assertEquals(backend.tables.bot_proposals.length, 0);
});

freshTest("a sale of a stock not held says so and saves nothing", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "sell", stock: "XYZ", units: 2, price: 50 } };
  await handler(textUpdate(7403, "sold 2 XYZ at 50"));
  assertEquals(lastReply(), "You don't hold XYZ, so nothing was saved.");
  assertEquals(capturedIntake().length, 0);
  assertEquals(backend.tables.bot_proposals.length, 0);
});

freshTest("the router is told a share trade is log_trade, never an expense", async () => {
  await handler(textUpdate(7404, "spent 40 on lunch"));
  assert(backend.routerPrompts[0]?.includes("call log_trade"), backend.routerPrompts[0]);
});

// The member's trade still being asked about, if any.
function askingRow(): Row | undefined {
  return backend.tables.bot_proposals.find((r) => r.kind === "trade" && r.status === "asking");
}

function tradeProposals(): Row[] {
  return backend.tables.bot_proposals.filter((r) => r.kind === "trade" && r.status !== "asking");
}

freshTest("a trade with no units asks how many, and the answer completes it", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC", price: 120 } };
  await handler(textUpdate(7411, "bought ABC at 120"));
  assertEquals(lastReply(), "How many ABC did you buy?");
  const asked = askingRow();
  assert(asked, "no asking draft was kept");
  await handler(replyUpdate(7412, "10", Number(asked.prompt_message_id)));
  const preview = backend.rpcCalls.find((c) => c.fn === "preview_trade");
  assertEquals([preview?.args.p_units, preview?.args.p_price], [10, 120]);
  assertEquals(tradeProposals().map((r) => r.status), ["proposed"]);
  assertEquals(askingRow(), undefined);
  assert(lastReply().startsWith("Buy 10 ABC at $120"), lastReply());
});

freshTest("a trade with no price asks for it, and the next message answers it", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC", units: 10 } };
  await handler(textUpdate(7413, "bought 10 ABC"));
  assertEquals(lastReply(), "At what price per share, in dollars?");
  await handler(textUpdate(7414, "120"));
  assertEquals(backend.rpcCalls.find((c) => c.fn === "preview_trade")?.args.p_price, 120);
  assertEquals(tradeProposals().length, 1);
});

freshTest("two lots of one stock are asked about by number", async () => {
  tradeFixtures();
  const second = "a3700000-0000-4000-8000-0000000000a2";
  backend.tables.holdings.push({ ...backend.tables.holdings[0], id: second, name: "ABC lot 2", quantity: 5 });
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC", units: 1, price: 120 } };
  await handler(textUpdate(7415, "bought 1 ABC at 120"));
  assert(lastReply().includes("1. ") && lastReply().includes("2. "), lastReply());
  await handler(textUpdate(7416, "2"));
  assertEquals(backend.rpcCalls.find((c) => c.fn === "preview_trade")?.args.p_holding_id, second);
});

freshTest("a price in dirhams for a dollar share is asked again in dollars, never converted", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC", units: 10, price: 1500, currency: "AED" } };
  await handler(textUpdate(7417, "bought 10 ABC at AED 1500"));
  assertEquals(lastReply(), "ABC trades in dollars. What was the price per share in dollars?");
  await handler(textUpdate(7418, "130"));
  assertEquals(backend.rpcCalls.find((c) => c.fn === "preview_trade")?.args.p_price, 130);
});

freshTest("a message that does not answer the question is its own message; a reply that does not is told what is needed", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC", price: 120 } };
  await handler(textUpdate(7419, "bought ABC at 120"));
  const asked = askingRow();
  backend.route = { tool: "log_expense", args: {} };
  await handler(textUpdate(7420, "spent 40 on lunch"));
  assertEquals(capturedIntake().length, 1);
  assert(askingRow(), "the draft was dropped by an unrelated message");
  await handler(replyUpdate(7421, "lunch", Number(asked!.prompt_message_id)));
  assertEquals(lastReply(), "I need a number, like 10 or 2.5.");
  assertEquals(capturedIntake().length, 1);
});

freshTest("an answer Telegram delivers twice fills its question once, and the next question is asked again", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC" } };
  await handler(textUpdate(7422, "bought ABC"));
  assertEquals(lastReply(), "How many ABC did you buy?");
  await handler(textUpdate(7423, "10"));
  assertEquals(lastReply(), "At what price per share, in dollars?");
  // The run failed after answering, so Telegram delivers "10" again.
  backend.log.get(7423)!.status = "failed";
  await handler(textUpdate(7423, "10"));
  assertEquals(lastReply(), "At what price per share, in dollars?");
  const draft = (askingRow()!.payload as Row).draft as Row;
  assertEquals([draft.units, draft.price], [10, null]);
  assertEquals(backend.rpcCalls.filter((c) => c.fn === "preview_trade").length, 0);
});

freshTest("the answer that completes a trade, delivered twice, proposes it once", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC", price: 120 } };
  await handler(textUpdate(7424, "bought ABC at 120"));
  await handler(textUpdate(7425, "10"));
  backend.log.get(7425)!.status = "failed";
  backend.route = { tool: "log_expense", args: {} };
  await handler(textUpdate(7425, "10"));
  assertEquals(tradeProposals().length, 1);
  assertEquals(capturedIntake().length, 0);
});

freshTest("a bare yes while a trade is still being asked about applies nothing", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC", price: 120 } };
  await handler(textUpdate(7426, "bought ABC at 120"));
  await handler(textUpdate(7427, "yes"));
  assertEquals(backend.applyCalls, 0);
  assert(askingRow(), "the draft was dropped by a bare yes");
  assertEquals(tradeProposals().length, 0);
});

const TRADE_PARTNER = "a3700000-0000-4000-8000-0000000000b2";
const XYZ = "a3700000-0000-4000-8000-0000000000a3";

// Partner holds XYZ, bought through their own dollar fund.
function partnerFixtures(): void {
  backend.tables.household_members.push({ id: TRADE_PARTNER, household_id: HOUSEHOLD, display_name: "Partner", telegram_user_id: null, role: "member" });
  backend.tables.holdings.push({ ...backend.tables.holdings[0], id: XYZ, name: "XYZ", price_symbol: "XYZ", owner_member_id: TRADE_PARTNER, funds_account_id: "a3700000-0000-4000-8000-0000000000f2" });
  backend.tables.accounts.push({
    id: "a3700000-0000-4000-8000-0000000000f2", household_id: HOUSEHOLD, name: "Partner's dollar funds", type: "broker_funds",
    currency: "USD", owner_member_id: TRADE_PARTNER, is_shared: false, archived_at: null, balance: 1000,
  });
}

async function sixABCSoldOn27Oct(updateId: number): Promise<void> {
  backend.route = { tool: "log_trade", args: { side: "sell", stock: "ABC", units: 6, price: 150, trade_date: "2026-10-27", brokerage: 1 } };
  await handler(textUpdate(updateId, "sold 6 ABC at 150 on 27 Oct, brokerage 1"));
}

freshTest("the three trades are confirmed with the database's figures, in the spec's words", async () => {
  tradeFixtures();
  partnerFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC", units: 10, price: 182.5 } };
  await handler(textUpdate(7501, "bought 10 ABC at 182.5"));
  const buy = lastReply().split("\n");
  assert(buy[0].startsWith("Buy 10 ABC at $182.50 on "), buy[0]);
  assertEquals(buy.slice(1, 3), ["ABC: 15 → 25 shares, average $110 → $139", "Dollar broker funds −$1,825"]);
  backend.route = { tool: "log_trade", args: { side: "sell", stock: "ABC", units: 2, price: 430, trade_date: "2026-10-24", brokerage: 1 } };
  await handler(textUpdate(7502, "sold 2 ABC at 430 on 24 Oct, brokerage 1"));
  assertEquals(lastReply().split("\n").slice(0, 3), ["Sell 2 ABC at $430 on 24 Oct, brokerage $1", "ABC: 15 → 13 shares, average stays $110", "Profit $639 · Dollar broker funds +$859"]);
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "XYZ", units: 3, price: 690, member: "Partner" } };
  await handler(textUpdate(7503, "Partner bought 3 XYZ at 690"));
  assert(lastReply().split("\n")[1].startsWith("Partner's XYZ: 15 → 18 shares"), lastReply());
  assert(lastReply().includes("Partner's dollar funds −$2,070"), lastReply());
  assertEquals(tradeProposals().length, 3);
});

freshTest("yes saves the trade once and says what was saved", async () => {
  tradeFixtures();
  await sixABCSoldOn27Oct(7511);
  await handler(textUpdate(7512, "yes"));
  assertEquals(backend.applyCalls, 1);
  assertEquals(lastReply(), "Saved: Sell 6 ABC at $150 on 27 Oct. ABC now 9 shares; Dollar broker funds +$899.");
  await handler(textUpdate(7513, "yes"));
  assert(lastReply().startsWith("Already saved: Sell 6 ABC at $150 on 27 Oct."), lastReply());
});

freshTest("no drops the trade and says which", async () => {
  tradeFixtures();
  await sixABCSoldOn27Oct(7514);
  await handler(textUpdate(7515, "no"));
  assertEquals(lastReply(), "Dropped the sale of 6 ABC at $150. Nothing was saved.");
  assertEquals(backend.applyCalls, 0);
});

freshTest("a yes after the holding changed saves nothing and confirms again with today's figures", async () => {
  tradeFixtures();
  await sixABCSoldOn27Oct(7516);
  backend.tradeOutcome = { outcome: "stale" };
  await handler(textUpdate(7517, "yes"));
  const sent = backend.telegramSent.map((m) => String(m.body.text));
  assertEquals(sent.at(-2), "ABC changed since I asked, so nothing was saved. Here it is again with today's figures:");
  assert(sent.at(-1)!.startsWith("Sell 6 ABC at $150 on 27 Oct"), sent.at(-1));
  assertEquals(tradeProposals().map((r) => r.status), ["expired", "proposed"]);
});

freshTest("a yes after the confirmation lapsed confirms again with today's figures", async () => {
  tradeFixtures();
  await sixABCSoldOn27Oct(7518);
  backend.tradeOutcome = { outcome: "expired" };
  await handler(textUpdate(7519, "yes"));
  assert(lastReply().startsWith("Sell 6 ABC at $150 on 27 Oct"), lastReply());
  assertEquals(tradeProposals().filter((r) => r.status === "proposed").length, 1);
});

freshTest("a trade the database refuses on yes says why, and saves nothing", async () => {
  tradeFixtures();
  await sixABCSoldOn27Oct(7520);
  backend.tradeOutcome = { outcome: "refused", error: "exceeds_units" };
  await handler(textUpdate(7521, "yes"));
  assertEquals(lastReply(), "That sells more ABC than was held on that date (6), so nothing was saved.");
});

freshTest("a first buy of a stock is previewed as a new holding, with its feed and fund shown", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "XYZ", units: 3, price: 690, currency: "USD" } };
  await handler(textUpdate(7522, "bought 3 XYZ at $690"));
  const preview = backend.rpcCalls.find((c) => c.fn === "preview_new_holding_trade");
  assert(preview, "the new holding was not previewed");
  assertEquals((preview.args.p_new_holding as Row).price_symbol, "XYZ");
  assert(lastReply().includes("New holding: XYZ (US equity, priced by Twelve Data as XYZ), paid from Dollar broker funds"), lastReply());
  assertEquals(((tradeProposals()[0].payload as Row).new_holding as Row).name, "XYZ");
});

freshTest("a first buy with no broker fund in its currency says one is needed", async () => {
  tradeFixtures();
  backend.tables.accounts = backend.tables.accounts.filter((a) => a.id !== USD_FUND);
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "XYZ", units: 3, price: 690, currency: "USD" } };
  await handler(textUpdate(7523, "bought 3 XYZ at $690"));
  assertEquals(lastReply(), "There's no broker funds account for XYZ's money to come from or go to, so nothing was saved. Add one in Wealth, then send the trade again.");
  assertEquals(tradeProposals().length, 0);
});
