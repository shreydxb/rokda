// Handler-level tests of the webhook itself: link codes, update claims, capture, goal and transfer proposals, and what reaches the logs.
// The fake backend these drive the real handler against is testing/harness.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { linkTokenDigest } from "../_shared/applib/telegramLink.js";
import { assertNoTokenLeaked, backend, capturedIntake, freshTest, handler, HOUSEHOLD, lastReply, LEASE_MS, logged, photoUpdate, proposalOutcomeMessage, replyUpdate, SECRET, TELEGRAM_USER, textUpdate, transferDraftFrom } from "./testing/harness.ts";

// ---------------------------------------------------------------------------
// The acceptance cases
// ---------------------------------------------------------------------------

// A-01: the roster holds only the code's digest, so a member who reads
// another's row learns nothing that links Telegram as them.
freshTest("a link code is matched by its digest, and the stored digest links nobody", async () => {
  const CODE = "0f8cb1e4a2d94f6b8c1e2a3b4c5d6e7f";
  const digest = await linkTokenDigest(CODE);
  Object.assign(backend.tables.household_members[0], {
    telegram_user_id: null, telegram_link_code: digest, telegram_link_code_expires_at: "2099-01-01T00:00:00Z",
  });
  await handler(textUpdate(7101, digest));
  assertEquals(backend.tables.household_members[0].telegram_user_id, null, "the stored digest linked Telegram");
  const res = await handler(textUpdate(7102, CODE));
  assertEquals(res.status, 200);
  assertEquals(backend.tables.household_members[0].telegram_user_id, TELEGRAM_USER, "the code did not link Telegram");
  assertEquals(backend.tables.household_members[0].telegram_link_code, null);
  assert(lastReply().startsWith("Linked as Tester."), lastReply());
});

// Round 2 of the outside review (A2-1): a code sent from a Telegram account
// that is already linked skipped the link handling, went to the AI service
// and, with that down, was saved verbatim in intake, which every member reads.
freshTest("a link code from an already-linked account is neither stored nor sent to the AI", async () => {
  const CODE = "0f8cb1e4a2d94f6b8c1e2a3b4c5d6e7f";
  const aiBefore = backend.aiCalls;
  const res = await handler(textUpdate(7103, CODE));
  assertEquals(res.status, 200);
  assertEquals(capturedIntake().length, 0, "the code was saved in intake");
  assertEquals(backend.aiCalls, aiBefore, "the code was sent to the AI service");
  assert(lastReply().includes("already linked"), lastReply());
  await handler(textUpdate(7104, `/start ${CODE}`));
  assertEquals(capturedIntake().length, 0, "the deep-link form was saved in intake");
  // Inside a sentence too (the fresh review of round 2).
  await handler(textUpdate(7106, `here is my code ${CODE} thanks`));
  assertEquals(capturedIntake().length, 0, "a code inside a sentence was saved in intake");
  assertEquals(backend.aiCalls, aiBefore, "a code inside a sentence was sent to the AI service");
});

// Round 2 (A2-3): the code's expiry was checked when it was looked up, not
// when it was redeemed, so a code that expired in between still linked.
freshTest("a link code that expires between lookup and redemption links nobody", async () => {
  const CODE = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
  const digest = await linkTokenDigest(CODE);
  Object.assign(backend.tables.household_members[0], {
    telegram_user_id: null, telegram_link_code: digest, telegram_link_code_expires_at: "2099-01-01T00:00:00Z",
  });
  // The redemption sees the code as expired: the lookup has just happened.
  backend.faults.expireLinkCodeAfterLookup = true;
  await handler(textUpdate(7105, CODE));
  assertEquals(backend.tables.household_members[0].telegram_user_id, null, "an expired code linked Telegram");
  assert(lastReply().includes("just used or has expired"), lastReply());
});

freshTest("an ordinary expense is captured once and its claim completed", async () => {
  const res = await handler(textUpdate(7001, "spent 40 on lunch"));
  assertEquals(res.status, 200);
  assertEquals(capturedIntake().length, 1);
  assertEquals(capturedIntake()[0].source_ref, "7001");
  assertEquals(backend.log.get(7001)?.status, "completed");
});

