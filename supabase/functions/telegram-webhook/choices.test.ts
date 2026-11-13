// Choosing a missing category or card with a tap (choices.ts).
// The fake backend these drive the real handler against is testing/harness.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { backend, CARD, capturedIntake, dubaiToday, freshTest, handler, HOUSEHOLD, MEMBER, PARTNER_TELEGRAM, replyUpdate, type Row, tapUpdate, textUpdate } from "./testing/harness.ts";
// After the harness, which sets the environment env.ts reads.
import { decodeChoice, encodeChoice, missingChoice } from "./choices.ts";

const A = "11111111-2222-4333-8444-555555555555";
const B = "66666666-7777-4888-9999-aaaaaaaaaaaa";

Deno.test("a tap's data carries an entry and a choice in under 64 bytes, and nothing else is read", () => {
  const data = encodeChoice("c", A, B);
  assert(new TextEncoder().encode(data).length <= 64, data);
  assertEquals(decodeChoice(data), { kind: "c", intakeId: A, optionId: B });
  assertEquals(decodeChoice(encodeChoice("i", A)), { kind: "i", intakeId: A, optionId: null });
  assertEquals(decodeChoice("c:nonsense"), null);
  assertEquals(decodeChoice("x" + data.slice(1)), null);
});

const READY = { parsed_merchant: "Corner Bakery", parsed_amount: 30, parsed_date: "2026-11-12", date_guessed: false, parsed_category_id: "cat", parsed_account_id: "acc", parsed_currency: "AED", confidence: 0.95 };

Deno.test("only an entry missing just its category or card is asked about, category first", () => {
  assertEquals(missingChoice({ ...READY, parsed_category_id: null }), "category");
  assertEquals(missingChoice({ ...READY, parsed_account_id: null }), "account");
  assertEquals(missingChoice({ ...READY, parsed_category_id: null, parsed_account_id: null }), "category");
  assertEquals(missingChoice({ ...READY, parsed_category_id: null, date_guessed: true }), "category");
  assertEquals(missingChoice(READY), null);
  assertEquals(missingChoice({ ...READY, parsed_category_id: null, parsed_amount: null }), null);
  assertEquals(missingChoice({ ...READY, parsed_category_id: null, confidence: 0.5 }), null);
  assertEquals(missingChoice({ ...READY, parsed_category_id: null, parsed_currency: "USD" }), null);
});

const FOOD = "c2000000-0000-4000-8000-0000000000f0";
const EATING_OUT = "c2000000-0000-4000-8000-0000000000f1";
const GROCERIES = "c2000000-0000-4000-8000-0000000000f2";
const OTHER_HOUSEHOLD_CAT = "c2000000-0000-4000-8000-0000000000f9";

function seed(): void {
  backend.tables.accounts.push({ ...CARD, household_id: HOUSEHOLD, owner_member_id: MEMBER, is_shared: false });
  backend.tables.categories.push(
    { id: FOOD, household_id: HOUSEHOLD, name: "Food & Dining", kind: "expense", parent_id: null, archived: false, is_savings: false },
    { id: EATING_OUT, household_id: HOUSEHOLD, name: "Eating Out", kind: "expense", parent_id: FOOD, archived: false, is_savings: false },
    { id: GROCERIES, household_id: HOUSEHOLD, name: "Groceries", kind: "expense", parent_id: null, archived: false, is_savings: false },
    { id: OTHER_HOUSEHOLD_CAT, household_id: "99999999-0000-4000-8000-000000000000", name: "Theirs", kind: "expense", parent_id: null, archived: false, is_savings: false },
  );
}

function item(over: Row = {}): Row {
  return { merchant: "Corner Bakery", amount: 30, currency: "AED", occurred_at: dubaiToday(), date_stated: true, source: "bank_sms", category: null, card_last4: "0004", account_hint: null, confidence: 0.95, kind: "expense", ...over };
}

// The last message the bot sent, and its buttons' data.
function lastPrompt(): { id: number; text: string; buttons: Array<{ text: string; callback_data: string }> } {
  const sent = backend.telegramSent;
  const body = sent.at(-1)!.body;
  const rows = ((body.reply_markup as Row | undefined)?.inline_keyboard ?? []) as Array<Array<{ text: string; callback_data: string }>>;
  return { id: 1000 + sent.length, text: String(body.text), buttons: rows.flat() };
}

function lastEdit(): Row | undefined {
  return backend.telegramCalls.filter((c) => c.method === "editMessageText").at(-1)?.body;
}

freshTest("an entry with no category is asked about with buttons, subcategories only", async () => {
  seed();
  backend.parse = [item()];
  await handler(textUpdate(9501, "pasted sms"));
  const prompt = lastPrompt();
  assert(prompt.text.includes("Which category?"), prompt.text);
  const labels = prompt.buttons.map((b) => b.text);
  assert(labels.includes("Food & Dining › Eating Out"), labels.join(" | "));
  assert(labels.includes("Groceries"));
  assert(!labels.includes("Food & Dining"));
  assert(!labels.includes("Theirs"));
  assert(labels.includes("In the Inbox"));
});

