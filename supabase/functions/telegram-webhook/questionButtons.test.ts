// The morning's questions with buttons (the revamp, phase 8c; the UI review's
// T10 and T11): an autopay bill is asked with Paid, Not yet and Other
// amount; a card statement with Checked and Open Month end. A tap answers it
// as the typed answer always has, and the question turns into what was done.
// The fake backend is testing/harness.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { backend, BANK, dailyCheck, dubaiToday, EMI, freshTest, handler, HOUSEHOLD, lastReply, MEMBER, PARTNER_TELEGRAM, replyUpdate, type Row, tapUpdate, TELEGRAM_USER } from "./testing/harness.ts";

type Button = { text: string; callback_data?: string; url?: string };

function buttonsOf(body: Row | undefined): Button[] {
  return (((body?.reply_markup as Row | undefined)?.inline_keyboard ?? []) as Button[][]).flat();
}

function calls(method: string): Row[] {
  return backend.telegramCalls.filter((c) => c.method === method).map((c) => c.body);
}

function lastToast(): Row | undefined {
  return calls("answerCallbackQuery").at(-1);
}

function tap(buttons: Button[], label: string): string {
  const b = buttons.find((x) => x.text === label);
  assert(b?.callback_data, `no ${label} button among ${buttons.map((x) => x.text).join(" | ")}`);
  return b.callback_data;
}

const shortDay = (iso: string) => `${Number(iso.slice(8))} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(iso.slice(5, 7)) - 1]}`;

async function morning(): Promise<void> {
  const res = await handler(dailyCheck());
  assertEquals(res.status, 200);
  await res.body?.cancel();
}

// --- Autopay (T10) ---------------------------------------------------------

async function askedEmi(): Promise<{ id: number; text: string; buttons: Button[]; proposal: Row }> {
  backend.tables.recurring.push({
    id: EMI, household_id: HOUSEHOLD, name: "Car EMI", owner_member_id: null, is_shared: true, amount: -2000,
    next_due_date: dubaiToday(), ends_on: null, cadence: "monthly", interval_count: 1, account_id: BANK, category_id: null,
    active: true, autopay: true, accounts: { name: "Bank" },
  });
  await morning();
  const proposal = backend.tables.bot_proposals.find((p) => p.kind === "autopay_payment")!;
  const sent = backend.telegramSent.find((m) => /Gone out\?$/.test(String(m.body.text)))!.body;
  return { id: Number(proposal.prompt_message_id), text: String(sent.text), buttons: buttonsOf(sent), proposal };
}

freshTest("an autopay bill is asked in one line, with Paid, Not yet and Other amount", async () => {
  const q = await askedEmi();
  assertEquals(q.text, "Car EMI · AED 2,000 · due today from Bank. Gone out?");
  assertEquals(q.buttons.map((b) => b.text), ["Paid", "Not yet", "Other amount"]);
});

freshTest("a tap on Paid records the bill, and the question becomes its tick line", async () => {
  const q = await askedEmi();
  await handler(tapUpdate(9801, q.id, tap(q.buttons, "Paid")));
  assertEquals(backend.tables.transactions.map((t) => t.amount), [-2000]);
  assertEquals(q.proposal.status, "applied");
  const edit = calls("editMessageText").at(-1)!;
  assertEquals(edit.message_id, q.id);
  assert(String(edit.text).startsWith(`✓ Car EMI · AED 2,000 · ${shortDay(dubaiToday())} · next due `), String(edit.text));
  assertEquals(buttonsOf(edit), []);
  assertEquals(lastToast()?.text, "Recorded.");
});

freshTest("a tap on Not yet asks again tomorrow, records nothing, and leaves Paid for later today", async () => {
  const q = await askedEmi();
  await handler(tapUpdate(9801, q.id, tap(q.buttons, "Not yet")));
  assertEquals(backend.tables.transactions.length, 0);
  assertEquals([q.proposal.status, (q.proposal.payload as Row).not_yet_on], ["proposed", dubaiToday()]);
  assertEquals(lastToast()?.text, "OK, I'll ask again tomorrow.");
  assertEquals(calls("editMessageText").length, 0, "Not yet took Paid away");
  await handler(tapUpdate(9802, q.id, tap(q.buttons, "Paid")));
  assertEquals(backend.tables.transactions.length, 1);
});

freshTest("Other amount says how to give it, and a typed amount is what is recorded", async () => {
  const q = await askedEmi();
  await handler(tapUpdate(9801, q.id, tap(q.buttons, "Other amount")));
  assertEquals([lastToast()?.text, lastToast()?.show_alert], ['Reply to this with the amount that went out, like "paid 2,050".', true]);
  assertEquals(backend.tables.transactions.length, 0);
  await handler(replyUpdate(9802, "paid 2,050", q.id));
  assertEquals(backend.tables.transactions.map((t) => t.amount), [-2050]);
  assert(lastReply().startsWith("✓ Car EMI · AED 2,050 · "), lastReply());
  // The question loses its buttons, as every answered question does.
  const edit = calls("editMessageText").at(-1)!;
  assertEquals([edit.message_id, buttonsOf(edit).length], [q.id, 0]);
});

