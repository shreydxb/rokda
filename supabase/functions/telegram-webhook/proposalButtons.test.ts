// A proposal's buttons (the revamp, phase 8b; the UI review's T14): a
// transfer or a goal contribution is shown in one line with Record and
// Cancel. A tap records it or cancels it and turns the message into what was
// done; a typed "yes" or "no" and a thumbs-up still answer it. The fake
// backend is testing/harness.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { backend, dubaiToday, freshTest, handler, HOUSEHOLD, lastReply, PARTNER, PARTNER_TELEGRAM, reactionUpdate, replyUpdate, type Row, tapUpdate, textUpdate, tradeFixtures } from "./testing/harness.ts";
// After the harness, which sets the environment env.ts reads.
import { proposalOutcomeMessage } from "./index.ts";

type Button = { text: string; callback_data?: string };

function buttonsOf(body: Row | undefined): Button[] {
  return (((body?.reply_markup as Row | undefined)?.inline_keyboard ?? []) as Button[][]).flat();
}

function lastCall(method: string): Row | undefined {
  return backend.telegramCalls.filter((c) => c.method === method).at(-1)?.body;
}

function lastToast(): string {
  return String(lastCall("answerCallbackQuery")?.text ?? "");
}

function tap(buttons: Button[], label: string): string {
  const b = buttons.find((x) => x.text === label);
  assert(b?.callback_data, `no ${label} button among ${buttons.map((x) => x.text).join(" | ")}`);
  return b.callback_data;
}

const ACCOUNTS = [
  { id: "a5100000-0000-4000-8000-0000000000a1", household_id: HOUSEHOLD, name: "Current account", archived_at: null },
  { id: "a5100000-0000-4000-8000-0000000000a2", household_id: HOUSEHOLD, name: "Savings", archived_at: null },
];

const TRANSFER_LINE = "Transfer AED 3,000 · Current account → Savings · 20 Sep";

// A transfer proposed from a message: the question, its id and its buttons.
async function proposeTransfer(updateId = 9701): Promise<{ id: number; text: string; buttons: Button[] }> {
  backend.tables.accounts.push(...ACCOUNTS);
  backend.route = { tool: "log_transfer", args: { from_account: "current account", to_account: "savings", amount: 3000, occurred_at: "2026-09-20" } };
  await handler(textUpdate(updateId, "moved 3000 to savings"));
  const sent = backend.telegramSent.at(-1)!.body;
  return { id: backend.tables.bot_proposals[0].prompt_message_id as number, text: String(sent.text), buttons: buttonsOf(sent) };
}

freshTest("a transfer is shown in one line, with Record and Cancel", async () => {
  const prompt = await proposeTransfer();
  assertEquals(prompt.text, TRANSFER_LINE);
  assertEquals(prompt.buttons.map((b) => b.text), ["Record", "Cancel"]);
  assertEquals(backend.tables.transactions.length, 0, "a transfer was recorded before anyone tapped Record");
});

freshTest("a tap on Record records the transfer, and the message becomes its tick line", async () => {
  const prompt = await proposeTransfer();
  await handler(tapUpdate(9702, prompt.id, tap(prompt.buttons, "Record")));
  assertEquals(backend.tables.transactions.map((t) => [t.account_id, t.amount]), [[ACCOUNTS[0].id, -3000], [ACCOUNTS[1].id, 3000]]);
  const edit = lastCall("editMessageText")!;
  assertEquals(edit.message_id, prompt.id);
  assertEquals(edit.text, `✓ ${TRANSFER_LINE}`);
  assertEquals(buttonsOf(edit), []);
  assertEquals(lastToast(), "Recorded.");
  assertEquals(backend.telegramSent.length, 1, "a tap sent a message as well as editing the question");
});

freshTest("a tap on Cancel cancels it, and nothing is recorded", async () => {
  const prompt = await proposeTransfer();
  await handler(tapUpdate(9702, prompt.id, tap(prompt.buttons, "Cancel")));
  assertEquals(backend.tables.transactions.length, 0);
  assertEquals(backend.tables.bot_proposals[0].status, "cancelled");
  assertEquals(lastCall("editMessageText")!.text, `Cancelled · ${TRANSFER_LINE}`);
  assertEquals(lastToast(), "Cancelled.");
});

