// Proposals and their answers: balances, bare yes and no, questions Telegram refused.
// The fake backend these drive the real handler against is testing/harness.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { accountsForCheckin, acct, backend, buildBalanceCheckinMessage, capturedIntake, CARD, EPF, FD, freshTest, GOAL, handler, HOUSEHOLD, lastReply, MARRIOTT, MEMBER, MY_BANK, MY_CURRENT, NOON, PARTNER, pickCheckinAccount, reactionUpdate, replyUpdate, ROSTER, SAM_BANK, sendCount, TELEGRAM_USER, textUpdate } from "./testing/harness.ts";

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

// D-02: a bare answer is recorded with the update before it acts, so
// Telegram delivering it again answers what it first meant, never a question
// asked or an entry captured in between.
freshTest("a bare yes delivered again answers what it first meant, not a question asked since", async () => {
  seedCheckinHousehold();
  backend.route = { tool: "update_account_balances", args: { balances: [{ account: "Bank", balance: 10000 }] } };
  await handler(textUpdate(7361, "Bank 10,000"));
  backend.route = { tool: "log_expense", args: {} };
  backend.faults.failFirstSends = sendCount + 1;
  assertEquals((await handler(textUpdate(7362, "yes"))).status, 500);
  assertEquals(balancesOf().get(MY_BANK.id), 10000);
  // Before Telegram delivers the "yes" again, another question is asked.
  const later = "b0000000-0000-4000-8000-000000000362";
  backend.tables.bot_proposals.push({
    id: later, household_id: HOUSEHOLD, member_id: MEMBER, kind: "goal_contribution",
    payload: { goal_id: GOAL, goal_name: "House", amount: 500 }, chat_id: TELEGRAM_USER, source_ref: "7363", status: "proposed",
    prompt_message_id: 999, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), decided_at: null, result: null,
  });
  assertEquals((await handler(textUpdate(7362, "yes"))).status, 200);
  assertEquals(backend.applyCalls, 1, "the yes delivered again applied the question asked since");
  assertEquals(backend.tables.bot_proposals.find((r) => r.id === later)?.status, "proposed");
  assert(lastReply().startsWith("Already saved"), lastReply());
});

freshTest("a bare yes to an expense delivered again does not record one captured since", async () => {
  backend.tables.accounts.push(MARRIOTT, NOON);
  const entry = (id: string, merchant: string) => ({
    id, household_id: HOUSEHOLD, member_id: MEMBER, status: "pending", raw_text: `${merchant} 40`,
    created_at: new Date().toISOString(), parsed_merchant: merchant, parsed_amount: 40, parsed_date: "2026-09-24", parsed_category_id: "cat-dining",
    parsed_account_id: NOON.id, parsed_currency: "AED", parsed_kind: "expense", confidence: 1, date_guessed: false,
    confirm_chat_id: null, confirm_message_id: null,
  });
  backend.tables.intake.push(entry("99990000-0000-4000-8000-000000000371", "Cafe"));
  // The "Recorded" reply and the apology after it both fail.
  backend.faults.failFirstSends = sendCount + 2;
  assertEquals((await handler(textUpdate(7371, "yes"))).status, 500);
  assertEquals(backend.approveCalls, 1);
  backend.tables.intake.push(entry("99990000-0000-4000-8000-000000000372", "Bakery"));
  assertEquals((await handler(textUpdate(7371, "yes"))).status, 200);
  assertEquals(backend.approveCalls, 1, "the yes delivered again recorded the entry captured since");
  assertEquals(backend.tables.intake.find((r) => r.id === "99990000-0000-4000-8000-000000000372")?.status, "pending");
  assert(lastReply().startsWith("That one is already recorded"), lastReply());
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
