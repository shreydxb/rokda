// An expense's buttons (the revamp, phase 8b): Record records, Undo puts it
// back for ten minutes, Discard sets it aside, Category and Account change it
// before it is recorded. The fake backend is testing/harness.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { backend, CARD, capturedIntake, dubaiToday, freshTest, handler, HOUSEHOLD, lastReply, MEMBER, PARTNER_TELEGRAM, reactionUpdate, replyUpdate, type Row, tapUpdate, textUpdate } from "./testing/harness.ts";
// After the harness, which sets the environment env.ts reads.
import { encodeChoice } from "./choices.ts";
import { appAddress } from "./env.ts";

const GROCERIES = "c3000000-0000-4000-8000-0000000000f2";
const EATING_OUT = "c3000000-0000-4000-8000-0000000000f1";
const BANK = { id: "c3000000-0000-4000-8000-0000000000a1", household_id: HOUSEHOLD, name: "Bank", type: "current", archived_at: null, owner_member_id: MEMBER };

function seed(): void {
  // Captured now, so a bare answer counts it as waiting.
  backend.now = Date.now();
  backend.tables.accounts.push({ ...CARD, household_id: HOUSEHOLD, owner_member_id: MEMBER, is_shared: false }, BANK);
  backend.tables.categories.push(
    { id: GROCERIES, household_id: HOUSEHOLD, name: "Groceries", kind: "expense", parent_id: null, archived: false, is_savings: false },
    { id: EATING_OUT, household_id: HOUSEHOLD, name: "Eating Out", kind: "expense", parent_id: null, archived: false, is_savings: false },
  );
}

function item(over: Row = {}): Row {
  return { merchant: "Corner Bakery", amount: 30, currency: "AED", occurred_at: dubaiToday(), date_stated: true, source: "bank_sms", category: "Groceries", card_last4: "0004", account_hint: null, confidence: 0.95, kind: "expense", ...over };
}

type Button = { text: string; callback_data?: string; url?: string };

function buttonsOf(body: Row | undefined): Button[] {
  return (((body?.reply_markup as Row | undefined)?.inline_keyboard ?? []) as Button[][]).flat();
}

function lastPrompt(): { id: number; text: string; buttons: Button[] } {
  const body = backend.telegramSent.at(-1)!.body;
  return { id: 1000 + backend.telegramSent.length, text: String(body.text), buttons: buttonsOf(body) };
}

function lastCall(method: string): Row | undefined {
  return backend.telegramCalls.filter((c) => c.method === method).at(-1)?.body;
}

function lastToast(): string {
  return String(lastCall("answerCallbackQuery")?.text ?? "");
}

function tap(prompt: { buttons: Button[] }, label: string): string {
  const b = prompt.buttons.find((x) => x.text === label);
  assert(b?.callback_data, `no ${label} button among ${prompt.buttons.map((x) => x.text).join(" | ")}`);
  return b.callback_data;
}

async function capture(update = 9601, over: Row = {}): Promise<{ id: number; text: string; buttons: Button[] }> {
  seed();
  backend.parse = [item(over)];
  await handler(textUpdate(update, "pasted sms"));
  return lastPrompt();
}

freshTest("an expense read in full is shown in two lines, with Record, Category, Account and Discard", async () => {
  const prompt = await capture();
  assertEquals(prompt.text, `Corner Bakery · AED 30\nGroceries · ${CARD.name} · ${Number(dubaiToday().slice(8))} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(dubaiToday().slice(5, 7)) - 1]}`);
  assertEquals(prompt.buttons.map((b) => b.text), ["Record", "Category", "Account", "Discard"]);
  assertEquals(capturedIntake()[0].confirm_message_id, prompt.id);
});

freshTest("a tap on Record records it, and the message becomes one line with Undo", async () => {
  const prompt = await capture(9602);
  await handler(tapUpdate(9603, prompt.id, tap(prompt, "Record")));
  assertEquals(backend.rpcCalls.filter((c) => c.fn === "approve_intake").length, 1);
  assertEquals(capturedIntake()[0].status, "approved");
  const edit = lastCall("editMessageText")!;
  assertEquals(edit.text, "✓ Corner Bakery · AED 30 · Groceries");
  assertEquals(buttonsOf(edit).map((b) => b.text), ["Undo"]);
  assertEquals(lastToast(), "Recorded.");
});

