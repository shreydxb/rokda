// Dividends paid into a fund: the morning question and its answers, and dividends typed in as income.
// The fake backend these drive the real handler against is testing/harness.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { backend, capturedIntake, DIV_ABC, DIV_BANK, DIV_FUND, DIV_XYZ, dividendQuestions, dubaiToday, freshTest, handler, HOUSEHOLD, lastReply, MEMBER, morningCheck, PARTNER, PARTNER_TELEGRAM, partnerUpdate, PLAIN_QUESTION, reactionUpdate, replyUpdate, Row, seedDividends, TELEGRAM_USER, textUpdate } from "./testing/harness.ts";

freshTest("dividends due today in a fund are asked about once, in one message, and marked asked", async () => {
  seedDividends();
  const body = await morningCheck();
  assertEquals(body.dividends, { checked: 2, asked: 1 });
  const questions = dividendQuestions();
  assertEquals(questions.length, 1);
  assertEquals(questions[0].body.text, PLAIN_QUESTION);
  assertEquals(questions[0].body.chat_id, TELEGRAM_USER);
  const proposal = backend.tables.bot_proposals.find((p) => p.kind === "dividends_received")!;
  assert(proposal.prompt_message_id != null, "the question's id was not kept");
  assertEquals((proposal.payload as Row).ask, null);
  assertEquals(((proposal.payload as Row).lines as Row[]).map((l) => [l.dividend_id, l.version]), [[DIV_ABC, 1], [DIV_XYZ, 1]]);
  assert(backend.tables.holding_dividends.every((d) => d.asked_at != null), "not marked asked");

  // The same morning's check again, or the next: nothing more.
  await morningCheck();
  assertEquals(dividendQuestions().length, 1);
});

freshTest("a shared holding's dividends are asked of every linked member", async () => {
  backend.tables.household_members.push({ id: PARTNER, household_id: HOUSEHOLD, display_name: "Partner", telegram_user_id: PARTNER_TELEGRAM, role: "member" });
  seedDividends({ shared: true });
  await morningCheck();
  assertEquals(dividendQuestions().map((m) => m.body.chat_id).sort(), [TELEGRAM_USER, PARTNER_TELEGRAM].sort());
  assertEquals(new Set(backend.tables.bot_proposals.map((p) => p.member_id)), new Set([MEMBER, PARTNER]));
});

freshTest("a dividend not yet paid, or paid into a bank account, is not asked about", async () => {
  seedDividends();
  backend.tables.holding_dividends[0].pay_date = "2999-01-01";
  backend.tables.holding_dividends[1].paid_into_account_id = DIV_BANK;
  await morningCheck();
  assertEquals(dividendQuestions().length, 0);
  assertEquals(backend.tables.bot_proposals.length, 0);
});

freshTest("with dividend questions switched off, nothing is asked", async () => {
  seedDividends();
  backend.tables.telegram_notification_prefs.push({ household_id: HOUSEHOLD, dividends_enabled: false });
  await morningCheck();
  assertEquals(dividendQuestions().length, 0);
});

freshTest("a question that cannot be sent leaves nothing asked, so tomorrow asks again", async () => {
  seedDividends();
  backend.faults.failFirstSends = 99;
  await morningCheck();
  assertEquals(backend.tables.bot_proposals.length, 0);
  assert(backend.tables.holding_dividends.every((d) => d.asked_at == null), "marked asked though never sent");
});

freshTest("a fund confirmed on the pay date asks whether they were already in its balance", async () => {
  seedDividends({ confirmedToday: true });
  await morningCheck();
  const text = String(dividendQuestions()[0].body.text).split("\n");
  assertEquals(
    text.at(-1),
    `Your fund's balance was confirmed on ${new Date(`${dubaiToday()}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}. Was this already in it? Reply "yes" if it was (nothing is added), "no" if it arrived after (adds $10.50), or "not yet" if it hasn't arrived.`,
  );
  assertEquals((backend.tables.bot_proposals[0].payload as Row).ask, "already_included");
});

freshTest("a bare \"yes\" hours after the question records them, and says what moved", async () => {
  seedDividends();
  await morningCheck();
  const proposal = backend.tables.bot_proposals.find((p) => p.kind === "dividends_received")!;
  proposal.created_at = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  await handler(textUpdate(9601, "yes"));
  assertEquals(proposal.status, "applied");
  assertEquals(lastReply().split("\n")[0], "Recorded: $10.50 into Dollar funds.");
  assertEquals(backend.tables.accounts.find((a) => a.id === DIV_FUND)!.balance, 110.5);
  assertEquals(capturedIntake().length, 0);
});

freshTest("\"no\" leaves them for the app", async () => {
  seedDividends();
  await morningCheck();
  const proposal = backend.tables.bot_proposals.find((p) => p.kind === "dividends_received")!;
  await handler(replyUpdate(9602, "no", Number(proposal.prompt_message_id)));
  assertEquals(proposal.status, "cancelled");
  assertEquals(lastReply(), "Left for the app: 2 dividends into Dollar funds, $10.50. Nothing was recorded.");
  assertEquals(backend.applyCalls, 0);
});