freshTest("a second tap says it is recorded already, and records nothing", async () => {
  const prompt = await proposeTransfer();
  await handler(tapUpdate(9702, prompt.id, tap(prompt.buttons, "Record")));
  await handler(tapUpdate(9703, prompt.id, tap(prompt.buttons, "Record")));
  assertEquals(backend.tables.transactions.length, 2, "a second tap recorded it again");
  assertEquals(lastToast(), "Already recorded.");
  assertEquals(lastCall("editMessageText")!.text, `✓ ${TRANSFER_LINE}`);
  await handler(tapUpdate(9704, prompt.id, tap(prompt.buttons, "Cancel")));
  assertEquals(backend.tables.bot_proposals[0].status, "applied", "Cancel after Record undid nothing, but changed the status");
  assertEquals(lastToast(), "Already recorded.");
});

freshTest("a typed yes still records it: the answer is the tick line, and the question loses its buttons", async () => {
  const prompt = await proposeTransfer();
  await handler(replyUpdate(9702, "yes", prompt.id));
  assertEquals(backend.tables.transactions.length, 2);
  assertEquals(lastReply(), `✓ ${TRANSFER_LINE}`);
  const edit = lastCall("editMessageText")!;
  assertEquals([edit.message_id, edit.text, buttonsOf(edit).length], [prompt.id, `✓ ${TRANSFER_LINE}`, 0]);
  // A second yes says so and records nothing.
  await handler(replyUpdate(9703, "yes", prompt.id));
  assertEquals(backend.tables.transactions.length, 2);
  assertEquals(lastReply(), `Already recorded · ${TRANSFER_LINE}`);
});

freshTest("a typed no cancels it, in the same words as Cancel", async () => {
  const prompt = await proposeTransfer();
  await handler(replyUpdate(9702, "no", prompt.id));
  assertEquals(backend.tables.bot_proposals[0].status, "cancelled");
  assertEquals(lastReply(), `Cancelled · ${TRANSFER_LINE}`);
  assertEquals(lastCall("editMessageText")!.text, `Cancelled · ${TRANSFER_LINE}`);
});

freshTest("a thumbs-up records it and turns the question into the tick line, with no new message", async () => {
  const prompt = await proposeTransfer();
  await handler(reactionUpdate(9702, prompt.id, "👍"));
  assertEquals(backend.tables.transactions.length, 2);
  assertEquals(backend.telegramSent.length, 1, "a thumbs-up was answered with a new message");
  assertEquals(lastCall("editMessageText")!.text, `✓ ${TRANSFER_LINE}`);
});

freshTest("a tap by someone else, or on another message, records nothing", async () => {
  const prompt = await proposeTransfer();
  backend.tables.household_members.push({ id: PARTNER, household_id: HOUSEHOLD, display_name: "Partner", telegram_user_id: PARTNER_TELEGRAM, role: "member" });
  await handler(tapUpdate(9702, prompt.id, tap(prompt.buttons, "Record"), PARTNER_TELEGRAM));
  assertEquals(lastToast(), "That isn't one of yours.");
  await handler(tapUpdate(9703, prompt.id + 7, tap(prompt.buttons, "Record")));
  assertEquals(lastToast(), "Use the latest message about it.");
  assertEquals(backend.tables.transactions.length, 0);
  assertEquals(backend.tables.bot_proposals[0].status, "proposed");
});

freshTest("a tap on a lapsed transfer records nothing and says so", async () => {
  const prompt = await proposeTransfer();
  Object.assign(backend.tables.bot_proposals[0], { status: "expired" });
  await handler(tapUpdate(9702, prompt.id, tap(prompt.buttons, "Record")));
  assertEquals(backend.tables.transactions.length, 0);
  assertEquals(lastToast(), "That lapsed. Send it again if it still holds.");
  assertEquals(lastCall("editMessageText")!.text, `Cancelled · ${TRANSFER_LINE} · lapsed`);
});