// Round 2 of the outside review (D2-5): "Noon 40, Bakery 70" whose second
// item failed to save was answered "2 expenses captured". Only what was
// saved is counted, and what was not is named so it can be sent again.
freshTest("a message's item that fails to save is named, not counted as captured", async () => {
  backend.parse = [
    { merchant: "Noon", amount: 40, currency: "AED", occurred_at: "2026-09-24", date_stated: true, source: "typed", category: null, card_last4: null, account_hint: null, confidence: 1, kind: "expense" },
    { merchant: "Bakery", amount: 70, currency: "AED", occurred_at: "2026-09-24", date_stated: true, source: "typed", category: null, card_last4: null, account_hint: null, confidence: 1, kind: "expense" },
  ];
  backend.faults.failIntakeItems = true;
  const res = await handler(textUpdate(7021, "Noon 40, Bakery 70"));
  assertEquals(res.status, 200);
  assertEquals(capturedIntake().length, 1);
  assert(!lastReply().includes("2 expenses captured"), lastReply());
  assert(lastReply().includes("1 expense captured"), lastReply());
  assert(lastReply().includes("couldn't save AED 70.00 at Bakery"), lastReply());
});

// The fresh review of round 2: an item that failed to save still counted in
// the note about dates, so a saved item with its date was told "It had no
// date" because the unsaved one had none.
freshTest("an item that fails to save is not counted in the note about dates", async () => {
  backend.parse = [
    { merchant: "Noon", amount: 40, currency: "AED", occurred_at: "2026-09-24", date_stated: true, source: "typed", category: null, card_last4: null, account_hint: null, confidence: 1, kind: "expense" },
    // A bank text with no date of its own: its date is guessed.
    { merchant: "Bakery", amount: 70, currency: "AED", occurred_at: null, date_stated: false, source: "bank_sms", category: null, card_last4: null, account_hint: null, confidence: 1, kind: "expense" },
  ];
  backend.faults.failIntakeItems = true;
  const res = await handler(textUpdate(7022, "Noon 40, Bakery 70"));
  assertEquals(res.status, 200);
  assert(lastReply().includes("couldn't save AED 70.00 at Bakery"), lastReply());
  assert(!lastReply().includes("had no date"), lastReply());
});

// D-06: a receipt is kept, or Telegram is asked to send it again. A failure
// to fetch or store it must never end the update with nothing saved.
freshTest("a receipt photo is stored and captured", async () => {
  const res = await handler(photoUpdate(7011));
  assertEquals(res.status, 200);
  assertEquals(capturedIntake().length, 1);
  assert(String(capturedIntake()[0].photo_path ?? "").endsWith(".jpg"), JSON.stringify(capturedIntake()[0]));
});

for (const [name, fault] of [
  ["Telegram refuses to give the file", { getFile: "refuse" }],
  ["the download fails", { downloadFails: true }],
  ["storing it fails", { storageFails: true }],
] as const) {
  freshTest(`a receipt photo is retried when ${name}, and captured once it works`, async () => {
    Object.assign(backend.faults, fault);
    const first = await handler(photoUpdate(7012));
    assertEquals(first.status, 500);
    assertEquals(capturedIntake().length, 0);
    assertEquals(backend.log.get(7012)?.status, "failed");
    backend.faults = {};
    const retried = await handler(photoUpdate(7012));
    assertEquals(retried.status, 200);
    assertEquals(capturedIntake().length, 1);
  });
}

freshTest("a file too big for a bot to fetch is said so, not retried for ever", async () => {
  backend.faults.getFile = "too_big";
  const res = await handler(photoUpdate(7013));
  assertEquals(res.status, 200);
  assertEquals(capturedIntake().length, 0);
  assert(lastReply().startsWith("That file is too big for me to fetch"), lastReply());
});

freshTest("a database error on the claim processes nothing and asks Telegram to retry", async () => {
  // Before SHR-303 any error that was not a duplicate key returned "not seen"
  // and processing carried on unlogged. A statement timeout must stop it.
  backend.faults.claimError = { code: "57014", message: "canceling statement due to statement timeout" };
  const res = await handler(textUpdate(7002, "spent 40 on lunch"));
  assertEquals(res.status, 503);
  assertEquals(capturedIntake().length, 0);
  assertEquals(backend.telegramSent.length, 0);
  assert(!backend.requests.some((r) => r.path === "/rest/v1/intake"), "the handler went on to touch intake");

  // The retry, once the database answers, is processed normally.
  backend.faults.claimError = undefined;
  const retry = await handler(textUpdate(7002, "spent 40 on lunch"));
  assertEquals(retry.status, 200);
  assertEquals(capturedIntake().length, 1);
});