freshTest("on a confirmed-balance question, \"no\" records them as arriving after it", async () => {
  seedDividends({ confirmedToday: true });
  await morningCheck();
  const proposal = backend.tables.bot_proposals.find((p) => p.kind === "dividends_received")!;
  await handler(replyUpdate(9603, "no", Number(proposal.prompt_message_id)));
  assertEquals((proposal.payload as Row).answer, "not_included");
  assertEquals(proposal.status, "applied");
  assertEquals(backend.tables.accounts.find((a) => a.id === DIV_FUND)!.balance, 110.5);
  assertEquals(lastReply().split("\n")[0], "Recorded: $10.50 into Dollar funds.");
});

freshTest("on a confirmed-balance question, a 👍 says they were already in it", async () => {
  seedDividends({ confirmedToday: true });
  await morningCheck();
  const proposal = backend.tables.bot_proposals.find((p) => p.kind === "dividends_received")!;
  await handler(reactionUpdate(9604, Number(proposal.prompt_message_id), "👍"));
  assertEquals((proposal.payload as Row).answer, "included");
  assertEquals(backend.tables.accounts.find((a) => a.id === DIV_FUND)!.balance, 100);
  assertEquals(lastReply().split("\n")[0], "Recorded as already in the fund's balance: $10.50.");
});

freshTest("a dividend changed since the question saves nothing and is asked about again", async () => {
  seedDividends();
  await morningCheck();
  const proposal = backend.tables.bot_proposals.find((p) => p.kind === "dividends_received")!;
  // Fixed in the app in between.
  backend.tables.holding_dividends[1].version = 2;
  await handler(replyUpdate(9605, "yes", Number(proposal.prompt_message_id)));
  assertEquals(proposal.status, "expired");
  assertEquals(backend.tables.accounts.find((a) => a.id === DIV_FUND)!.balance, 100);
  assertEquals(lastReply(), `Something changed since I asked, so nothing was recorded. Here it is again:\n${PLAIN_QUESTION}`);
  const again = backend.tables.bot_proposals.find((p) => p.kind === "dividends_received" && p.status === "proposed")!;
  assertEquals(((again.payload as Row).lines as Row[]).map((l) => l.version), [1, 2]);
  assertEquals(again.prompt_message_id != null, true);
  assert(backend.tables.holding_dividends.every((d) => d.asked_at != null), "not marked asked again");
});

freshTest("a dividend recorded elsewhere since the question is not asked again", async () => {
  seedDividends();
  await morningCheck();
  const proposal = backend.tables.bot_proposals.find((p) => p.kind === "dividends_received")!;
  for (const d of backend.tables.holding_dividends) Object.assign(d, { status: "received", version: 2 });
  await handler(replyUpdate(9606, "yes", Number(proposal.prompt_message_id)));
  assertEquals(lastReply(), "Something changed since I asked, so nothing was recorded. They were recorded or changed since, here or in the app, so nothing is left to ask about.");
  assertEquals(backend.tables.bot_proposals.filter((p) => p.status === "proposed").length, 0);
});

freshTest("a dividend typed in as income is not logged, and says where dividends live", async () => {
  backend.tables.holdings = [{ id: "a8000000-0000-4000-8000-0000000000c1", household_id: HOUSEHOLD, name: "ABC", asset_class: "us_equity", currency: "USD" }];
  backend.parse = [{ merchant: "ABC dividend", amount: 700, currency: "INR", occurred_at: dubaiToday(), category: null, card_last4: null, account_hint: null, confidence: 1, kind: "income" }];
  await handler(textUpdate(9607, "ABC dividend credit 700"));
  assertEquals(capturedIntake().filter((r) => r.status === "pending").length, 0);
  assertEquals(capturedIntake()[0].status, "rejected");
  assertEquals(
    lastReply(),
    "That looks like a dividend, so I haven't logged it as income: Rokda records dividends from US and Indian shares on the holding that paid them, under Wealth → Investments. If it came from anything else, add it as income in the app.",
  );
});

freshTest("income that is not a dividend is captured as before", async () => {
  backend.parse = [{ merchant: "Salary", amount: 7000, currency: "AED", occurred_at: dubaiToday(), category: null, card_last4: null, account_hint: null, confidence: 1, kind: "income" }];
  await handler(textUpdate(9608, "salary 7000"));
  assertEquals(capturedIntake().filter((r) => r.status === "pending").length, 1);
  assert(!lastReply().startsWith("That looks like a dividend"), lastReply());
});