freshTest("a failed Record keeps the buttons, and says to try again", async () => {
  const prompt = await proposeTransfer();
  backend.failRpc = new Set(["apply_bot_proposal"]);
  await handler(tapUpdate(9702, prompt.id, tap(prompt.buttons, "Record")));
  assertEquals(lastToast(), "Couldn't record that. Nothing saved — try again in a minute.");
  assertEquals(lastCall("editMessageText"), undefined, "the question was changed though nothing was recorded");
});

freshTest("a goal contribution is shown in one line, and Record records it", async () => {
  backend.route = { tool: "log_goal_contribution", args: { goal_name: "House", amount: 500 } };
  await handler(textUpdate(9711, "put 500 toward the house goal"));
  const sent = backend.telegramSent.at(-1)!.body;
  const line = `AED 500 toward House · ${Number(dubaiToday().slice(8))} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(dubaiToday().slice(5, 7)) - 1]}`;
  assertEquals(sent.text, line);
  const buttons = buttonsOf(sent);
  assertEquals(buttons.map((b) => b.text), ["Record", "Cancel"]);
  const id = backend.tables.bot_proposals[0].prompt_message_id as number;
  await handler(tapUpdate(9712, id, tap(buttons, "Record")));
  assertEquals(backend.tables.goal_contributions.length, 1);
  assertEquals(lastCall("editMessageText")!.text, `✓ ${line}`);
});

Deno.test("a recorded transfer says which sides were already in Rokda", () => {
  const applied = (over: Row) => proposalOutcomeMessage({
    outcome: "applied",
    kind: "transfer",
    applied: [{ from_name: "Current account", to_name: "Savings", amount: 450, occurred_at: "2026-10-13", joined_out: false, joined_in: false, already_recorded: false, ...over }],
    skipped: [],
  });
  assertEquals(applied({}), "✓ Transfer AED 450 · Current account → Savings · 13 Oct");
  assertEquals(applied({ joined_out: true }), "✓ Transfer AED 450 · Current account → Savings · 13 Oct\nJoined to the payment out of Current account already in Rokda");
  assertEquals(applied({ joined_in: true }), "✓ Transfer AED 450 · Current account → Savings · 13 Oct\nJoined to the money into Savings already in Rokda");
  assertEquals(applied({ joined_out: true, joined_in: true }), "✓ Transfer AED 450 · Current account → Savings · 13 Oct\nJoined to both sides already in Rokda");
});

// --- Trades (T15) ----------------------------------------------------------

async function proposeSale(updateId = 9721): Promise<{ id: number; text: string; buttons: Button[] }> {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "sell", stock: "ABC", units: 6, price: 150, trade_date: "2026-10-27", brokerage: 1 } };
  await handler(textUpdate(updateId, "sold 6 ABC at 150 on 27 Oct, brokerage 1"));
  const sent = backend.telegramSent.at(-1)!.body;
  const row = backend.tables.bot_proposals.find((r) => r.kind === "trade" && r.status === "proposed")!;
  return { id: row.prompt_message_id as number, text: String(sent.text), buttons: buttonsOf(sent) };
}

freshTest("a trade is shown with Save and Cancel, and no instructions", async () => {
  const prompt = await proposeSale();
  assertEquals(prompt.buttons.map((b) => b.text), ["Save", "Cancel"]);
  assert(!prompt.text.includes("Reply"), prompt.text);
});

freshTest("a tap on Save saves the trade, and the message becomes what was saved", async () => {
  const prompt = await proposeSale();
  await handler(tapUpdate(9722, prompt.id, tap(prompt.buttons, "Save")));
  assertEquals(backend.applyCalls, 1);
  const edit = lastCall("editMessageText")!;
  assertEquals([edit.message_id, edit.text, buttonsOf(edit).length], [prompt.id, "✓ Sell 6 ABC at USD 150 · 27 Oct\nABC 9 shares · Dollar broker funds +USD 899", 0]);
  assertEquals(lastToast(), "Recorded.");
});

