// A paste of several entries is answered with a numbered list, and a reply to
// the list records or sets aside those entries (batch.ts, batchReview.ts).
// The fake backend these drive the real handler against is testing/harness.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { backend, CARD, capturedIntake, dubaiDaysAgo, dubaiToday, freshTest, handler, HOUSEHOLD, lastReply, MEMBER, PARTNER, PARTNER_TELEGRAM, partnerUpdate, reactionUpdate, replyUpdate, type Row, tapUpdate, TELEGRAM_USER, textUpdate } from "./testing/harness.ts";
// After the harness, which sets the environment env.ts reads.
import { LIST_QUESTION_ALL } from "./batch.ts";
import { BATCH_UNADDRESSED_HINT, LIST_TAP_RECORD_ALL, LIST_WHICH_DAY } from "./batchReview.ts";

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
  // The list, not a question about an entry that may follow it (choices.ts).
  const at = backend.telegramSent.findLastIndex((m) => / from that message$/m.test(String(m.body.text)));
  if (at < 0) {
    listText = lastReply();
    return listId();
  }
  listText = String(backend.telegramSent[at].body.text);
  return 1001 + at;
}

const twoDaysAgo = () => dubaiDaysAgo(2);
const dayWords = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

type Button = { text: string; callback_data?: string };

function buttonsOf(body: Row | undefined): Button[] {
  return (((body?.reply_markup as Row | undefined)?.inline_keyboard ?? []) as Button[][]).flat();
}

function calls(method: string, messageId?: number): Row[] {
  return backend.telegramCalls.filter((c) => c.method === method && (messageId == null || c.body.message_id === messageId)).map((c) => c.body);
}

// The list as it stands now: its last edit, or as it was sent.
function listNow(list: number): { text: string; buttons: Button[] } {
  const sent = backend.telegramSent[list - 1001].body;
  const edits = calls("editMessageText", list);
  const markups = calls("editMessageReplyMarkup", list);
  const text = String((edits.at(-1) ?? sent).text);
  // The buttons are the latest of the edits that set them.
  const lastEditAt = backend.telegramCalls.findLastIndex((c) => c.method === "editMessageText" && c.body.message_id === list);
  const lastMarkupAt = backend.telegramCalls.findLastIndex((c) => c.method === "editMessageReplyMarkup" && c.body.message_id === list);
  const buttons = lastMarkupAt > lastEditAt ? buttonsOf(markups.at(-1)) : buttonsOf(edits.at(-1) ?? sent);
  return { text, buttons };
}

// A tap on one of the list's buttons, as Telegram sends it: with the list's text.
async function tapList(updateId: number, list: number, label: string, from = TELEGRAM_USER): Promise<void> {
  const now = listNow(list);
  const b = now.buttons.find((x) => x.text === label);
  assert(b?.callback_data, `no ${label} button among ${now.buttons.map((x) => x.text).join(" | ")}`);
  await handler(tapUpdate(updateId, list, b.callback_data, from, now.text));
}

function lastToast(): Row | undefined {
  return calls("answerCallbackQuery").at(-1);
}

// --- Sending the list ----------------------------------------------------

// Whether the last message sent offers Record (choices.ts).
function offersRecord(): boolean {
  const rows = ((backend.telegramSent.at(-1)?.body.reply_markup as Row | undefined)?.inline_keyboard ?? []) as Array<Array<{ text: string }>>;
  return rows.flat().some((b) => b.text === "Record");
}

freshTest("a paste of several entries is answered with a numbered list, each entry bound to it, and the days to record them on", async () => {
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5), sms("Fresh Market", 120)]);
  assertEquals(lastReply().split("\n"), [
    "3 from that message",
    "1. City Taxi · AED 20 · Transport · Card •0004",
    "2. Corner Shop · AED 45.50 · Groceries · Card •0004",
    "3. Fresh Market · AED 120 · Groceries · Card •0004",
    LIST_QUESTION_ALL,
  ]);
  assertEquals(listNow(list).buttons.map((b) => b.text), ["Today", "Yesterday", "Other day", "Choose…"]);
  assertEquals(capturedIntake().length, 3);
  for (const row of capturedIntake()) assertEquals(row.confirm_message_id, list);
});

freshTest("an entry already recorded, or missing a category, is named and not numbered", async () => {
  backend.tables.transactions.push({ id: "t-1", household_id: HOUSEHOLD, account_id: CARD.id, amount: 20, kind: "expense", merchant: "City Taxi", occurred_at: dubaiDaysAgo(1) });
  await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5), sms("Fresh Market", 120), sms("Odd Place", 30, { category: "Nothing like it" })]);
  const text = listText;
  assert(text.startsWith("4 from that message"), text);
  assert(text.includes("\n1. Corner Shop · AED 45.50"), text);
  assert(text.includes("\n2. Fresh Market · AED 120"), text);
  assert(!text.includes("\n3. "), text);
  assert(text.includes("\nAlready recorded, left out · City Taxi · AED 20"), text);
  assert(text.includes("\nIn the Inbox · Odd Place · needs a category"), text);
  const bound = capturedIntake().filter((r) => r.confirm_message_id != null).map((r) => r.parsed_merchant);
  assertEquals(bound.sort(), ["Corner Shop", "Fresh Market"]);
});