freshTest("yesterday's question can still be tapped, and someone else's tap records nothing", async () => {
  const q = await askedEmi();
  // Asked again this morning: yesterday's message stays answerable.
  (q.proposal.payload as Row).asked_message_ids = [q.id, q.id + 50];
  q.proposal.prompt_message_id = q.id + 50;
  backend.tables.household_members.push({ id: "a9000000-0000-4000-8000-0000000000f5", household_id: "b0000000-0000-4000-8000-000000000001", display_name: "Stranger", telegram_user_id: PARTNER_TELEGRAM, role: "owner" });
  await handler(tapUpdate(9801, q.id, tap(q.buttons, "Paid"), PARTNER_TELEGRAM));
  assertEquals(lastToast()?.text, "That isn't one of yours.");
  assertEquals(backend.tables.transactions.length, 0);
  await handler(tapUpdate(9802, q.id, tap(q.buttons, "Paid")));
  assertEquals(backend.tables.transactions.length, 1);
  assertEquals(calls("editMessageText").at(-1)!.message_id, q.id);
});

// --- Statements (T11) ------------------------------------------------------

const STATEMENT_CARD = "a8000000-0000-4000-8000-0000000000c2";

async function askedStatement(shared = false): Promise<{ id: number; text: string; buttons: Button[]; row: Row }> {
  const today = dubaiToday();
  const day = Number(today.slice(8));
  backend.tables.accounts.push({
    id: STATEMENT_CARD, household_id: HOUSEHOLD, name: "Bank card", type: "credit_card", owner_member_id: MEMBER, is_shared: shared,
    balance: 0, balance_aed: 0, currency: "AED", statement_day: day > 1 ? day - 1 : 28, due_day: null, archived_at: null,
  });
  await morning();
  const row = backend.tables.statement_reconciliations[0];
  const mine = (row.asked_prompts as Row[]).find((p) => p.chat_id === TELEGRAM_USER)!;
  const sent = backend.telegramSent.find((m) => Number(m.body.chat_id) === TELEGRAM_USER && / statement closed /.test(String(m.body.text)))!.body;
  return { id: Number(mine.message_id), text: String(sent.text), buttons: buttonsOf(sent), row };
}

freshTest("a statement is asked in one line, with Checked and Open Month end", async () => {
  const q = await askedStatement();
  assertEquals(q.text, `Bank card statement closed ${shortDay(String(q.row.statement_date))}.`);
  assertEquals(q.buttons.map((b) => b.text), ["Checked", "Open Month end"]);
  assertEquals(q.buttons[1].url, "https://app.example.test/money?tab=monthend");
});

freshTest("a tap on Checked marks it done, and the question says so", async () => {
  const q = await askedStatement();
  await handler(tapUpdate(9811, q.id, tap(q.buttons, "Checked")));
  assertEquals([q.row.status, q.row.closed_by_member_id], ["confirmed", MEMBER]);
  const edit = calls("editMessageText").at(-1)!;
  assertEquals([edit.message_id, edit.text, buttonsOf(edit).length], [q.id, `✓ Bank card statement · ${shortDay(String(q.row.statement_date))} · checked`, 0]);
  assertEquals(lastToast()?.text, "Checked.");
  // A second tap says what it is now.
  await handler(tapUpdate(9812, q.id, tap(q.buttons, "Checked")));
  assertEquals(lastToast()?.text, "Checked already.");
});

freshTest("a typed done marks it too, and the question loses its buttons", async () => {
  const q = await askedStatement();
  await handler(replyUpdate(9811, "done", q.id));
  assertEquals(q.row.status, "confirmed");
  assertEquals(lastReply(), `✓ Bank card statement · ${shortDay(String(q.row.statement_date))} · checked`);
  assertEquals(calls("editMessageText").at(-1)!.message_id, q.id);
});

freshTest("a shared card's statement checked in one chat is shown checked in both", async () => {
  backend.tables.household_members.push({ id: "a9000000-0000-4000-8000-0000000000f6", household_id: HOUSEHOLD, display_name: "Partner", telegram_user_id: PARTNER_TELEGRAM, role: "member" });
  const q = await askedStatement(true);
  const theirs = (q.row.asked_prompts as Row[]).find((p) => p.chat_id === PARTNER_TELEGRAM)!;
  await handler(tapUpdate(9811, q.id, tap(q.buttons, "Checked")));
  const edited = calls("editMessageText").map((e) => [e.chat_id, e.message_id]);
  assertEquals(edited.sort(), [[TELEGRAM_USER, q.id], [PARTNER_TELEGRAM, theirs.message_id]].sort());
});

freshTest("an older statement's buttons cannot settle this one", async () => {
  const q = await askedStatement();
  // A tap naming another statement on this question.
  const other = tap(q.buttons, "Checked").slice(0, 1) + "A".repeat(22);
  await handler(tapUpdate(9811, q.id, other));
  assertEquals(q.row.status, "waiting");
  assertEquals(lastToast()?.text, "That isn't one of yours.");
});
