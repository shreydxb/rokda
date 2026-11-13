// A paste of several entries is answered with a numbered list, and a reply to
// the list records or sets aside those entries (batch.ts, batchReview.ts).
// The fake backend these drive the real handler against is testing/harness.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { backend, CARD, capturedIntake, dubaiDaysAgo, dubaiToday, freshTest, handler, HOUSEHOLD, lastReply, MEMBER, PARTNER, PARTNER_TELEGRAM, partnerUpdate, reactionUpdate, replyUpdate, type Row, textUpdate } from "./testing/harness.ts";

const TRANSPORT = "b5000000-0000-4000-8000-0000000000c1";
const GROCERY = "b5000000-0000-4000-8000-0000000000c2";

function fixtures(): void {
  // Pasted now: a day given in a reply is never after the paste.
  backend.now = Date.now();
  backend.tables.accounts.push({ ...CARD, household_id: HOUSEHOLD });
  backend.tables.categories.push(
    { id: TRANSPORT, household_id: HOUSEHOLD, name: "Transport", archived: false, is_savings: false },
    { id: GROCERY, household_id: HOUSEHOLD, name: "Groceries", archived: false, is_savings: false },
  );
}

// A bank SMS read in full: undated unless a day is given.
function sms(merchant: string, amount: number, over: Row = {}): Row {
  return {
    merchant, amount, currency: "AED", occurred_at: null, date_stated: false, source: "bank_sms",
    category: merchant.includes("Taxi") ? "Transport" : "Groceries", card_last4: "0004", account_hint: null, confidence: 0.95, kind: "expense",
    ...over,
  };
}

// The list message's id: the last message the bot sent.
function listId(): number {
  return 1000 + backend.telegramSent.length;
}

// The list's text, as Telegram sends it back with a reply to it.
let listText = "";
function answer(updateId: number, text: string, list: number) {
  return replyUpdate(updateId, text, list, listText);
}

function approvals(): Row[] {
  return backend.rpcCalls.filter((c) => c.fn === "approve_intake").map((c) => c.args);
}

async function paste(items: Row[], updateId = 9101): Promise<number> {
  fixtures();
  backend.parse = items;
  await handler(textUpdate(updateId, "pasted bank texts"));
  listText = lastReply();
  return listId();
}

const twoDaysAgo = () => dubaiDaysAgo(2);
const dayWords = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

// --- Sending the list ----------------------------------------------------

freshTest("a paste of several entries is answered with a numbered list, each entry bound to it", async () => {
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5), sms("Fresh Market", 120)]);
  const text = lastReply();
  assert(text.includes("1. AED 20.00 · City Taxi · Card •0004 · Transport"), text);
  assert(text.includes("2. AED 45.50"), text);
  assert(text.includes("3. AED 120.00"), text);
  assert(text.includes('like "all on 2 Oct"'), text);
  assertEquals(capturedIntake().length, 3);
  for (const row of capturedIntake()) assertEquals(row.confirm_message_id, list);
});

freshTest("an entry already recorded, or missing a category, is named and not numbered", async () => {
  backend.tables.transactions.push({ id: "t-1", household_id: HOUSEHOLD, account_id: CARD.id, amount: 20, kind: "expense", merchant: "City Taxi", occurred_at: dubaiDaysAgo(1) });
  await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5), sms("Fresh Market", 120), sms("Odd Place", 30, { category: "Nothing like it" })]);
  const text = lastReply();
  assert(text.startsWith("Got 4 from that message"), text);
  assert(text.includes("1. AED 45.50 · Corner Shop"), text);
  assert(text.includes("2. AED 120.00 · Fresh Market"), text);
  assert(!text.includes("3. AED"), text);
  assert(text.includes("1 more is already recorded (City Taxi, AED 20.00), left out."), text);
  assert(text.includes("1 needs a look in the Inbox (Odd Place: no category)."), text);
  const bound = capturedIntake().filter((r) => r.confirm_message_id != null).map((r) => r.parsed_merchant);
  assertEquals(bound.sort(), ["Corner Shop", "Fresh Market"]);
});

freshTest("more than 20 entries: 20 are numbered and the rest wait in the Inbox", async () => {
  await paste(Array.from({ length: 23 }, (_, i) => sms(`Shop ${i + 1}`, 10 + i)));
  const text = lastReply();
  assert(text.includes("20. AED"), text);
  assert(!text.includes("21. AED"), text);
  assert(text.includes("3 more wait in the Inbox (a list takes 20 at most)."), text);
  assertEquals(capturedIntake().filter((r) => r.confirm_message_id != null).length, 20);
});

