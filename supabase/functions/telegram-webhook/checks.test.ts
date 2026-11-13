// The morning checks: reminders, autopay, categories from history, card statements, and the Inbox reason.
// The fake backend these drive the real handler against is testing/harness.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { backend, BANK, capturedIntake, dailyCheck, dubaiDaysAgo, dubaiToday, EMI, freshTest, handler, HOUSEHOLD, inboxReason, lastReply, MEMBER, PARTNER_TELEGRAM, partnerUpdate, reactionUpdate, replyUpdate, Row, sendablePeriod, TELEGRAM_USER, textUpdate } from "./testing/harness.ts";

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

// Round 2 of the outside review (D2-4): a reminder Telegram refused (an
// ok:false, a 429 say) was recorded as sent, so it was never sent again.
freshTest("a reminder Telegram refuses is not recorded as sent, and goes out on the next run", async () => {
  backend.tables.recurring_nudges = [];
  backend.tables.recurring.push({
    id: "a9000000-0000-4000-8000-0000000000e2", household_id: HOUSEHOLD, name: "Rent", owner_member_id: null, is_shared: true, amount: -500,
    next_due_date: dubaiDaysAgo(4), ends_on: null, cadence: "monthly", interval_count: 1, account_id: BANK, category_id: null, active: true, autopay: false,
  });
  backend.faults.refuseFirstSends = 1000;
  const refused = await handler(dailyCheck());
  await refused.body?.cancel();
  assertEquals(backend.tables.recurring_nudges.length, 0, "a refused reminder was recorded as sent");

  backend.faults.refuseFirstSends = 0;
  backend.telegramSent.length = 0;
  const next = await handler(dailyCheck());
  await next.body?.cancel();
  assert(backend.telegramSent.some((m) => String(m.body.text).startsWith('I don\'t see a transaction for "Rent"')), "the reminder was not sent again");
  assertEquals(backend.tables.recurring_nudges.length, 1);
});

// The fresh review of round 2: a member Telegram refuses for good (who
// blocked the bot) left the reminder unrecorded, so the other member was sent
// it again on every run. A refusal for good is not tried again.
freshTest("a member who blocked the bot does not make the other get a reminder every day", async () => {
  backend.tables.recurring_nudges = [];
  backend.tables.household_members.push({ id: "a9000000-0000-4000-8000-0000000000f1", household_id: HOUSEHOLD, display_name: "Partner", telegram_user_id: 7700, role: "member" });
  backend.tables.recurring.push({
    id: "a9000000-0000-4000-8000-0000000000e3", household_id: HOUSEHOLD, name: "Rent", owner_member_id: null, is_shared: true, amount: -500,
    next_due_date: dubaiDaysAgo(4), ends_on: null, cadence: "monthly", interval_count: 1, account_id: BANK, category_id: null, active: true, autopay: false,
  });
  backend.faults.blockedChats = [7700];
  for (let run = 0; run < 3; run += 1) {
    const res = await handler(dailyCheck());
    await res.body?.cancel();
  }
  const toMe = backend.telegramSent.filter((m) => Number(m.body.chat_id) === TELEGRAM_USER && String(m.body.text).startsWith('I don\'t see a transaction for "Rent"'));
  assertEquals(toMe.length, 1, "the reachable member was sent the reminder again");
  assertEquals(backend.tables.recurring_nudges.length, 1);
});