freshTest("more than 20 entries: 20 are numbered and the rest wait in the Inbox", async () => {
  await paste(Array.from({ length: 23 }, (_, i) => sms(`Shop ${i + 1}`, 10 + i)));
  const text = lastReply();
  assert(text.includes("\n20. Shop 20 · "), text);
  assert(!text.includes("\n21. "), text);
  assert(text.includes("\nIn the Inbox · 3 more · a list takes 20"), text);
  assertEquals(capturedIntake().filter((r) => r.confirm_message_id != null).length, 20);
});

freshTest("one entry is offered Record, not a list", async () => {
  await paste([sms("City Taxi", 20, { occurred_at: dubaiToday(), date_stated: true })]);
  assert(offersRecord(), lastReply());
});

// --- Acting on a reply ---------------------------------------------------

freshTest("all on a date records every listed entry on it, each marked as confirmed, and the list shows them recorded", async () => {
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  const day = twoDaysAgo();
  await handler(answer(9102, `all on ${dayWords(day)}`, list));
  const made = approvals();
  assertEquals(made.length, 2);
  for (const c of made) {
    assertEquals(c.p_occurred_at, day);
    assertEquals(c.p_date_confirmed, true);
    assertEquals(c.p_currency, "AED");
  }
  assertEquals(lastReply(), `Recorded 2 on ${dayWords(day)}.`);
  assertEquals(listNow(list).text.split("\n").slice(1), ["✓ City Taxi · AED 20 · Transport · Card •0004", "✓ Corner Shop · AED 45.50 · Groceries · Card •0004"]);
  assertEquals(listNow(list).buttons, []);
});

freshTest("some on a date records those, and the rest wait", async () => {
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  await handler(answer(9102, `1 on ${dayWords(twoDaysAgo())}`, list));
  assertEquals(approvals().length, 1);
  assertEquals(approvals()[0].p_amount, 20);
  assertEquals(lastReply(), `Recorded 1 on ${dayWords(twoDaysAgo())} · 1 still on the list.`);
  assertEquals(listNow(list).text.split("\n").slice(1, 3), ["✓ City Taxi · AED 20 · Transport · Card •0004", "2. Corner Shop · AED 45.50 · Groceries · Card •0004"]);
  assertEquals(listNow(list).buttons.map((b) => b.text), ["Today", "Yesterday", "Other day", "Choose…"]);
});

freshTest("drop sets an entry aside", async () => {
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  await handler(answer(9102, "drop 2", list));
  const byMerchant = Object.fromEntries(capturedIntake().map((r) => [r.parsed_merchant, r.status]));
  assertEquals(byMerchant, { "City Taxi": "pending", "Corner Shop": "rejected" });
  assertEquals(approvals().length, 0);
  assertEquals(lastReply(), "Cancelled 1 · 1 still on the list.");
  assertEquals(listNow(list).text.split("\n")[2], "Cancelled · Corner Shop · AED 45.50 · Groceries · Card •0004");
});