freshTest("one entry keeps the yes prompt", async () => {
  await paste([sms("City Taxi", 20, { occurred_at: dubaiToday(), date_stated: true })]);
  assert(lastReply().includes('reply "yes" to record it'), lastReply());
});

// --- Acting on a reply ---------------------------------------------------

freshTest("all on a date records every listed entry on it, each marked as confirmed", async () => {
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  const day = twoDaysAgo();
  await handler(answer(9102, `all on ${dayWords(day)}`, list));
  const calls = approvals();
  assertEquals(calls.length, 2);
  for (const c of calls) {
    assertEquals(c.p_occurred_at, day);
    assertEquals(c.p_date_confirmed, true);
    assertEquals(c.p_currency, "AED");
  }
  assertEquals(lastReply(), `Recorded 2 on ${dayWords(day)}.`);
});

freshTest("some on a date records those, and the rest wait", async () => {
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  await handler(answer(9102, `1 on ${dayWords(twoDaysAgo())}`, list));
  assertEquals(approvals().length, 1);
  assertEquals(approvals()[0].p_amount, 20);
  assert(lastReply().startsWith(`Recorded 1 on ${dayWords(twoDaysAgo())}.`), lastReply());
  assert(lastReply().includes("1 still waits in the Inbox."), lastReply());
});

freshTest("drop sets an entry aside", async () => {
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  await handler(answer(9102, "drop 2", list));
  const byMerchant = Object.fromEntries(capturedIntake().map((r) => [r.parsed_merchant, r.status]));
  assertEquals(byMerchant, { "City Taxi": "pending", "Corner Shop": "rejected" });
  assertEquals(approvals().length, 0);
  assert(lastReply().startsWith("Set aside 1 (Corner Shop, AED 45.50)."), lastReply());
});

freshTest("a list of dated entries takes all alone, and refuses a date given", async () => {
  const day = dubaiDaysAgo(3);
  const list = await paste([sms("City Taxi", 20, { occurred_at: day, date_stated: true }), sms("Corner Shop", 45.5, { occurred_at: day, date_stated: true })]);
  assert(lastReply().includes('Reply "all" to record them'), lastReply());
  await handler(answer(9102, `all on ${dayWords(twoDaysAgo())}`, list));
  assertEquals(approvals().length, 0);
  assert(lastReply().includes("own dates"), lastReply());
  await handler(answer(9103, "all", list));
  assertEquals(approvals().length, 2);
  for (const c of approvals()) {
    assertEquals(c.p_occurred_at, day);
    assertEquals(c.p_date_confirmed, undefined);
  }
});

freshTest("all with no day, when an entry had none, records nothing and asks for the day", async () => {
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  await handler(answer(9102, "all", list));
  assertEquals(approvals().length, 0);
  assert(lastReply().includes("Nothing recorded yet"), lastReply());
});

// Review Focus 1.
freshTest("a mixed list dates only the undated", async () => {
  const own = dubaiDaysAgo(5);
  const list = await paste([sms("City Taxi", 20, { occurred_at: own, date_stated: true }), sms("Corner Shop", 45.5)]);
  const day = twoDaysAgo();
  await handler(answer(9102, `all on ${dayWords(day)}`, list));
  const byAmount = Object.fromEntries(approvals().map((c) => [c.p_amount, c]));
  assertEquals(byAmount[20].p_occurred_at, own);
  assertEquals(byAmount[20].p_date_confirmed, undefined);
  assertEquals(byAmount[45.5].p_occurred_at, day);
  assertEquals(byAmount[45.5].p_date_confirmed, true);
});

// Review Focus 2.
freshTest("a number not on the list does nothing", async () => {
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  await handler(answer(9102, `1, 3 on ${dayWords(twoDaysAgo())}`, list));
  await handler(answer(9103, "drop 5", list));
  await handler(answer(9104, "drop", list));
  assertEquals(approvals().length, 0);
  assert(capturedIntake().every((r) => r.status === "pending"));
  assert(lastReply().includes("drop 4"), lastReply());
});