freshTest("Undo puts it back with its buttons, to change and record again", async () => {
  const prompt = await capture(9604);
  await handler(tapUpdate(9605, prompt.id, tap(prompt, "Record")));
  const recorded = { buttons: buttonsOf(lastCall("editMessageText")) };
  const recordedAs = backend.tables.transactions[0].id;
  await handler(tapUpdate(9606, prompt.id, tap(recorded, "Undo")));
  assertEquals(backend.rpcCalls.filter((c) => c.fn === "undo_intake_approval").at(-1)?.args, { p_intake_id: capturedIntake()[0].id, p_member_id: MEMBER, p_transaction_id: recordedAs });
  assertEquals(capturedIntake()[0].status, "pending");
  assertEquals(backend.tables.transactions.length, 0);
  const edit = lastCall("editMessageText")!;
  assertEquals(edit.text, prompt.text);
  assertEquals(buttonsOf(edit).map((b) => b.text), ["Record", "Category", "Account", "Discard"]);
  assertEquals(lastToast(), "Undone.");
});

freshTest("Undo after ten minutes, or after a change in the app, leaves it recorded and says why", async () => {
  const prompt = await capture(9607);
  await handler(tapUpdate(9608, prompt.id, tap(prompt, "Record")));
  const recorded = { buttons: buttonsOf(lastCall("editMessageText")) };
  backend.undoOutcome = "too_late";
  await handler(tapUpdate(9609, prompt.id, tap(recorded, "Undo")));
  assertEquals(capturedIntake()[0].status, "approved");
  assertEquals(lastToast(), "Undo lasts ten minutes. Change it in the app.");
  const edit = lastCall("editMessageText")!;
  assertEquals(edit.text, "✓ Corner Bakery · AED 30 · Groceries");
  assertEquals(buttonsOf(edit).length, 0);
  backend.undoOutcome = "changed";
  await handler(tapUpdate(9610, prompt.id, tap(recorded, "Undo")));
  assertEquals(lastToast(), "It was changed in the app, so it stays. Change it there.");
});

freshTest("Discard sets it aside", async () => {
  const prompt = await capture(9611);
  await handler(tapUpdate(9612, prompt.id, tap(prompt, "Discard")));
  assertEquals(capturedIntake()[0].status, "rejected");
  assertEquals(backend.rpcCalls.filter((c) => c.fn === "approve_intake").length, 0);
  const edit = lastCall("editMessageText")!;
  assertEquals(edit.text, "Cancelled · Corner Bakery · AED 30");
  assertEquals(buttonsOf(edit).length, 0);
});

freshTest("Category shows the usual ones; a tap changes it and nothing is recorded until Record", async () => {
  const prompt = await capture(9613);
  await handler(tapUpdate(9614, prompt.id, tap(prompt, "Category")));
  const menu = { buttons: buttonsOf(lastCall("editMessageReplyMarkup")) };
  assertEquals(menu.buttons.map((b) => b.text).sort(), ["Back", "Eating Out", "Groceries"]);
  await handler(tapUpdate(9615, prompt.id, tap(menu, "Eating Out")));
  assertEquals(capturedIntake()[0].parsed_category_id, EATING_OUT);
  assertEquals(capturedIntake()[0].status, "pending");
  const edit = lastCall("editMessageText")!;
  assert(String(edit.text).startsWith("Corner Bakery · AED 30\nEating Out · "), String(edit.text));
  assertEquals(buttonsOf(edit).map((b) => b.text), ["Record", "Category", "Account", "Discard"]);
  assertEquals(backend.rpcCalls.filter((c) => c.fn === "approve_intake").length, 0);
});

freshTest("Account lists the cards and accounts; Back returns to the entry as it is", async () => {
  const prompt = await capture(9616);
  await handler(tapUpdate(9617, prompt.id, tap(prompt, "Account")));
  const menu = { buttons: buttonsOf(lastCall("editMessageReplyMarkup")) };
  assert(menu.buttons.some((b) => b.text === "Bank") && menu.buttons.some((b) => b.text === CARD.name), menu.buttons.map((b) => b.text).join(" | "));
  await handler(tapUpdate(9618, prompt.id, tap(menu, "Back")));
  assertEquals(lastCall("editMessageText")?.text, prompt.text);
  await handler(tapUpdate(9619, prompt.id, tap(menu, "Bank")));
  assertEquals(capturedIntake()[0].parsed_account_id, BANK.id);
});

freshTest("Record looks for a repeat first: one found sends it to the Inbox instead", async () => {
  const prompt = await capture(9620);
  backend.tables.transactions.push({ id: "t-dup", household_id: HOUSEHOLD, account_id: CARD.id, amount: -30, merchant: "Corner Bakery", occurred_at: dubaiToday() });
  await handler(tapUpdate(9621, prompt.id, tap(prompt, "Record")));
  assertEquals(backend.rpcCalls.filter((c) => c.fn === "approve_intake").length, 0);
  assertEquals(capturedIntake()[0].status, "pending");
  assert(String(lastCall("editMessageText")?.text).startsWith("In the Inbox · looks like one recorded "), String(lastCall("editMessageText")?.text));
});

