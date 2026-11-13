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

export const SUPABASE_URL = "http://supabase.test";
export const TOKEN = "123456:SYNTHETIC-TEST-TOKEN-not-real";
export const SECRET = "test-webhook-secret";
export const LEASE_MS = 3 * 60 * 1000;

export const HOUSEHOLD = "11111111-1111-4111-8111-111111111111";
export const MEMBER = "22222222-2222-4222-8222-222222222222";
export const GOAL = "55555555-5555-4555-8555-555555555555";
export const TELEGRAM_USER = 424242;

// ---------------------------------------------------------------------------
// The fake backend
// ---------------------------------------------------------------------------

export type Row = Record<string, unknown>;

export type Backend = {
  now: number;
  tables: Record<string, Row[]>;
  log: Map<number, { status: string; claimed_at: number; attempts: number; answer_target?: Row | null }>;
  telegramSent: Array<{ method: string; body: Row }>;
  telegramDeleted: number[];
  // Every other Telegram call (answerCallbackQuery, editMessageText, ...).
  telegramCalls: Array<{ method: string; body: Row }>;
  requests: Array<{ method: string; path: string }>;
  faults: {
    // Make claim_telegram_update fail the way a live database can.
    claimError?: { code: string; message: string };
    // Make Telegram fail: on every call, or only the first N sendMessage calls.
    telegramDns?: boolean;
    failFirstSends?: number;
    // Telegram answers ok:false (a 429, say): nothing is sent, nothing thrown.
    refuseFirstSends?: number;
    // Telegram refuses these chats for good (403: the member blocked the bot).
    blockedChats?: number[];
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
    // A link code expires the moment it has been looked up, as one can
    // between the lookup and the redemption.
    expireLinkCodeAfterLookup?: boolean;
    // Inserting a message's second and later items into intake fails.
    failIntakeItems?: boolean;
    // Telegram's getFile refuses (a 429) or says the file is too big for a bot.
    getFile?: "refuse" | "too_big";
    // Downloading the file, or storing it, fails.
    downloadFails?: boolean;
    storageFails?: boolean;
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
  parseRaw?: unknown;
  parsePrompts: string[];
  // What the phrasing call was given: the tool's result, among other things.
  phrasePrompts: string[];
  applyCalls: number;
  approveCalls: number;
  // Database functions that answer with an error, as a failed call would.
  failRpc?: Set<string>;
  // Runs on each AI call: something changing in Rokda while a message is read.
  onAiCall?: () => void;
};

export let backend: Backend;
export let sendCount = 0;

export function reset(): void {
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
      holding_dividends: [],
    },
    log: new Map(),
    telegramSent: [],
    telegramDeleted: [],
    telegramCalls: [],
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
export const UNIQUE: Record<string, string[]> = {
  intake: ["household_id", "source", "source_ref"],
  goal_contributions: ["goal_id", "source", "source_ref"],
  bot_proposals: ["household_id", "source_ref"],
  statement_reconciliations: ["account_id", "statement_date"],
};

// Column defaults the real schema fills in. A proposal's times are on the
// real clock, because the handler compares them with Date.now().
export const DEFAULTS: Record<string, () => Row> = {
  bot_proposals: () => ({
    status: "proposed",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    prompt_message_id: null,
    decided_at: null,
    result: null,
  }),
  statement_reconciliations: () => ({ status: "waiting", asked_prompts: [], last_asked_on: null, closed_at: null, closed_by_member_id: null }),
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// One PostgREST condition, "op.value", on one cell.
export function cellMatches(cell: unknown, op: string, value: string): boolean {
  switch (op) {
    case "eq":
      return String(cell) === value;
    case "gt":
      return cell != null && String(cell) > value;
    case "lt":
      return cell != null && String(cell) < value;
    case "cs": {
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

export function matches(row: Row, params: URLSearchParams): boolean {
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

export function violatesUnique(table: string, row: Row): boolean {
  const key = UNIQUE[table];
  if (!key || (key.includes("source_ref") && row.source_ref == null)) return false;
  return backend.tables[table].some((r) => key.every((k) => r[k] === row[k]));
}

export async function postgrest(req: Request, url: URL): Promise<Response> {
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
    // Claims live in backend.log (see PATCH below).
    if (table === "telegram_update_log") {
      const id = Number((url.searchParams.get("update_id") ?? "").replace(/^eq\./, ""));
      const entry = backend.log.get(id);
      const found = entry ? [{ update_id: id, status: entry.status, answer_target: entry.answer_target ?? null }] : [];
      if (wantsObject) return found.length === 1 ? json(found[0]) : json({ code: "PGRST116", message: "not one row" }, 406);
      return json(found);
    }
    let found = rows.filter((r) => matches(r, url.searchParams));
    if (table === "household_members" && backend.faults.expireLinkCodeAfterLookup && url.searchParams.has("telegram_link_code")) {
      const result = found.map((r) => ({ ...r }));
      for (const r of found) r.telegram_link_code_expires_at = "2000-01-01T00:00:00Z";
      found = result;
    }
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
      if (table === "intake" && backend.faults.failIntakeItems && String(r.source_ref ?? "").includes("#")) {
        return json({ code: "57014", message: "canceling statement due to statement timeout" }, 500);
      }
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
      // What a bare answer resolved to, recorded once (answer_target=is.null).
      if (entry && "answer_target" in patch) {
        if (backend.faults.failWrites?.includes(table)) return json({ code: "57014", message: "canceling statement due to statement timeout" }, 500);
        if (url.searchParams.get("answer_target") !== "is.null" || entry.answer_target == null) entry.answer_target = patch.answer_target;
      }
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
export function claim(updateId: number): string {
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
export function applyProposal(id: string, memberId: string): Row {
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
    const effect = p.kind === "trade_undo"
      ? (backend.previews.preview_delete_trade ?? UNDO_EFFECT)
      : { ...tradePreview({ p_kind: payload.kind, p_units: payload.units, p_price: payload.price, p_fees: payload.fees }), trade_id: crypto.randomUUID() };
    p.status = "applied";
    p.result = { kind: p.kind, effect };
    return { outcome: "applied", kind: p.kind, effect };
  }
  // The morning question about dividends: every line received, or none.
  // Stale when the fund's confirmation or any line moved on since, or when a
  // question about the confirmed balance was applied without its answer.
  if (p.kind === "dividends_received") {
    const fund = backend.tables.accounts.find((a) => a.id === payload.fund_id);
    const lines = (payload.lines as Row[]) ?? [];
    const rows = lines.map((l) => backend.tables.holding_dividends.find((d) => d.id === l.dividend_id));
    p.decided_at = new Date().toISOString();
    const stale = !fund || String(fund.balance_as_of ?? null) !== String(payload.confirmation ?? null) ||
      rows.some((d, i) => !d || d.version !== lines[i].version || d.status !== "earned") || (payload.ask != null && payload.answer == null);
    if (stale) {
      p.status = "expired";
      p.result = { kind: p.kind, error: "stale" };
      return { outcome: "stale", kind: p.kind };
    }
    const included = payload.ask === "already_included" && payload.answer === "included";
    const saved = rows.map((d, i) => {
      d!.status = "received";
      d!.version = Number(d!.version) + 1;
      const moved = included ? 0 : Number(d!.expected_net);
      fund!.balance = Number(fund!.balance) + moved;
      return { ...lines[i], net: d!.expected_net, moved };
    });
    const result = {
      kind: p.kind, lines: saved, total: saved.reduce((t, l) => t + Number(l.net), 0), moved: saved.reduce((t, l) => t + l.moved, 0),
    };
    Object.assign(p, { status: "applied", result });
    // Every other question still open about any of these is answered.
    const ids = new Set(lines.map((l) => String(l.dividend_id)));
    for (const o of backend.tables.bot_proposals) {
      if (o.id === p.id || o.kind !== "dividends_received" || o.status !== "proposed") continue;
      if (!((o.payload as Row).lines as Row[]).some((l) => ids.has(String(l.dividend_id)))) continue;
      Object.assign(o, { status: "expired", decided_at: new Date().toISOString(), result: { kind: o.kind, error: "answered" } });
    }
    return { outcome: "applied", ...result };
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
    } else if (bill.active === false || bill.autopay !== true) {
      // Closed, with every copy of it: nothing will ask about it again.
      const skippedNow = [{ recurring_id: bill.id, name: bill.name, reason: "not_autopay" }];
      for (const q of backend.tables.bot_proposals) {
        if (q.kind === "autopay_payment" && q.status === "proposed" && (q.payload as Row).recurring_id === bill.id && (q.payload as Row).due_date === payload.due_date) {
          Object.assign(q, { status: "expired", decided_at: new Date().toISOString(), result: { kind: p.kind, applied: [], skipped: skippedNow } });
        }
      }
      return { outcome: "not_autopay", kind: p.kind, applied: [], skipped: skippedNow };
    } else if ("account_id" in payload && (bill.account_id !== payload.account_id || (bill.category_id ?? null) !== (payload.category_id ?? null))) {
      // Left open, unrecorded: asked again about the bill as it is now.
      return { outcome: "changed", kind: p.kind, applied: [], skipped: [{ recurring_id: bill.id, name: bill.name, reason: "changed" }] };
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

// Undoing the sale of 6 ABC at 150: back from 9 shares to 15, the fund down 899.
export const UNDO_EFFECT: Row = {
  ok: true, trade_id: "t-sale", trades_version: 6, units_before: 9, avg_before: 110, holding_units_after: 15,
  holding_avg_after: 110, funds_account_id: "a3700000-0000-4000-8000-0000000000f1", funds_delta: -899,
};

// A trade preview as the database answers one, from the trade asked about:
// ABC held at 15 shares averaging 110, its dollar fund at 1,000.
export function tradePreview(args: Row): Row {
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

export async function rpc(req: Request, fn: string): Promise<Response> {
  const args = await req.json().catch(() => ({}));
  backend.rpcCalls.push({ fn, args });
  if (fn === "preview_trade") return json(backend.previews.preview_trade ?? tradePreview(args));
  if (fn === "preview_delete_trade") return json(backend.previews.preview_delete_trade ?? UNDO_EFFECT);
  if (fn === "preview_new_holding_trade") {
    const holding = args.p_new_holding as Row;
    if (!holding?.funds_account_id) return json({ ok: false, error: "fund_required" });
    return json(backend.previews.preview_new_holding_trade ?? {
      ...tradePreview({ ...args, p_kind: "buy", p_funds_account_id: holding.funds_account_id }),
      trades_version: 1, units_before: 0, avg_before: null, holding_units_after: Number(args.p_units), holding_avg_after: Number(args.p_price),
      new_holding: true,
    });
  }
  if (backend.failRpc?.has(fn)) return json({ code: "57014", message: "canceling statement due to statement timeout" }, 500);
  if (fn === "get_telegram_webhook_secret") return json(SECRET);
  // As the real function: cancels the question and clears its dividends'
  // asked marks together, or neither.
  if (fn === "postpone_dividends_proposal") {
    const p = backend.tables.bot_proposals.find((r) => r.id === args.p_proposal_id);
    if (!p) return json({ ok: false, status: "not_found" });
    if (p.member_id !== args.p_member_id) return json({ ok: false, status: "not_yours" });
    if (p.status !== "proposed") return json({ ok: false, status: p.status, result: p.result });
    Object.assign(p, { status: "cancelled", decided_at: new Date().toISOString(), result: { kind: "dividends_received", not_yet: true } });
    const ids = ((p.payload as Row).lines as Row[]).map((l) => String(l.dividend_id));
    for (const d of backend.tables.holding_dividends ?? []) if (ids.includes(String(d.id))) d.asked_at = null;
    return json({ ok: true });
  }
  if (fn === "apply_bot_proposal") {
    backend.applyCalls += 1;
    return json(applyProposal(String(args.p_proposal_id), String(args.p_member_id)));
  }
  if (fn === "approve_intake") {
    backend.approveCalls += 1;
    // As the real function: one transaction per entry, and an entry already
    // approved answers with the one it made.
    const row = backend.tables.intake.find((r) => r.id === args.p_intake_id);
    if (!row) return json({ code: "P0002", message: "intake row not found" }, 400);
    if (row.status === "rejected") return json({ code: "P0001", message: "intake row was already rejected" }, 400);
    if (row.status === "approved") return json({ transaction_id: row.transaction_id ?? null, already_approved: true });
    const tx = { id: crypto.randomUUID(), household_id: row.household_id, account_id: args.p_account_id, amount: args.p_amount, kind: args.p_kind, merchant: args.p_merchant, occurred_at: args.p_occurred_at, category_id: args.p_category_id };
    backend.tables.transactions.push(tx);
    Object.assign(row, { status: "approved", transaction_id: tx.id });
    return json({ transaction_id: tx.id, already_approved: false });
  }
  if (fn === "mark_dividends_asked") {
    for (const d of backend.tables.holding_dividends ?? []) {
      if ((args.p_ids as string[]).includes(String(d.id))) d.asked_at = args.p_asked === false ? null : new Date().toISOString();
    }
    return json(null);
  }
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
export function denoStyleFetchError(url: string): TypeError {
  return new TypeError("fetch failed", {
    cause: new Error(`error sending request for url (${url}): client error (Connect): dns error`),
  });
}

export async function telegram(req: Request, url: URL): Promise<Response> {
  const method = url.pathname.split("/").pop() ?? "";
  if (backend.faults.telegramDns) throw denoStyleFetchError(url.toString());
  // A file's bytes, from Telegram's file server.
  if (url.pathname.startsWith("/file/")) {
    if (backend.faults.downloadFails) return new Response("bad gateway", { status: 502 });
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { "Content-Type": "image/jpeg" } });
  }
  if (method === "getFile") {
    if (backend.faults.getFile === "refuse") return json({ ok: false, error_code: 429, description: "Too Many Requests: retry after 5" });
    if (backend.faults.getFile === "too_big") return json({ ok: false, error_code: 400, description: "Bad Request: file is too big" });
    return json({ ok: true, result: { file_id: "F1", file_path: "photos/file_1.jpg" } });
  }
  const body = await req.json().catch(() => ({}));
  if (method === "sendMessage") {
    sendCount += 1;
    if (backend.faults.failFirstSends && sendCount <= backend.faults.failFirstSends) {
      throw denoStyleFetchError(url.toString());
    }
    if (backend.faults.refuseFirstSends && sendCount <= backend.faults.refuseFirstSends) {
      return json({ ok: false, error_code: 429, description: "Too Many Requests: retry after 5" });
    }
    if (backend.faults.blockedChats?.includes(Number(body.chat_id))) {
      return json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
    }
    backend.telegramSent.push({ method, body });
    return json({ ok: true, result: { message_id: 1000 + sendCount } });
  }
  if (method === "deleteMessage") backend.telegramDeleted.push(Number(body.message_id));
  else backend.telegramCalls.push({ method, body });
  return json({ ok: true, result: {} });
}

export async function openrouter(req: Request): Promise<Response> {
  const body = await req.json();
  backend.aiCalls += 1;
  backend.onAiCall?.();
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
    // A reading in a shape of the test's own, to stand for an answer the
    // parser cannot use.
    if (backend.parseRaw) {
      return json({ choices: [{ message: { content: JSON.stringify(backend.parseRaw) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
    if (backend.parse) {
      return json({ choices: [{ message: { content: JSON.stringify({ items: backend.parse }) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
  }
  backend.phrasePrompts.push(text);
  return json({ choices: [{ message: { content: "Done." } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
}

export const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  backend.requests.push({ method: req.method, path: url.pathname });
  if (url.origin === SUPABASE_URL) {
    if (url.pathname.startsWith("/rest/v1/rpc/")) return await rpc(req, url.pathname.split("/").pop()!);
    if (url.pathname.startsWith("/rest/v1/")) return await postgrest(req, url);
    if (url.pathname.startsWith("/storage/")) {
      if (backend.faults.storageFails) return json({ statusCode: "500", error: "internal", message: "storage unavailable" }, 500);
      return json({ Key: "ok" });
    }
  }
  if (url.hostname === "api.telegram.org") return await telegram(req, url);
  if (url.hostname === "openrouter.ai") return await openrouter(req);
  return json({ message: `unmodelled request ${req.method} ${url}` }, 404);
}) as typeof fetch;

// Capture the handler instead of starting a server, and every line the
// handler logs, so a test can assert on exactly what would reach the logs.
export let handler: (req: Request) => Promise<Response>;
(Deno as unknown as { serve: unknown }).serve = (h: typeof handler) => {
  handler = h;
  return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
};
export const logged: string[] = [];
export const realError = console.error;
console.error = (...args: unknown[]) => {
  logged.push(args.map(String).join(" "));
};
// Restore both for anything that runs after the test file in this isolate.
addEventListener("unload", () => {
  globalThis.fetch = realFetch;
  console.error = realError;
});

Deno.env.set("SUPABASE_URL", SUPABASE_URL);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-test");
Deno.env.set("TELEGRAM_BOT_TOKEN", TOKEN);
Deno.env.set("OPENROUTER_API_KEY", "openrouter-test");

reset();
export const { accountsForCheckin, buildBalanceCheckinMessage, datedItems, sendablePeriod, figuresUnavailableMessage, forwardedDay, inboxReason, isSpendingAccount, pickAccountByHint, pickCheckinAccount, proposalOutcomeMessage, transferDraftFrom, undatedNote } = await import("../index.ts");
assert(handler!, "index.ts did not register a handler with Deno.serve");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function textUpdate(updateId: number, text: string): Request {
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

// A photo, with or without a caption.
export function photoUpdate(updateId: number, caption?: string): Request {
  return new Request("http://edge.test/telegram-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": SECRET },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: 2, date: 1, ...(caption ? { caption } : {}), photo: [{ file_id: "F0" }, { file_id: "F1" }],
        chat: { id: TELEGRAM_USER, type: "private" }, from: { id: TELEGRAM_USER, is_bot: false, first_name: "T" },
      },
    }),
  });
}

// A message sent as a Telegram reply to one of the bot's messages.
export function replyUpdate(updateId: number, text: string, replyTo: number, replyToText?: string): Request {
  return new Request("http://edge.test/telegram-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": SECRET },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: 2,
        date: 1,
        text,
        // Telegram sends the message replied to with the reply, its text included.
        reply_to_message: { message_id: replyTo, ...(replyToText != null ? { text: replyToText } : {}) },
        chat: { id: TELEGRAM_USER, type: "private" },
        from: { id: TELEGRAM_USER, is_bot: false, first_name: "T" },
      },
    }),
  });
}

// A tap on one of the buttons under a bot message.
export function tapUpdate(updateId: number, messageId: number, data: string, fromId = TELEGRAM_USER): Request {
  return new Request("http://edge.test/telegram-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": SECRET },
    body: JSON.stringify({
      update_id: updateId,
      callback_query: {
        id: `cb-${updateId}`,
        from: { id: fromId, is_bot: false, first_name: "T" },
        message: { message_id: messageId, date: 1, chat: { id: fromId, type: "private" }, text: "" },
        data,
      },
    }),
  });
}

// A reaction placed on one of the bot's messages.
export function reactionUpdate(updateId: number, messageId: number, emoji: string): Request {
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

export function capturedIntake(): Row[] {
  return backend.tables.intake;
}

export function lastReply(): string {
  return String(backend.telegramSent.at(-1)?.body.text ?? "");
}

export function assertNoTokenLeaked(): void {
  for (const line of logged) {
    assert(!line.includes(TOKEN), `bot token reached the log: ${line}`);
    assert(!line.includes("SYNTHETIC-TEST-TOKEN"), `part of the bot token reached the log: ${line}`);
  }
}

export function freshTest(name: string, fn: () => Promise<void>): void {
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


export const MARRIOTT = { id: "66666666-6666-4666-8666-666666666666", household_id: HOUSEHOLD, name: "ENBD Marriott •0001", archived_at: null };

export const NOON = { id: "77777777-7777-4777-8777-777777777777", household_id: HOUSEHOLD, name: "ENBD Noon •0002", archived_at: null };

export const FAB_Z = { id: "88888888-8888-4888-8888-888888888888", household_id: HOUSEHOLD, name: "FAB Z •0003", archived_at: null };

export const FAB = { id: "99999999-9999-4999-8999-999999999999", household_id: HOUSEHOLD, name: "FAB", archived_at: null };


export const PARTNER = "33333333-3333-4333-8333-333333333333";

export const ROSTER = [
  { id: MEMBER, display_name: "Alex", telegram_user_id: TELEGRAM_USER },
  { id: PARTNER, display_name: "Sam", telegram_user_id: null },
];

export const acct = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, household_id: HOUSEHOLD, name, type: "checking", currency: "AED", balance: 0, balance_as_of: null, owner_member_id: MEMBER, is_shared: false, archived_at: null, ...over,
});

export const MY_BANK = acct("a0000000-0000-4000-8000-000000000001", "Bank");

export const SAM_BANK = acct("a0000000-0000-4000-8000-000000000002", "Bank", { owner_member_id: PARTNER });

export const CARD = acct("a0000000-0000-4000-8000-000000000003", "Card •0004", { type: "credit_card" });

export const EPF = acct("a0000000-0000-4000-8000-000000000004", "EPF", { type: "investment", currency: "INR" });

export const FD = acct("a0000000-0000-4000-8000-000000000005", "Term deposit", { type: "fd" });

export const MY_CURRENT = acct("a0000000-0000-4000-8000-000000000006", "Alex Current");


export const EMI = "a7000000-0000-4000-8000-0000000000e1";

export const BANK = "a7000000-0000-4000-8000-0000000000b1";

export function dubaiToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function dailyCheck(): Request {
  return new Request("http://edge.test/telegram-webhook?run_recurring_check=1", {
    method: "GET",
    headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET },
  });
}


// A day this many days before today in Dubai, as stored.
export function dubaiDaysAgo(n: number): string {
  const [y, m, d] = dubaiToday().split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d - n));
  return day.toISOString().slice(0, 10);
}


export const PARTNER_TELEGRAM = 535353;

// A message or reaction from the partner, in the partner's own chat.
export function partnerUpdate(updateId: number, body: Row): Request {
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

export const GROCERIES = "a9100000-0000-4000-8000-0000000000c1";


// `count` expenses of AED `amount` each on `day`, after any already there.
export function seedExpenses(count: number, day: string, amount: number, prefix: string): void {
  for (let i = 0; i < count; i++) {
    backend.tables.transactions.push({
      id: `${prefix}-${String(i).padStart(5, "0")}`, household_id: HOUSEHOLD, account_id: "a9100000-0000-4000-8000-0000000000a1",
      category_id: GROCERIES, amount: -amount, kind: "expense", occurred_at: day, is_shared: true, owner_member_id: null, merchant: "Shop",
    });
  }
}

export function thisMonthFirst(): string {
  return `${dubaiToday().slice(0, 8)}01`;
}


// The AI service answers "too many requests" now and then, for a second or
// so. A question asked in that second was filed in the Inbox as an expense,
// with a reply that said nothing had gone wrong (SHR-373).
export function aiCalls(): Array<[unknown, unknown]> {
  return backend.tables.telegram_call_log.map((r) => [r.call_kind, r.error_type]);
}

export const ABC = "a3700000-0000-4000-8000-0000000000a1";

export const USD_FUND = "a3700000-0000-4000-8000-0000000000f1";


// ABC, held by the sender at 15 shares, bought through their dollar fund.
export function tradeFixtures(): void {
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


export const DIV_FUND = "a8000000-0000-4000-8000-0000000000f1";

export const DIV_BANK = "a8000000-0000-4000-8000-0000000000b1";

export const DIV_ABC = "a8000000-0000-4000-8000-000000000a01";

export const DIV_XYZ = "a8000000-0000-4000-8000-000000000a02";

export const PLAIN_QUESTION = [
  "Dividends due in Dollar funds today:",
  "ABC: 40 × $0.25 = $10.00, $3.00 withheld, $7.00",
  "XYZ: 10 × $0.50 = $5.00, $1.50 withheld, $3.50",
  'Reply "yes" (or react 👍) once they are in the fund to add $10.50, "not yet" to be asked again tomorrow, or "no" to leave them for the app.',
].join("\n");


// A dollar fund last confirmed a month ago (or at the start of today), and
// two of the member's holdings with a dividend each, paid into it today.
export function seedDividends(opts: { confirmedToday?: boolean; shared?: boolean } = {}): void {
  backend.tables.accounts.push(
    {
      id: DIV_FUND, household_id: HOUSEHOLD, name: "Dollar funds", type: "broker_funds", currency: "USD", balance: 100, archived_at: null,
      balance_as_of: opts.confirmedToday ? `${dubaiToday()}T00:00:00+04:00` : `${dubaiDaysAgo(30)}T00:00:00+04:00`,
    },
    { id: DIV_BANK, household_id: HOUSEHOLD, name: "Bank", type: "checking", currency: "USD", balance: 0, balance_as_of: null, archived_at: null },
  );
  const owner = opts.shared ? null : MEMBER;
  backend.tables.holdings = [
    { id: "a8000000-0000-4000-8000-0000000000c1", household_id: HOUSEHOLD, name: "ABC", owner_member_id: owner, currency: "USD" },
    { id: "a8000000-0000-4000-8000-0000000000c2", household_id: HOUSEHOLD, name: "XYZ", owner_member_id: owner, currency: "USD" },
  ];
  const dividend = (id: string, holding: string, units: number, perShare: number, gross: number, tax: number) => ({
    id, household_id: HOUSEHOLD, holding_id: holding, version: 1, status: "earned", asked_at: null, pay_date: dubaiToday(), currency: "USD",
    units, per_share: perShare, expected_gross: gross, expected_tax: tax, expected_fees: 0, expected_net: gross - tax, paid_into_account_id: DIV_FUND,
  });
  backend.tables.holding_dividends.push(
    dividend(DIV_ABC, "a8000000-0000-4000-8000-0000000000c1", 40, 0.25, 10, 3),
    dividend(DIV_XYZ, "a8000000-0000-4000-8000-0000000000c2", 10, 0.5, 5, 1.5),
  );
}

export function dividendQuestions(): Array<{ method: string; body: Row }> {
  return backend.telegramSent.filter((m) => /^(Dividends?|Something changed) /.test(String(m.body.text)));
}

export async function morningCheck(): Promise<Row> {
  const res = await handler(dailyCheck());
  assertEquals(res.status, 200);
  return await res.json();
}
