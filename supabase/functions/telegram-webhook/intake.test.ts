// Reading a message: cards named loosely, dates, corrections, and what the capture reply says.
// The fake backend these drive the real handler against is testing/harness.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { backend, capturedIntake, dubaiToday, datedItems, FAB, FAB_Z, forwardedDay, freshTest, handler, HOUSEHOLD, lastReply, MARRIOTT, MEMBER, NOON, photoUpdate, pickAccountByHint, replyUpdate, TELEGRAM_USER, textUpdate, undatedNote } from "./testing/harness.ts";

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

// A paste a week after the first repeated 14 entries already recorded, and
// nothing said so (the feature review, November 2026).
freshTest("a paste says which of its undated entries look already recorded", async () => {
  backend.tables.accounts.push(MARRIOTT, NOON);
  const today = dubaiToday();
  const weekAgo = new Date(Date.parse(today) - 7 * 86400000).toISOString().slice(0, 10);
  backend.tables.transactions.push({ id: "t-old", household_id: HOUSEHOLD, account_id: NOON.id, amount: -20, kind: "expense", merchant: "CITY TAXI, DUBAI", occurred_at: weekAgo });
  const sms = (merchant: string, amount: number) => ({ merchant, amount, currency: "AED", occurred_at: null, date_stated: false, source: "bank_sms", category: null, card_last4: null, account_hint: "ENBD Noon", confidence: 1, kind: "expense" });
  backend.parse = [sms("CITY TAXI", 20), sms("Corner Shop", 50)];
  await handler(textUpdate(7110, "Purchase of AED 20.00 at CITY TAXI. Purchase of AED 50.00 at CORNER SHOP"));
  assertEquals(capturedIntake().filter((r) => r.status === "pending").length, 2);
  assert(lastReply().includes("1 looks already recorded (CITY TAXI, AED 20.00): it's marked in the Inbox, to set aside."), lastReply());
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

// D-01: a correction changes the figures, so the question that showed the
// old ones must stop resolving to the entry, even when no new question about
// the corrected figures could be asked.
freshTest("a correction unbinds the question it replaced, so a yes to that question records nothing", async () => {
  backend.tables.accounts.push(MARRIOTT, NOON);
  backend.tables.categories.push({ id: "cat-dining", household_id: HOUSEHOLD, name: "Dining Out", archived: false, is_savings: false });
  backend.tables.intake.push({
    id: "99990000-0000-4000-8000-000000000011", household_id: HOUSEHOLD, member_id: MEMBER, status: "pending", raw_text: "Noon 40",
    created_at: new Date().toISOString(), parsed_merchant: "Noon", parsed_amount: 40, parsed_date: "2026-09-24", parsed_category_id: "cat-dining",
    parsed_account_id: NOON.id, parsed_currency: "AED", parsed_kind: "expense", confidence: 1, date_guessed: false,
    confirm_chat_id: TELEGRAM_USER, confirm_message_id: 555,
  });
  backend.route = { tool: "update_last_expense", args: {} };
  backend.parse = [{ merchant: "Noon", amount: 45, currency: "AED", occurred_at: "2026-09-24", date_stated: true, source: "typed", category: "Dining Out", card_last4: null, account_hint: "ENBD Noon", confidence: 1, kind: "expense" }];
  // The question about the corrected figures never reaches the member.
  backend.faults.refuseFirstSends = 1;
  await handler(replyUpdate(7111, "actually 45", 555));
  const corrected = backend.tables.intake.find((r) => r.id === "99990000-0000-4000-8000-000000000011")!;
  assertEquals(corrected.parsed_amount, 45);
  assertEquals(corrected.confirm_message_id, null, "the question about 40 still points at the entry");

  await handler(replyUpdate(7112, "yes", 555));
  assertEquals(backend.approveCalls, 0, "a yes to the question about 40 recorded 45");
  assert(lastReply().includes("I can't tell which entry that reply is about"), lastReply());
});

freshTest("a correction to an entry recorded in the meantime says so, not that it was updated", async () => {
  backend.tables.intake.push({
    id: "99990000-0000-4000-8000-000000000012", household_id: HOUSEHOLD, member_id: MEMBER, status: "pending", raw_text: "Noon 40",
    created_at: new Date().toISOString(), parsed_merchant: "Noon", parsed_amount: 40, parsed_date: "2026-09-24", parsed_category_id: null,
    parsed_account_id: null, parsed_currency: "AED", parsed_kind: "expense", confidence: 1, date_guessed: false,
    confirm_chat_id: TELEGRAM_USER, confirm_message_id: 556,
  });
  backend.route = { tool: "update_last_expense", args: {} };
  backend.parse = [{ merchant: "Noon", amount: 45, currency: "AED", occurred_at: "2026-09-24", date_stated: true, source: "typed", category: null, card_last4: null, account_hint: null, confidence: 1, kind: "expense" }];
  // Approved in the Inbox while the correction was being read.
  backend.onAiCall = () => { backend.tables.intake.find((r) => r.id === "99990000-0000-4000-8000-000000000012")!.status = "approved"; };
  await handler(replyUpdate(7113, "actually 45", 556));
  assertEquals(backend.tables.intake.find((r) => r.id === "99990000-0000-4000-8000-000000000012")!.parsed_amount, 40);
  assert(lastReply().includes("already been recorded or changed"), lastReply());
});

// What the Inbox is for: entries someone can approve. A message read in full
// that holds no expense, income or refund is answered, not left there (the
// feature review, November 2026: a correction with nothing to correct, a
// note, a question).
freshTest("a message read in full that holds no expense is not left in the Inbox", async () => {
  backend.route = { tool: "log_expense", args: {} };
  backend.parse = [];
  await handler(textUpdate(7801, "small correction, it was spent on 5th September"));
  assertEquals(capturedIntake().filter((r) => r.status === "pending").length, 0);
  assertEquals(lastReply(), 'I didn\'t find an expense, income or refund in that, so nothing is waiting in the Inbox. To record one, send the amount and who was paid, like "45 at Noon".');
});

// The no-digit rule is for a message nothing could read. One the router
// called an expense goes to the parser, which reads an amount in words (the
// fresh review of this change).
freshTest("an expense with its amount in words is read, not turned away for having no digit", async () => {
  backend.route = { tool: "log_expense", args: {} };
  backend.parse = [{ merchant: "Plumber", amount: 50, currency: "AED", occurred_at: "2026-09-24", date_stated: true, source: "typed", category: null, card_last4: null, account_hint: null, confidence: 0.9, kind: "expense" }];
  await handler(textUpdate(7802, "paid fifty to the plumber today"));
  assertEquals(capturedIntake().filter((r) => r.status === "pending").map((r) => r.parsed_amount), [50]);
});

freshTest("a message routed as an expense in which the parser finds none is answered", async () => {
  backend.route = { tool: "log_expense", args: {} };
  backend.parse = [];
  await handler(textUpdate(7804, "bought coffee"));
  assertEquals(capturedIntake().filter((r) => r.status === "pending").length, 0);
  assert(lastReply().startsWith("I didn't find an expense, income or refund in that"), lastReply());
});

// An answer the parser could not use is not an answer of "nothing": the
// message waits in the Inbox, as it did before.
freshTest("a bank SMS whose reading came back unusable still waits in the Inbox", async () => {
  backend.route = { tool: "log_expense", args: {} };
  backend.parseRaw = { items: null };
  await handler(textUpdate(7805, "Purchase of AED 40.00 with Credit Card ending 0001 at CAFE"));
  assertEquals(capturedIntake().filter((r) => r.status === "pending").length, 1);
  backend.parseRaw = { items: [{ merchant: null, amount: "forty" }] };
  await handler(textUpdate(7806, "Purchase of AED 40.00 with Credit Card ending 0001 at CAFE"));
  assertEquals(capturedIntake().filter((r) => r.status === "pending").length, 2);
});

freshTest("a message set aside is not said to be in the Inbox when Telegram delivers it again", async () => {
  backend.route = { tool: "log_expense", args: {} };
  backend.parse = [];
  await handler(textUpdate(7807, "it was on the 5th"));
  backend.log.delete(7807);
  await handler(textUpdate(7807, "it was on the 5th"));
  assert(lastReply().startsWith("I didn't find an expense, income or refund in that"), lastReply());
});

freshTest("a photo the parser finds nothing in still waits in the Inbox to be read by a person", async () => {
  backend.parse = [];
  await handler(photoUpdate(7803, "my receipt"));
  assertEquals(capturedIntake().filter((r) => r.status === "pending").length, 1);
});