freshTest("a tap saves the category and turns the message into the yes prompt; yes records it", async () => {
  seed();
  backend.parse = [item()];
  await handler(textUpdate(9502, "pasted sms"));
  const prompt = lastPrompt();
  const groceries = prompt.buttons.find((b) => b.text === "Groceries")!;
  await handler(tapUpdate(9503, prompt.id, groceries.callback_data));
  const row = capturedIntake()[0];
  assertEquals(row.parsed_category_id, GROCERIES);
  assertEquals(row.status, "pending");
  assert(String(lastEdit()?.text).includes('reply "yes"'), String(lastEdit()?.text));
  assertEquals(row.confirm_message_id, prompt.id);
  assert(backend.telegramCalls.some((c) => c.method === "answerCallbackQuery"));
  assertEquals(backend.rpcCalls.filter((c) => c.fn === "approve_intake").length, 0, "a tap recorded the expense");
  await handler(replyUpdate(9520, "yes", prompt.id));
  const approved = backend.rpcCalls.filter((c) => c.fn === "approve_intake");
  assertEquals(approved.length, 1);
  assertEquals(approved[0].args.p_category_id, GROCERIES);
});

freshTest("a tap from the other member changes nothing", async () => {
  seed();
  backend.tables.household_members.push({ id: "33333333-3333-4333-8333-333333333333", household_id: HOUSEHOLD, display_name: "Partner", telegram_user_id: PARTNER_TELEGRAM, role: "member" });
  backend.parse = [item()];
  await handler(textUpdate(9504, "pasted sms"));
  const prompt = lastPrompt();
  await handler(tapUpdate(9505, prompt.id, prompt.buttons.find((b) => b.text === "Groceries")!.callback_data, PARTNER_TELEGRAM));
  assertEquals(capturedIntake()[0].parsed_category_id, null);
});

freshTest("a tap on an entry already settled, or naming another household's category, changes nothing", async () => {
  seed();
  backend.parse = [item()];
  await handler(textUpdate(9506, "pasted sms"));
  const prompt = lastPrompt();
  const row = capturedIntake()[0];
  await handler(tapUpdate(9507, prompt.id, encodeChoice("c", String(row.id), OTHER_HOUSEHOLD_CAT)));
  assertEquals(row.parsed_category_id, null);
  row.status = "approved";
  await handler(tapUpdate(9508, prompt.id, prompt.buttons.find((b) => b.text === "Groceries")!.callback_data));
  assertEquals(row.parsed_category_id, null);
  assert(String(lastEdit()?.text).includes("already"), String(lastEdit()?.text));
});

freshTest("with no card matched either, the category is asked first, then the card", async () => {
  seed();
  backend.parse = [item({ card_last4: null })];
  await handler(textUpdate(9509, "pasted sms"));
  const prompt = lastPrompt();
  await handler(tapUpdate(9510, prompt.id, prompt.buttons.find((b) => b.text === "Groceries")!.callback_data));
  const edit = lastEdit()!;
  assert(String(edit.text).includes("Which card"), String(edit.text));
  const cards = ((edit.reply_markup as Row).inline_keyboard as Array<Array<{ text: string; callback_data: string }>>).flat();
  const card = cards.find((b) => b.text === CARD.name)!;
  await handler(tapUpdate(9511, prompt.id, card.callback_data));
  assertEquals(capturedIntake()[0].parsed_account_id, CARD.id);
  assert(String(lastEdit()?.text).includes('reply "yes"'), String(lastEdit()?.text));
});

freshTest("In the Inbox leaves the entry as it is", async () => {
  seed();
  backend.parse = [item()];
  await handler(textUpdate(9512, "pasted sms"));
  const prompt = lastPrompt();
  await handler(tapUpdate(9513, prompt.id, prompt.buttons.find((b) => b.text === "In the Inbox")!.callback_data));
  assertEquals(capturedIntake()[0].parsed_category_id, null);
  assert(String(lastEdit()?.text).includes("Inbox"), String(lastEdit()?.text));
});

freshTest("an entry with no date is given its category, and waits in the Inbox for the day", async () => {
  seed();
  backend.parse = [item({ occurred_at: null, date_stated: false })];
  await handler(textUpdate(9514, "pasted sms"));
  const prompt = lastPrompt();
  await handler(tapUpdate(9515, prompt.id, prompt.buttons.find((b) => b.text === "Groceries")!.callback_data));
  assertEquals(capturedIntake()[0].parsed_category_id, GROCERIES);
  assert(String(lastEdit()?.text).includes("no date"), String(lastEdit()?.text));
  assertEquals(capturedIntake()[0].confirm_message_id ?? null, null);
});

freshTest("after a pasted list, an entry missing its category is asked about with buttons", async () => {
  seed();
  backend.parse = [
    item({ merchant: "City Taxi", amount: 20, category: "Groceries", occurred_at: null, date_stated: false }),
    item({ merchant: "Fresh Market", amount: 45, category: "Groceries", occurred_at: null, date_stated: false }),
    item({ merchant: "Odd Place", amount: 12, occurred_at: null, date_stated: false }),
  ];
  await handler(textUpdate(9516, "pasted sms"));
  const texts = backend.telegramSent.map((m) => String(m.body.text));
  assert(texts.some((t) => t.startsWith("Got 3 from that message")), texts.join("\n---\n"));
  const prompt = lastPrompt();
  assert(prompt.text.includes("Odd Place") && prompt.text.includes("Which category?"), prompt.text);
});