freshTest("a completed update is answered 200 and not processed again", async () => {
  await handler(textUpdate(7003, "spent 40 on lunch"));
  const sentBefore = backend.telegramSent.length;
  const again = await handler(textUpdate(7003, "spent 40 on lunch"));
  assertEquals(again.status, 200);
  assertEquals(capturedIntake().length, 1);
  assertEquals(backend.telegramSent.length, sentBefore, "a completed update replied again");
});

freshTest("an update still being processed is answered non-200, not treated as done", async () => {
  // The state a live run leaves. Answering 200 here would tell Telegram the
  // update was delivered, and if that run then failed, nothing would retry.
  backend.log.set(7004, { status: "processing", claimed_at: backend.now - 10_000, attempts: 1 });
  const res = await handler(textUpdate(7004, "spent 40 on lunch"));
  assertEquals(res.status, 503);
  assertEquals(capturedIntake().length, 0);
});

freshTest("a crash between claim and capture is recovered on redelivery, not lost", async () => {
  // A run that was claimed and then killed -- no handler code ran, so nothing
  // settled the claim -- leaves exactly this behind. Before SHR-303 the
  // redelivery was dropped as already handled and the expense vanished.
  backend.log.set(7005, { status: "processing", claimed_at: backend.now - LEASE_MS - 1_000, attempts: 1 });
  const res = await handler(textUpdate(7005, "spent 40 on lunch"));
  assertEquals(res.status, 200);
  assertEquals(capturedIntake().length, 1, "the abandoned update was not captured on redelivery");
  assertEquals(backend.log.get(7005)?.attempts, 2);
  assertEquals(backend.log.get(7005)?.status, "completed");
});

freshTest("a failure after capture releases the claim, and the retry does not duplicate", async () => {
  // Telegram is unreachable for the confirmation reply, after the expense is
  // already captured. The handler must release the claim and answer 500 so
  // the retry runs -- and intake's own delivery key must make that retry
  // harmless.
  backend.faults.failFirstSends = 1;
  const first = await handler(textUpdate(7006, "spent 40 on lunch"));
  assertEquals(first.status, 500);
  assertEquals(backend.log.get(7006)?.status, "failed");
  assertEquals(capturedIntake().length, 1);

  const retry = await handler(textUpdate(7006, "spent 40 on lunch"));
  assertEquals(retry.status, 200);
  assertEquals(capturedIntake().length, 1, "the retry captured the expense a second time");
  assertEquals(backend.log.get(7006)?.status, "completed");
  // The first run's acknowledgement never arrived, so the retry must say so
  // rather than succeed silently.
  assertEquals(backend.telegramSent.length, 1, "the member was never told it was recorded");
  assert(String(backend.telegramSent[0].body.text).includes("Inbox"));
});

freshTest("concurrent deliveries of one update capture it once", async () => {
  // In-process only: this proves the handler honours the claim's answer. That
  // Postgres gives exactly one caller 'claimed' is proven separately, with two
  // real sessions, in scripts/verify-concurrency.sh.
  const [a, b] = await Promise.all([
    handler(textUpdate(7007, "spent 40 on lunch")),
    handler(textUpdate(7007, "spent 40 on lunch")),
  ]);
  assertEquals([a.status, b.status].sort(), [200, 503]);
  assertEquals(capturedIntake().length, 1);
});

freshTest("a goal contribution is proposed once however often it is delivered, and recorded once on a yes", async () => {
  // The question fails to send, so the update is released and re-run in full.
  backend.route = { tool: "log_goal_contribution", args: { goal_name: "House", amount: 500 } };
  backend.faults.failFirstSends = 1;
  const first = await handler(textUpdate(7008, "put 500 toward the house goal"));
  assertEquals(first.status, 500);
  // The question never arrived, so nothing is left for a later "yes" to apply.
  assertEquals(backend.tables.bot_proposals.length, 0, "a proposal nobody was asked about was kept");
  assertEquals(backend.tables.goal_contributions.length, 0, "a contribution was recorded before anyone said yes");
  assertEquals(capturedIntake().length, 0, "a goal contribution was also captured as an expense");

  const retry = await handler(textUpdate(7008, "put 500 toward the house goal"));
  assertEquals(retry.status, 200);
  assertEquals(backend.tables.bot_proposals.length, 1, "the redelivery proposed it a second time");
  assertEquals(backend.tables.goal_contributions.length, 0);
  assert(lastReply().includes("Record AED 500.00 toward House"), lastReply());
  const prompt = backend.tables.bot_proposals[0].prompt_message_id as number;
  assert(prompt, "the question was not tied to the proposal");

  await handler(replyUpdate(7009, "yes", prompt));
  assertEquals(backend.tables.goal_contributions.length, 1);
  assertEquals(backend.tables.goal_contributions[0].source_ref, "7008");
  assert(lastReply().startsWith("Recorded: AED 500.00 toward House"), lastReply());

  // A second yes repeats the answer and records nothing.
  await handler(replyUpdate(7010, "yes", prompt));
  assertEquals(backend.tables.goal_contributions.length, 1, "a second yes recorded it again");
  assert(lastReply().startsWith("Already recorded"), lastReply());
  assertEquals(capturedIntake().length, 0, "a yes was captured as an expense");
});