freshTest("Record on a message that no longer shows the entry as it is records nothing, and shows it again", async () => {
  const prompt = await capture(9622);
  // A correction sent since asked again in a newer message.
  Object.assign(capturedIntake()[0], { parsed_amount: 45, confirm_message_id: 5555 });
  await handler(tapUpdate(9623, prompt.id, tap(prompt, "Record")));
  assertEquals(backend.rpcCalls.filter((c) => c.fn === "approve_intake").length, 0);
  assert(String(lastCall("editMessageText")?.text).startsWith("Corner Bakery · AED 45\n"), String(lastCall("editMessageText")?.text));
  assertEquals(lastToast(), "It changed since. Check it, then tap Record.");
});

freshTest("the other member's taps change nothing", async () => {
  backend.tables.household_members.push({ id: "33333333-3333-4333-8333-333333333333", household_id: HOUSEHOLD, display_name: "Partner", telegram_user_id: PARTNER_TELEGRAM, role: "member" });
  const prompt = await capture(9624);
  for (const [n, label] of [[9625, "Record"], [9626, "Discard"]] as const) await handler(tapUpdate(n, prompt.id, tap(prompt, label), PARTNER_TELEGRAM));
  assertEquals(capturedIntake()[0].status, "pending");
  assertEquals(backend.rpcCalls.filter((c) => c.fn === "approve_intake").length, 0);
});

freshTest("a failed recording says nothing was saved and keeps the buttons", async () => {
  const prompt = await capture(9627);
  backend.failRpc = new Set(["approve_intake"]);
  await handler(tapUpdate(9628, prompt.id, tap(prompt, "Record")));
  assertEquals(capturedIntake()[0].status, "pending");
  assertEquals(lastToast(), "Couldn't record that. Nothing saved — try again in a minute.");
  assertEquals(lastCall("editMessageText"), undefined);
});

freshTest("an entry that waits in the Inbox says why, with Open Inbox when the app's address is set", async () => {
  seed();
  backend.parse = [item({ merchant: null })];
  await handler(textUpdate(9629, "200 on card 0004"));
  const prompt = lastPrompt();
  assert(prompt.text.startsWith("In the Inbox · needs who was paid"), prompt.text);
  assertEquals(prompt.buttons, [{ text: "Open Inbox", url: "https://app.example.test/inbox" }]);
});

Deno.test("the app's address is taken only as an https address, without a trailing slash", () => {
  assertEquals(appAddress("https://app.example.test/"), "https://app.example.test");
  assertEquals(appAddress("  https://app.example.test  "), "https://app.example.test");
  assertEquals(appAddress("http://app.example.test"), null);
  assertEquals(appAddress("app.example.test"), null);
  assertEquals(appAddress(""), null);
  assertEquals(appAddress(undefined), null);
});

// Typed answers still work beside the buttons (the design note's "What stays").
freshTest("a yes sent as a reply records it: a new line with Undo, and the old message loses its buttons", async () => {
  const prompt = await capture(9640);
  await handler(replyUpdate(9641, "yes", prompt.id));
  assertEquals(capturedIntake()[0].status, "approved");
  const sent = lastPrompt();
  assertEquals(sent.text, "✓ Corner Bakery · AED 30 · Groceries");
  assertEquals(sent.buttons.map((b) => b.text), ["Undo"]);
  const edited = backend.telegramCalls.filter((c) => c.method === "editMessageText" && c.body.message_id === prompt.id).at(-1)?.body;
  assertEquals(edited?.text, "✓ Corner Bakery · AED 30 · Groceries");
  assertEquals(buttonsOf(edited).length, 0);
  // The Undo on the new line works.
  await handler(tapUpdate(9642, sent.id, tap(sent, "Undo")));
  assertEquals(capturedIntake()[0].status, "pending");
  assertEquals(buttonsOf(lastCall("editMessageText")).map((b) => b.text), ["Record", "Category", "Account", "Discard"]);
});

freshTest("a 👍 on the message records it there, with Undo", async () => {
  const prompt = await capture(9643);
  const sentBefore = backend.telegramSent.length;
  await handler(reactionUpdate(9644, prompt.id, "👍"));
  assertEquals(capturedIntake()[0].status, "approved");
  assertEquals(backend.telegramSent.length, sentBefore, "a reaction drew a new message");
  const edit = lastCall("editMessageText")!;
  assertEquals(edit.message_id, prompt.id);
  assertEquals(edit.text, "✓ Corner Bakery · AED 30 · Groceries");
  assertEquals(buttonsOf(edit).map((b) => b.text), ["Undo"]);
});