freshTest("a list of dated entries takes all alone, and refuses a date given", async () => {
  const day = dubaiDaysAgo(3);
  const list = await paste([sms("City Taxi", 20, { occurred_at: day, date_stated: true }), sms("Corner Shop", 45.5, { occurred_at: day, date_stated: true })]);
  assertEquals(listNow(list).buttons.map((b) => b.text), ["Record all", "Choose…"]);
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

freshTest("a bare yes, or a thumbs up, on a list with no dates asks which day", async () => {
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  await handler(answer(9102, "yes", list));
  assertEquals(lastReply(), LIST_WHICH_DAY);
  const sent = backend.telegramSent.length;
  await handler(reactionUpdate(9103, list, "👍"));
  assertEquals(backend.telegramSent.length, sent + 1);
  assertEquals(lastReply(), LIST_WHICH_DAY);
  assertEquals(approvals().length, 0);
});

freshTest("a yes to a list whose entries each have their day records them all", async () => {
  const day = dubaiDaysAgo(3);
  const list = await paste([sms("City Taxi", 20, { occurred_at: day, date_stated: true }), sms("Corner Shop", 45.5, { occurred_at: day, date_stated: true })]);
  await handler(answer(9102, "yes", list));
  assertEquals(approvals().length, 2);
  assertEquals(lastReply(), `Recorded 2 on ${dayWords(day)}.`);
});

// A reaction carries no text, so it cannot be checked against what the list
// showed: it records nothing, and says what will.
freshTest("a thumbs-up on a list whose entries each have their day says to tap Record all, and records nothing", async () => {
  const day = dubaiDaysAgo(3);
  const list = await paste([sms("City Taxi", 20, { occurred_at: day, date_stated: true }), sms("Corner Shop", 45.5, { occurred_at: day, date_stated: true })]);
  await handler(reactionUpdate(9102, list, "👍"));
  assertEquals(approvals().length, 0);
  assertEquals(lastReply(), LIST_TAP_RECORD_ALL);
});

freshTest("an unaddressed all on a date with a list open says to reply to the list", async () => {
  await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  await handler(textUpdate(9102, `all on ${dayWords(twoDaysAgo())}`));
  assertEquals(approvals().length, 0);
  assertEquals(lastReply(), BATCH_UNADDRESSED_HINT);
  assertEquals(capturedIntake().length, 2);
});

// The fresh review of 8b: a "no" sets an expense aside, and a bare one with a
// list open could take an entry of the list and write over the list.
freshTest("a bare no with a list open says to reply to the list, and sets nothing aside", async () => {
  const list = await paste([sms("City Taxi", 20, { occurred_at: dubaiToday(), date_stated: true }), sms("Corner Shop", 45.5)]);
  const edits = backend.telegramCalls.filter((c) => c.method === "editMessageText").length;
  await handler(textUpdate(9102, "no"));
  assertEquals(lastReply(), BATCH_UNADDRESSED_HINT);
  assertEquals(capturedIntake().map((r) => r.status), ["pending", "pending"]);
  assertEquals(backend.telegramCalls.filter((c) => c.method === "editMessageText" && c.body.message_id === list).length, 0);
  assertEquals(backend.telegramCalls.filter((c) => c.method === "editMessageText").length, edits);
});

// --- The fresh review's findings -----------------------------------------

freshTest("a bare yes for a single entry is not blocked by a list with nothing ready for a yes", async () => {
  await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  backend.parse = [sms("Book Shop", 60, { occurred_at: dubaiToday(), date_stated: true })];
  await handler(textUpdate(9102, "one more"));
  assert(offersRecord(), lastReply());
  await handler(textUpdate(9103, "yes"));
  assertEquals(approvals().map((c) => c.p_merchant), ["Book Shop"]);
});

freshTest("an entry changed in the Inbox after the list was sent is left there, not recorded as changed", async () => {
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  capturedIntake().find((r) => r.parsed_merchant === "City Taxi")!.parsed_amount = 999;
  await handler(answer(9102, `all on ${dayWords(twoDaysAgo())}`, list));
  assertEquals(approvals().map((c) => c.p_amount), [45.5]);
  assertEquals(lastReply(), `Recorded 1 on ${dayWords(twoDaysAgo())} · 1 in the Inbox.`);
  assertEquals(listNow(list).text.split("\n")[1], "In the Inbox · City Taxi · changed since");
});

freshTest("a reply whose list cannot be seen records nothing", async () => {
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  await handler(replyUpdate(9102, `all on ${dayWords(twoDaysAgo())}`, list));
  assertEquals(approvals().length, 0);
});

// A day still to come this year, up to weeks ahead. Weeks ahead from mid
// November is January, and "1 Jan" said then is this past January, rightly
// recorded (batch.ts readBatchDate), so the day stays in this year. On 31
// December no day of the year is still to come; batch.test.ts holds the rule
// with fixed dates.
freshTest("a day still to come is refused, not read as last year", async () => {
  const today = dubaiToday();
  if (today.endsWith("-12-31")) return;
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  const weeksAhead = new Date(Date.parse(`${today}T00:00:00Z`) + 45 * 86400000).toISOString().slice(0, 10);
  const ahead = [weeksAhead, `${today.slice(0, 4)}-12-31`].sort()[0];
  await handler(answer(9102, `all on ${dayWords(ahead)}`, list));
  assertEquals(approvals().length, 0);
  assert(lastReply().includes("still to come"), lastReply());
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

// --- The list's buttons (the revamp, phase 8b) ---------------------------------

freshTest("Today records every entry with no day on today, and the list shows them recorded", async () => {
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  await tapList(9102, list, "Today");
  assertEquals(approvals().map((c) => [c.p_occurred_at, c.p_date_confirmed]), [[dubaiToday(), true], [dubaiToday(), true]]);
  assertEquals(listNow(list).text.split("\n").slice(1), ["✓ City Taxi · AED 20 · Transport · Card •0004", "✓ Corner Shop · AED 45.50 · Groceries · Card •0004"]);
  assertEquals(listNow(list).buttons, []);
  assertEquals(lastToast()?.text, `Recorded 2 on ${dayWords(dubaiToday())}.`);
});

freshTest("Yesterday records them on yesterday", async () => {
  fixtures();
  // Pasted yesterday: today would be after the paste.
  backend.now = Date.now() - 86400000;
  backend.parse = [sms("City Taxi", 20), sms("Corner Shop", 45.5)];
  await handler(textUpdate(9101, "pasted bank texts"));
  const list = listId();
  await tapList(9102, list, "Today");
  assertEquals(approvals().length, 0);
  assert(String(lastToast()?.text).includes("pasted"), String(lastToast()?.text));
  assertEquals(lastToast()?.show_alert, true);
  await tapList(9103, list, "Yesterday");
  assertEquals(approvals().map((c) => c.p_occurred_at), [dubaiDaysAgo(1), dubaiDaysAgo(1)]);
});

freshTest("Other day says how to give the day, and records nothing", async () => {
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  await tapList(9102, list, "Other day");
  assertEquals(approvals().length, 0);
  assertEquals([lastToast()?.text, lastToast()?.show_alert], ['Reply to the list with the day, like "all on 2 Oct".', true]);
});

freshTest("Record all records a list whose entries each have their day", async () => {
  const day = dubaiDaysAgo(3);
  const list = await paste([sms("City Taxi", 20, { occurred_at: day, date_stated: true }), sms("Corner Shop", 45.5, { occurred_at: day, date_stated: true })]);
  await tapList(9102, list, "Record all");
  assertEquals(approvals().map((c) => [c.p_occurred_at, c.p_date_confirmed]), [[day, undefined], [day, undefined]]);
  assertEquals(listNow(list).buttons, []);
});

freshTest("Choose… ticks the entries tapped, and Today records only those", async () => {
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  await tapList(9102, list, "Choose…");
  assertEquals(listNow(list).buttons.map((b) => b.text), ["1. City Taxi · AED 20", "2. Corner Shop · AED 45.50", "Back"]);
  await tapList(9103, list, "1. City Taxi · AED 20");
  assertEquals(listNow(list).buttons.map((b) => b.text), ["✓ 1. City Taxi · AED 20", "2. Corner Shop · AED 45.50", "Today", "Yesterday", "Other day", "Set aside 1", "Back"]);
  await tapList(9104, list, "Today");
  assertEquals(approvals().map((c) => c.p_merchant), ["City Taxi"]);
  assertEquals(listNow(list).text.split("\n").slice(1, 3), ["✓ City Taxi · AED 20 · Transport · Card •0004", "2. Corner Shop · AED 45.50 · Groceries · Card •0004"]);
  assertEquals(listNow(list).buttons.map((b) => b.text), ["Today", "Yesterday", "Other day", "Choose…"]);
});

freshTest("Set aside from Choose… cancels those chosen, and Back shows the list's buttons again", async () => {
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  await tapList(9102, list, "Choose…");
  await tapList(9103, list, "Back");
  assertEquals(listNow(list).buttons.map((b) => b.text), ["Today", "Yesterday", "Other day", "Choose…"]);
  await tapList(9104, list, "Choose…");
  await tapList(9105, list, "2. Corner Shop · AED 45.50");
  await tapList(9106, list, "Set aside 1");
  assertEquals(capturedIntake().map((r) => r.status), ["pending", "rejected"]);
  assertEquals(listNow(list).text.split("\n")[2], "Cancelled · Corner Shop · AED 45.50 · Groceries · Card •0004");
  assertEquals(approvals().length, 0);
});

freshTest("a tap by someone else, or on a list that cannot be seen, records nothing", async () => {
  backend.tables.household_members.push({ id: PARTNER, household_id: HOUSEHOLD, display_name: "Partner", telegram_user_id: PARTNER_TELEGRAM, role: "member" });
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  const today = listNow(list).buttons.find((b) => b.text === "Today")!.callback_data!;
  await handler(tapUpdate(9102, list, today, PARTNER_TELEGRAM, listNow(list).text));
  assertEquals(lastToast()?.text, "That isn't one of yours.");
  await handler(tapUpdate(9103, list, today, TELEGRAM_USER, ""));
  assertEquals(approvals().length, 0);
  assertEquals(capturedIntake().map((r) => r.status), ["pending", "pending"]);
});

freshTest("a tap records only what the list shows: an entry changed in the Inbox since is left there", async () => {
  const list = await paste([sms("City Taxi", 20), sms("Corner Shop", 45.5)]);
  capturedIntake().find((r) => r.parsed_merchant === "Corner Shop")!.parsed_amount = 99;
  await tapList(9102, list, "Today");
  assertEquals(approvals().map((c) => c.p_amount), [20]);
  assertEquals(listNow(list).text.split("\n")[2], "In the Inbox · Corner Shop · changed since");
  assertEquals(lastToast()?.text, `Recorded 1 on ${dayWords(dubaiToday())} · 1 in the Inbox.`);
});