freshTest("a goal marked done takes no contribution, and the reply is told it is done", async () => {
  backend.tables.goals[0].done_at = "2026-09-01T00:00:00Z";
  backend.tables.goals.push({ id: "a9100000-0000-4000-8000-0000000000e2", household_id: HOUSEHOLD, name: "Car", done_at: null });
  backend.route = { tool: "log_goal_contribution", args: { goal_name: "House", amount: 500 } };
  await handler(textUpdate(7011, "put 500 toward the house goal"));
  assertEquals(backend.tables.bot_proposals.length, 0, "a contribution to a done goal was proposed");
  assertEquals(backend.tables.goal_contributions.length, 0);
  assertEquals(capturedIntake().length, 0, "a goal contribution was captured as an expense");
  const given = backend.phrasePrompts.join("\n");
  assert(given.includes("goal_done") && given.includes("House"), given);
});

freshTest("a goal list that could not be read records nothing and says so", async () => {
  backend.faults.failReads = ["goals"];
  backend.route = { tool: "log_goal_contribution", args: { goal_name: "House", amount: 500 } };
  await handler(textUpdate(7012, "put 500 toward the house goal"));
  assertEquals(backend.tables.bot_proposals.length, 0);
  assertEquals(backend.tables.goal_contributions.length, 0);
  assertEquals(capturedIntake().length, 0, "an unreadable goal list sent the message to the Inbox");
  assert(lastReply().startsWith("I couldn't read your goals just now"), lastReply());
});

freshTest("a transfer between the household's own accounts is proposed, and recorded as one only on a yes", async () => {
  backend.tables.accounts.push(
    { id: "acc-current", household_id: HOUSEHOLD, name: "Current account", archived_at: null },
    { id: "acc-card", household_id: HOUSEHOLD, name: "Bank card •0001", archived_at: null },
  );
  backend.route = { tool: "log_transfer", args: { from_account: "current account", to_account: "bank card", amount: 3000, occurred_at: "2026-09-20" } };
  await handler(textUpdate(7101, "paid the card 3000 from the current account"));
  assertEquals(backend.tables.bot_proposals.length, 1);
  assertEquals(backend.tables.bot_proposals[0].kind, "transfer");
  assertEquals(backend.tables.transactions.length, 0, "a transfer was recorded before anyone said yes");
  assertEquals(capturedIntake().length, 0, "a transfer was also captured as an expense");
  assert(lastReply().startsWith("Record a transfer of AED 3000.00 from Current account to Bank card •0001, dated 2026-09-20?"), lastReply());

  const prompt = backend.tables.bot_proposals[0].prompt_message_id as number;
  await handler(replyUpdate(7102, "yes", prompt));
  assertEquals(backend.tables.transactions.map((t) => [t.account_id, t.amount, t.kind]), [["acc-current", -3000, "transfer"], ["acc-card", 3000, "transfer"]]);
  assert(lastReply().startsWith("Recorded the transfer: AED 3000.00 from Current account to Bank card •0001"), lastReply());

  await handler(replyUpdate(7103, "yes", prompt));
  assertEquals(backend.tables.transactions.length, 2, "a second yes recorded it again");
  assert(lastReply().startsWith("Already recorded"), lastReply());
});

freshTest("a transfer naming an account that matches nothing proposes nothing and captures nothing", async () => {
  backend.tables.accounts.push({ id: "acc-current", household_id: HOUSEHOLD, name: "Current account", archived_at: null });
  backend.route = { tool: "log_transfer", args: { from_account: "current account", to_account: "somewhere else", amount: 100 } };
  await handler(textUpdate(7104, "moved 100 to somewhere else"));
  assertEquals(backend.tables.bot_proposals.length, 0);
  assertEquals(backend.tables.transactions.length, 0);
  assertEquals(capturedIntake().length, 0, "a transfer that could not be matched was captured as an expense");
});