freshTest("no, as a reply or with one waiting, sets it aside and says so", async () => {
  const prompt = await capture(9645);
  const aiBefore = backend.aiCalls;
  await handler(replyUpdate(9646, "no", prompt.id));
  assertEquals(capturedIntake()[0].status, "rejected");
  assertEquals(lastReply(), "Cancelled · Corner Bakery · AED 30");
  assertEquals(buttonsOf(backend.telegramCalls.filter((c) => c.method === "editMessageText" && c.body.message_id === prompt.id).at(-1)?.body).length, 0);
  assertEquals(backend.aiCalls, aiBefore, "the no was sent to the AI");

  backend.parse = [item({ merchant: "Fresh Market" })];
  await handler(textUpdate(9647, "pasted sms"));
  await handler(textUpdate(9648, "no"));
  assertEquals(capturedIntake().find((r) => r.parsed_merchant === "Fresh Market")?.status, "rejected");
  assertEquals(lastReply(), "Cancelled · Fresh Market · AED 30");
});

freshTest("a bare yes or no with two waiting asks which one, and does nothing", async () => {
  seed();
  backend.parse = [item()];
  await handler(textUpdate(9650, "pasted sms"));
  backend.parse = [item({ merchant: "Fresh Market", amount: 45 })];
  await handler(textUpdate(9651, "pasted sms"));
  await handler(textUpdate(9652, "yes"));
  assertEquals(lastReply(), "Which one? Tap Record on the message you mean.");
  await handler(textUpdate(9653, "no"));
  assertEquals(lastReply(), "Which one? Tap Discard on the message you mean.");
  assertEquals(capturedIntake().map((r) => r.status), ["pending", "pending"]);
  assertEquals(backend.approveCalls, 0);
});

freshTest("a yes that finds the expense recorded meanwhile leaves it in the Inbox, saying so", async () => {
  const prompt = await capture(9654);
  backend.tables.transactions.push({ id: "t-dup", household_id: HOUSEHOLD, account_id: CARD.id, amount: -30, merchant: "Corner Bakery", occurred_at: dubaiToday() });
  await handler(replyUpdate(9655, "yes", prompt.id));
  assertEquals(backend.approveCalls, 0);
  assert(lastReply().startsWith("In the Inbox · looks like one recorded "), lastReply());
});

// The fresh review of 8b.
freshTest("an entry approved in the app shows that record, with no Undo for the bot to take it back", async () => {
  const prompt = await capture(9660);
  // The partner approves it in the Inbox, at another amount and category.
  backend.tables.transactions.push({ id: "tx-app", household_id: HOUSEHOLD, account_id: CARD.id, amount: -45, kind: "expense", merchant: "Corner Bakery", occurred_at: dubaiToday(), category_id: EATING_OUT, created_at: new Date().toISOString() });
  Object.assign(capturedIntake()[0], { status: "approved", transaction_id: "tx-app" });
  await handler(tapUpdate(9661, prompt.id, tap(prompt, "Record")));
  assertEquals(lastToast(), "Already recorded.");
  const edit = lastCall("editMessageText")!;
  assertEquals(edit.text, "✓ Corner Bakery · AED 45 · Eating Out");
  assertEquals(buttonsOf(edit).length, 0);
  // Even an Undo naming it is refused, and the record stays.
  await handler(tapUpdate(9662, prompt.id, encodeChoice("u", String(capturedIntake()[0].id), "c3000000-0000-4000-8000-00000000ff01")));
  assertEquals(backend.tables.transactions.map((t) => t.id), ["tx-app"]);
  assertEquals(capturedIntake()[0].status, "approved");
});

freshTest("a change whose message could not be updated unties it, so Record there records nothing unseen", async () => {
  const prompt = await capture(9663);
  await handler(tapUpdate(9664, prompt.id, tap(prompt, "Account")));
  const menu = { buttons: buttonsOf(lastCall("editMessageReplyMarkup")) };
  backend.faults.failEdits = 1;
  await handler(tapUpdate(9665, prompt.id, tap(menu, "Bank")));
  assertEquals(capturedIntake()[0].parsed_account_id, BANK.id);
  assertEquals(capturedIntake()[0].confirm_message_id ?? null, null, "a message still showing the card stays tied to the bank");
  await handler(tapUpdate(9666, prompt.id, tap(prompt, "Record")));
  assertEquals(backend.approveCalls, 0);
});

freshTest("a message that already shows the entry as it is gets tied to it, so the next Record records", async () => {
  const prompt = await capture(9667);
  // Its tie was never saved.
  capturedIntake()[0].confirm_message_id = null;
  backend.faults.notModifiedEdits = 1;
  await handler(tapUpdate(9668, prompt.id, tap(prompt, "Record")));
  assertEquals(backend.approveCalls, 0);
  assertEquals(capturedIntake()[0].confirm_message_id, prompt.id);
  await handler(tapUpdate(9669, prompt.id, tap(prompt, "Record")));
  assertEquals(backend.approveCalls, 1);
});