// The fresh review of round 2: the weekly brief, the monthly review and the
// balance check-in were tried only on their own day, so one refused then
// (the job runs once a day) was never sent. Each may still go out on the two
// days after, for the same period, while unsent.
Deno.test("a weekly or monthly message may still be sent on the two days after its own", () => {
  // 9 November 2026 is a Monday.
  assertEquals(sendablePeriod("2026-11-09", "weekly"), "2026-11-09");
  assertEquals(sendablePeriod("2026-11-11", "weekly"), "2026-11-09");
  assertEquals(sendablePeriod("2026-11-12", "weekly"), null);
  assertEquals(sendablePeriod("2026-11-08", "weekly"), null);
  assertEquals(sendablePeriod("2026-11-01", "monthly"), "2026-10");
  assertEquals(sendablePeriod("2026-11-03", "monthly"), "2026-10");
  assertEquals(sendablePeriod("2026-11-04", "monthly"), null);
  assertEquals(sendablePeriod("2027-01-02", "monthly"), "2026-12");
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

// D-05: the question keeps the account and category it named, so a "yes"
// after the bill changed records nothing and says why.
freshTest("an autopay question keeps the bill's account, and a changed bill records nothing", async () => {
  const proposal = await askedEmi();
  assertEquals((proposal.payload as Row).account_id, BANK);
  assertEquals((proposal.payload as Row).category_id, null);
  const bill = backend.tables.recurring.find((r) => r.id === EMI)!;
  bill.account_id = "a7000000-0000-4000-8000-0000000000b2";
  await handler(reactionUpdate(9201, Number(proposal.prompt_message_id), "👍"));
  assertEquals(backend.tables.transactions.length, 0);
  assert(/^Car EMI has moved to another account or category in Rokda since I asked/.test(lastReply()), lastReply());
  // Not a dead end: the question stays open, and the morning check asks
  // again about the bill as it is now.
  assert(lastReply().includes("I'll ask again tomorrow"), lastReply());
  assertEquals(proposal.status, "proposed");
  (proposal.payload as Row).last_asked_on = "2000-01-01";
  const res = await handler(dailyCheck());
  await res.body?.cancel();
  assertEquals(autopayQuestions().length, 2, "the bill was not asked about again");
});

// The fresh review of the second group: a bill taken off autopay, or
// stopped, is never asked about again, so a question left open for it would
// stay open all cycle and make every bare "yes" ambiguous. It is closed.
freshTest("a yes after the bill came off autopay closes its question and says it won't ask again", async () => {
  const proposal = await askedEmi();
  const bill = backend.tables.recurring.find((r) => r.id === EMI)!;
  bill.autopay = false;
  await handler(textUpdate(9301, "paid"));
  assertEquals(backend.tables.transactions.length, 0);
  assert(/^Car EMI is no longer on autopay in Rokda/.test(lastReply()), lastReply());
  assertEquals(proposal.status, "expired");
  // Nothing is left waiting for a bare answer.
  await handler(textUpdate(9302, "yes"));
  assert(!lastReply().includes("More than one thing is waiting"), lastReply());
});

// The outside review's own review: the morning reminder names the bill's
// account as it is that day, so the question it answers must be that one.
freshTest("a reminder after the bill moved account asks about the new one, and its yes records there", async () => {
  const proposal = await askedEmi();
  const first = Number(proposal.prompt_message_id);
  const bill = backend.tables.recurring.find((r) => r.id === EMI)!;
  bill.account_id = "a7000000-0000-4000-8000-0000000000b2";
  bill.accounts = { name: "Other bank" };
  (proposal.payload as Row).last_asked_on = "2000-01-01";
  const res = await handler(dailyCheck());
  await res.body?.cancel();
  const reminder = autopayQuestions()[1];
  assert(String(reminder.body.text).includes("Other bank"), String(reminder.body.text));
  assertEquals((proposal.payload as Row).account_id, "a7000000-0000-4000-8000-0000000000b2");
  assertEquals((proposal.payload as Row).account_name, "Other bank");
  // A 👍 on the question that named the old account no longer answers it.
  assertEquals(((proposal.payload as Row).asked_message_ids as number[]).includes(first), false);

  await handler(reactionUpdate(9202, Number(proposal.prompt_message_id), "👍"));
  assertEquals(backend.tables.transactions.length, 1);
  assertEquals(backend.tables.transactions[0].account_id, "a7000000-0000-4000-8000-0000000000b2");
  assert(/^Recorded: Car EMI/.test(lastReply()), lastReply());
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

// Asked once when it closes and reminded once before it is due, no more
// (the feature review, November 2026: daily questions were most of what the
// bot sent).
freshTest("the next morning asks nothing; three days before it is due, one reminder; a 👍 on the first question marks it done", async () => {
  const row = await askedStatement();
  const first = Number((row.asked_prompts as Row[])[0].message_id);
  row.last_asked_on = dubaiDaysAgo(1);
  const quiet = await handler(dailyCheck());
  await quiet.body?.cancel();
  assertEquals(statementQuestions().length, 1);

  row.last_asked_on = dubaiDaysAgo(10);
  row.due_date = dubaiDaysAgo(-2);
  const res = await handler(dailyCheck());
  await res.body?.cancel();
  assertEquals(statementQuestions().length, 2);
  assert(String(statementQuestions()[1].body.text).startsWith("Reminder: the Bank card statement"), String(statementQuestions()[1].body.text));

  await handler(reactionUpdate(9211, first, "👍"));
  assertEquals(row.status, "confirmed");
  assertEquals(row.closed_by_member_id, MEMBER);
  assert(/is marked as done\.$/.test(lastReply()), lastReply());

  // Done means no more questions.
  row.last_asked_on = dubaiDaysAgo(10);
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
  assert(/stays open/.test(lastReply()), lastReply());
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

function addPartner(): void {
  backend.tables.household_members.push({ id: PARTNER_MEMBER, household_id: HOUSEHOLD, display_name: "Partner", telegram_user_id: PARTNER_TELEGRAM, role: "member" });
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

freshTest("\"sent to Claude\" keeps the statement waiting, and asks nothing more the next morning", async () => {
  const row = await askedStatement();
  await handler(replyUpdate(9227, "sent to Claude", firstPrompt(row)));
  assertEquals(row.status, "waiting");
  assert(/until it has been checked/.test(lastReply()), lastReply());
  row.last_asked_on = dubaiDaysAgo(1);
  const later = await handler(dailyCheck());
  await later.body?.cancel();
  assertEquals(statementQuestions().length, 1);
});

// ---------------------------------------------------------------------------
// An expense the bot cannot record yet says so, and why
// ---------------------------------------------------------------------------

Deno.test("an expense sent to the Inbox says it is not recorded yet, and what was missing", () => {
  const ready = { parsed_amount: 200, parsed_merchant: "du", parsed_account_id: "a", parsed_category_id: "c", parsed_currency: "AED", confidence: 1 };
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
  backend.tables.accounts.push({ id: "a9000000-0000-4000-8000-000000000001", household_id: HOUSEHOLD, name: "ENBD Marriott •0002", type: "credit_card", currency: "AED", archived_at: null });
  backend.parse = [{ merchant: null, amount: 200, currency: "AED", occurred_at: "2026-10-13", date_stated: true, source: "typed", category: null, card_last4: null, account_hint: "ENBD Marriott", confidence: 0.9, kind: "expense" }];
  await handler(textUpdate(9301, "Du wifi paid today using marriot card 200"));
  assertEquals(capturedIntake().length, 1);
  assert(/^Not recorded yet: I couldn't tell who was paid/.test(lastReply()), lastReply());
  // The parser is told that a biller named in passing is the merchant.
  assert(backend.parsePrompts[0].includes("is who was paid"), "the parser was not told what a merchant is");
});