// Review Focus 3.
freshTest("the other member's reply does nothing", async () => {
  backend.tables.household_members.push({ id: PARTNER, household_id: HOUSEHOLD, display_name: "Partner", telegram_user_id: PARTNER_TELEGRAM, role: "member" });
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  // Read as it would be if it reached the parser: nothing.
  backend.parse = [];
  await handler(partnerUpdate(9102, { message_id: 3, date: 1, text: `all on ${dayWords(twoDaysAgo())}`, reply_to_message: { message_id: list } }));
  assertEquals(approvals().length, 0);
  assertEquals(capturedIntake().filter((r) => r.member_id === MEMBER).map((r) => r.status), ["pending", "pending"]);
});

// Review Focus 5.
freshTest("a reply delivered again records nothing twice", async () => {
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  await handler(answer(9102, `all on ${dayWords(twoDaysAgo())}`, list));
  await handler(answer(9103, `all on ${dayWords(twoDaysAgo())}`, list));
  assertEquals(approvals().length, 2);
  assert(lastReply().includes("already settled"), lastReply());
});

freshTest("two alike entries on one list are both recorded, not taken for each other", async () => {
  const list = await paste([sms("City Taxi", 20), sms("City Taxi", 20)]);
  // The first one's record is in place when the second is checked for repeats.
  await handler(answer(9102, `all on ${dayWords(twoDaysAgo())}`, list));
  assertEquals(approvals().length, 2);
  assertEquals(lastReply(), `Recorded 2 on ${dayWords(twoDaysAgo())}.`);
});

freshTest("a bare yes, or a thumbs up, on the list says how to reply", async () => {
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  await handler(answer(9102, "yes", list));
  assert(lastReply().includes('"all on'), lastReply());
  const sent = backend.telegramSent.length;
  await handler(reactionUpdate(9103, list, "👍"));
  assertEquals(backend.telegramSent.length, sent + 1);
  assert(lastReply().includes('"all on'), lastReply());
  assertEquals(approvals().length, 0);
});

freshTest("an unaddressed all on a date with a list open says to reply to the list", async () => {
  await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  await handler(textUpdate(9102, `all on ${dayWords(twoDaysAgo())}`));
  assertEquals(approvals().length, 0);
  assert(lastReply().includes("reply to the list"), lastReply());
  assertEquals(capturedIntake().length, 2);
});

// --- The fresh review's findings -----------------------------------------

freshTest("a bare yes for a single entry is not blocked by a list with nothing ready for a yes", async () => {
  await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  backend.parse = [sms("Book Shop", 60, { occurred_at: dubaiToday(), date_stated: true })];
  await handler(textUpdate(9102, "one more"));
  assert(lastReply().includes('reply "yes" to record it'), lastReply());
  await handler(textUpdate(9103, "yes"));
  assertEquals(approvals().map((c) => c.p_merchant), ["Book Shop"]);
});

freshTest("an entry changed in the Inbox after the list was sent is left there, not recorded as changed", async () => {
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  capturedIntake().find((r) => r.parsed_merchant === "City Taxi")!.parsed_amount = 999;
  await handler(answer(9102, `all on ${dayWords(twoDaysAgo())}`, list));
  assertEquals(approvals().map((c) => c.p_amount), [45.5]);
  assert(lastReply().includes("changed in the Inbox"), lastReply());
});

freshTest("a reply whose list cannot be seen records nothing", async () => {
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  await handler(replyUpdate(9102, `all on ${dayWords(twoDaysAgo())}`, list));
  assertEquals(approvals().length, 0);
});

freshTest("a day weeks ahead is refused, not read as last year", async () => {
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  const ahead = new Date(Date.parse(`${dubaiToday()}T00:00:00Z`) + 45 * 86400000).toISOString().slice(0, 10);
  await handler(answer(9102, `all on ${dayWords(ahead)}`, list));
  assertEquals(approvals().length, 0);
});

freshTest("a day after the paste is refused", async () => {
  fixtures();
  backend.now = Date.now() - 3 * 86400000;
  backend.parse = [sms("City Taxi", 20), sms("Corner Shop", 45.5)];
  await handler(textUpdate(9101, "pasted bank texts"));
  listText = lastReply();
  const list = listId();
  await handler(answer(9102, "all today", list));
  assertEquals(approvals().length, 0);
  assert(lastReply().includes("pasted"), lastReply());
});

freshTest("an expense that starts with drop is captured while a list is open", async () => {
  await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  backend.parse = [sms("Laundry", 25, { occurred_at: dubaiToday(), date_stated: true, source: "typed" })];
  await handler(textUpdate(9102, "drop-off laundry 25"));
  assertEquals(capturedIntake().length, 3);
});