Deno.test("a transfer is drafted only when each side names exactly one open account", () => {
  const accounts = [
    { id: "a", name: "Current account" },
    { id: "b", name: "Bank card •0001" },
    { id: "c", name: "Savings" },
  ];
  const ok = transferDraftFrom(accounts, { from_account: "current", to_account: "card", amount: -250.5 }, "2026-10-16");
  assertEquals(ok, { from: accounts[0], to: accounts[1], amount: 250.5, occurredAt: "2026-10-16", note: null });
  assertEquals((transferDraftFrom(accounts, { to_account: "card", amount: 5 }, "2026-10-16") as { error: string }).error, "from_account_missing");
  assertEquals((transferDraftFrom(accounts, { from_account: "nowhere", to_account: "card", amount: 5 }, "2026-10-16") as { error: string }).error, "from_account_not_found");
  assertEquals((transferDraftFrom(accounts, { from_account: "savings", to_account: "savings", amount: 5 }, "2026-10-16") as { error: string }).error, "same_account");
  assertEquals((transferDraftFrom(accounts, { from_account: "savings", to_account: "card", amount: 0 }, "2026-10-16") as { error: string }).error, "invalid_amount");
});

Deno.test("a recorded transfer says which sides were already in Rokda", () => {
  const message = proposalOutcomeMessage({
    outcome: "applied",
    kind: "transfer",
    applied: [{ from_name: "Current account", to_name: "Bank card", amount: 450, occurred_at: "2026-10-13", joined_out: true, joined_in: false, already_recorded: false }],
    skipped: [],
  });
  assert(message.includes("the payment out of Current account was already in Rokda"), message);
});

freshTest("a DNS failure reaching Telegram never puts the bot token in the logs", async () => {
  // Reproduces the audited leak: Deno's fetch error quotes the URL in its
  // cause, and the URL carries the token.
  backend.faults.telegramDns = true;
  const res = await handler(textUpdate(7009, "spent 40 on lunch"));
  assertEquals(res.status, 500);
  assert(logged.length > 0, "a handler failure was not logged at all");
  assertNoTokenLeaked();

  // Metadata only: a parseable event naming where and which update, with the
  // error's class and nothing that could quote a URL, a row or a message.
  const event = JSON.parse(logged[logged.length - 1]);
  assertEquals(event.event, "telegram_webhook_failure");
  assertEquals(event.update_id, 7009);
  assertEquals(Object.keys(event).sort(), ["error", "event", "update_id", "where"]);
  assert(!JSON.stringify(event).includes("lunch"), "the member's message reached the log");
});

freshTest("a failure outside update processing is caught by the last line of defence", async () => {
  // ?setup=1 registers the webhook with Telegram, outside any update and so
  // outside processUpdate's wrapper. Before SHR-303 nothing caught a failure
  // here: the exception reached the runtime, which printed its cause chain,
  // bot token included.
  backend.faults.telegramDns = true;
  const res = await handler(new Request("http://edge.test/telegram-webhook?setup=1", {
    method: "GET",
    headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET },
  }));
  assertEquals(res.status, 500);
  assertNoTokenLeaked();
  const event = JSON.parse(logged[logged.length - 1]);
  assertEquals(event.where, "request");
  assertEquals(event.update_id, null);
});

freshTest("a request without the exact secret is refused before anything else happens", async () => {
  // The secret is compared in constant time now; this pins that the compare
  // still refuses everything that is not the secret, including a value that
  // differs only in its last character and one that is the secret plus more.
  const near = SECRET.slice(0, -1) + (SECRET.endsWith("t") ? "u" : "t");
  for (const presented of [null, "", near, SECRET + "x", SECRET.toUpperCase()]) {
    backend.requests.length = 0;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (presented !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = presented;
    const res = await handler(new Request("http://edge.test/telegram-webhook", {
      method: "POST",
      headers,
      body: JSON.stringify({ update_id: 1, message: { message_id: 1, date: 1, text: "coffee 10", chat: { id: TELEGRAM_USER, type: "private" }, from: { id: TELEGRAM_USER, is_bot: false, first_name: "T" } } }),
    }));
    assertEquals(res.status, 401, `presented ${JSON.stringify(presented)}`);
    // Only the secret lookup itself: no claim, no capture, no reply.
    assertEquals(backend.requests.map((r) => r.path), ["/rest/v1/rpc/get_telegram_webhook_secret"]);
  }
  assertEquals(capturedIntake().length, 0);
  assertEquals(backend.telegramSent.length, 0);

  const ok = await handler(textUpdate(2, "hello"));
  assertEquals(ok.status, 200);
});