freshTest("a tap on Cancel cancels the trade, and saves nothing", async () => {
  const prompt = await proposeSale();
  await handler(tapUpdate(9722, prompt.id, tap(prompt.buttons, "Cancel")));
  assertEquals(backend.applyCalls, 0);
  assertEquals(lastCall("editMessageText")!.text, "Cancelled · Sell 6 ABC at USD 150 · 27 Oct");
});

freshTest("a Save after the holding changed saves nothing, and the trade comes again with today's figures and its own buttons", async () => {
  const prompt = await proposeSale();
  backend.tradeOutcome = { outcome: "stale" };
  await handler(tapUpdate(9722, prompt.id, tap(prompt.buttons, "Save")));
  assertEquals(lastCall("editMessageText")!.text, "Cancelled · Sell 6 ABC at USD 150 · 27 Oct · changed since");
  assertEquals(lastToast(), "It changed since. Here it is again.");
  const again = backend.telegramSent.at(-1)!.body;
  assert(String(again.text).startsWith("Sell 6 ABC at USD 150 · 27 Oct"), String(again.text));
  assertEquals(buttonsOf(again).map((b) => b.text), ["Save", "Cancel"]);
  assertEquals(backend.tables.bot_proposals.filter((r) => r.kind === "trade").map((r) => r.status), ["expired", "proposed"]);
});

freshTest("undoing a trade is asked with Undo trade and Cancel", async () => {
  tradeFixtures();
  backend.tables.holding_trades = [{ id: "t-sale", household_id: HOUSEHOLD, holding_id: backend.tables.holdings[0].id, kind: "sell", units: 6, price: 150, trade_date: "2026-10-27", created_by: backend.tables.household_members[0].id, created_at: "2026-10-27T08:00:00Z", funds_account_id: null }];
  backend.route = { tool: "undo_last_trade", args: {} };
  await handler(textUpdate(9731, "undo last trade"));
  const sent = backend.telegramSent.at(-1)!.body;
  const buttons = buttonsOf(sent);
  assertEquals(buttons.map((b) => b.text), ["Undo trade", "Cancel"]);
  const id = backend.tables.bot_proposals.find((r) => r.kind === "trade_undo")!.prompt_message_id as number;
  await handler(tapUpdate(9732, id, tap(buttons, "Undo trade")));
  assert(String(lastCall("editMessageText")!.text).startsWith("✓ Undone · Sell 6 ABC at USD 150 · 27 Oct"), String(lastCall("editMessageText")!.text));
  assertEquals(lastToast(), "Undone.");
});

// --- The fresh review of 8b's second part --------------------------------------

freshTest("a trade the database refuses on Save says why, and the question says so too", async () => {
  const prompt = await proposeSale();
  backend.tradeOutcome = { outcome: "refused", error: "exceeds_units" };
  await handler(tapUpdate(9722, prompt.id, tap(prompt.buttons, "Save")));
  const why = "That sells more ABC than was held on that date (6), so nothing was saved.";
  assertEquals([lastToast(), lastCall("editMessageText")!.text], [why, why]);
});

freshTest("a thumbs-up on a trade saves it and turns the question into what was saved", async () => {
  const prompt = await proposeSale();
  const sent = backend.telegramSent.length;
  await handler(reactionUpdate(9722, prompt.id, "👍"));
  assertEquals(backend.applyCalls, 1);
  assertEquals(backend.telegramSent.length, sent);
  assert(String(lastCall("editMessageText")!.text).startsWith("✓ Sell 6 ABC at USD 150 · 27 Oct"));
});

freshTest("a typed no to a trade already cancelled says so in the same words", async () => {
  const prompt = await proposeSale();
  await handler(tapUpdate(9722, prompt.id, tap(prompt.buttons, "Cancel")));
  await handler(replyUpdate(9723, "no", prompt.id));
  assertEquals(lastReply(), "Cancelled · Sell 6 ABC at USD 150 · 27 Oct");
});

freshTest("a transfer recorded with no answer kept still says it is recorded", async () => {
  const prompt = await proposeTransfer();
  Object.assign(backend.tables.bot_proposals[0], { status: "applied", result: null });
  await handler(replyUpdate(9702, "yes", prompt.id));
  assertEquals(lastReply(), `Already recorded · ${TRANSFER_LINE}`);
});