freshTest("a dividend among other items is left out; the others are captured", async () => {
  backend.tables.holdings = [{ id: "a8000000-0000-4000-8000-0000000000c1", household_id: HOUSEHOLD, name: "ABC", asset_class: "us_equity", currency: "USD" }];
  backend.parse = [
    { merchant: "Salary", amount: 7000, currency: "AED", occurred_at: dubaiToday(), category: null, card_last4: null, account_hint: null, confidence: 1, kind: "income" },
    { merchant: "ABC dividend", amount: 700, currency: "INR", occurred_at: dubaiToday(), category: null, card_last4: null, account_hint: null, confidence: 1, kind: "income" },
    { merchant: "Lunch", amount: 40, currency: "AED", occurred_at: dubaiToday(), category: null, card_last4: null, account_hint: null, confidence: 1, kind: "expense" },
  ];
  await handler(textUpdate(9609, "salary 7000, dividend 700, lunch 40"));
  assertEquals(capturedIntake().filter((r) => r.status === "pending").map((r) => r.parsed_merchant).sort(), ["Lunch", "Salary"]);
  assert(/dividend/i.test(lastReply()), lastReply());
});

freshTest("\"not yet\" puts the question off until tomorrow morning", async () => {
  seedDividends();
  await morningCheck();
  const proposal = backend.tables.bot_proposals.find((p) => p.kind === "dividends_received")!;
  await handler(replyUpdate(9610, "not yet", Number(proposal.prompt_message_id)));
  assertEquals(proposal.status, "cancelled");
  assertEquals(backend.applyCalls, 0);
  assert(backend.tables.holding_dividends.every((d) => d.asked_at == null), "still marked asked");
  assertEquals(lastReply(), "Then I'll ask about them again tomorrow morning.");
  // Not again the same morning.
  await morningCheck();
  assertEquals(dividendQuestions().length, 1);
});

// D-08: putting a question off and clearing its dividends' asked marks
// happen together, so a failure leaves the question as it was rather than
// promising a reminder that will never come.
freshTest("a \"not yet\" that cannot be saved changes nothing and promises nothing", async () => {
  seedDividends();
  await morningCheck();
  const proposal = backend.tables.bot_proposals.find((p) => p.kind === "dividends_received")!;
  backend.failRpc = new Set(["postpone_dividends_proposal"]);
  await handler(replyUpdate(9611, "not yet", Number(proposal.prompt_message_id)));
  assertEquals(proposal.status, "proposed");
  assert(backend.tables.holding_dividends.every((d) => d.asked_at != null), "asked marks cleared without the question being put off");
  assertEquals(lastReply(), "I couldn't put that off just now. Nothing has been changed; try again in a moment.");
});

freshTest("a 👎 on the question means not yet", async () => {
  seedDividends();
  await morningCheck();
  const proposal = backend.tables.bot_proposals.find((p) => p.kind === "dividends_received")!;
  await handler(reactionUpdate(9611, Number(proposal.prompt_message_id), "👎"));
  assertEquals(proposal.status, "cancelled");
  assertEquals(backend.applyCalls, 0);
  assert(backend.tables.holding_dividends.every((d) => d.asked_at == null), "still marked asked");
});

freshTest("a bare \"no\" hours after a confirmed-balance question records nothing", async () => {
  seedDividends({ confirmedToday: true });
  await morningCheck();
  const proposal = backend.tables.bot_proposals.find((p) => p.kind === "dividends_received")!;
  proposal.created_at = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  await handler(textUpdate(9612, "no"));
  assertEquals(backend.applyCalls, 0);
  assertEquals(proposal.status, "proposed");
  assertEquals(backend.tables.accounts.find((a) => a.id === DIV_FUND)!.balance, 100);
});

freshTest("on a shared holding, the second member's \"yes\" is told it is already recorded", async () => {
  backend.tables.household_members.push({ id: PARTNER, household_id: HOUSEHOLD, display_name: "Partner", telegram_user_id: PARTNER_TELEGRAM, role: "member" });
  seedDividends({ shared: true });
  await morningCheck();
  const mine = backend.tables.bot_proposals.find((p) => p.member_id === MEMBER)!;
  const theirs = backend.tables.bot_proposals.find((p) => p.member_id === PARTNER)!;
  await handler(replyUpdate(9613, "yes", Number(mine.prompt_message_id)));
  assertEquals(mine.status, "applied");
  await handler(partnerUpdate(9614, { text: "yes", reply_to_message: { message_id: Number(theirs.prompt_message_id) } }));
  assertEquals(lastReply(), "Already recorded: another member answered this question.");
  assertEquals(backend.tables.accounts.find((a) => a.id === DIV_FUND)!.balance, 110.5);
  assertEquals(backend.tables.bot_proposals.filter((p) => p.status === "proposed").length, 0);
});

freshTest("in a household with no share the feeds cover, a dividend is captured as income", async () => {
  backend.tables.holdings = [{ id: "a8000000-0000-4000-8000-0000000000c3", household_id: HOUSEHOLD, name: "Local fund", asset_class: "uae_equity", currency: "AED" }];
  backend.parse = [{ merchant: "Fund dividend", amount: 700, currency: "AED", occurred_at: dubaiToday(), category: null, card_last4: null, account_hint: null, confidence: 1, kind: "income" }];
  await handler(textUpdate(9615, "fund dividend 700"));
  assertEquals(capturedIntake().filter((r) => r.status === "pending").length, 1);
  assert(!lastReply().startsWith("That looks like a dividend"), lastReply());
});
