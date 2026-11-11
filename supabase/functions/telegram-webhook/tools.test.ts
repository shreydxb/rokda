// Questions answered from the household's figures, the brief, and the AI service being busy.
// The fake backend these drive the real handler against is testing/harness.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { aiCalls, backend, capturedIntake, figuresUnavailableMessage, freshTest, GROCERIES, handler, HOUSEHOLD, isSpendingAccount, lastReply, Row, seedExpenses, textUpdate, thisMonthFirst } from "./testing/harness.ts";

freshTest("this month's spending is found after a thousand older transactions", async () => {
  // Stored first, so a single unordered read returned only these and the
  // brief said AED 0.
  seedExpenses(1000, "2025-01-15", 10, "t-old");
  seedExpenses(85, thisMonthFirst(), 10, "t-new");
  await handler(textUpdate(9301, "brief"));
  assert(lastReply().includes("Spent this month: AED 850\n"), lastReply());
});

freshTest("a month with more than a thousand transactions is totalled in full", async () => {
  seedExpenses(1085, thisMonthFirst(), 10, "t-month");
  await handler(textUpdate(9302, "brief"));
  assert(lastReply().includes("Spent this month: AED 10,850\n"), lastReply());
  // Two pages each for the month's total and its budget alerts.
  assertEquals(backend.requests.filter((r) => r.method === "GET" && r.path === "/rest/v1/transactions").length, 4);
});

freshTest("a brief whose spending could not be read says so rather than AED 0", async () => {
  seedExpenses(3, thisMonthFirst(), 10, "t-fail");
  backend.faults.failReads = ["transactions"];
  await handler(textUpdate(9303, "brief"));
  const brief = lastReply();
  assert(brief.includes("Spent this month: couldn't be read just now."), brief);
  assert(!/Spent this month: AED/.test(brief), brief);
  // What could be read is still there.
  assert(brief.startsWith("Net worth: AED "), brief);
});

freshTest("a brief whose accounts could not be read states no net worth and no cash cover", async () => {
  backend.faults.failReads = ["accounts"];
  await handler(textUpdate(9304, "brief"));
  const brief = lastReply();
  assert(brief.includes("Net worth: couldn't be read just now."), brief);
  assert(brief.includes("Cash cover: couldn't be read just now."), brief);
  assert(brief.includes("Bills due: couldn't be read just now."), brief);
  assert(brief.includes("Inbox is clear."), brief);
});

freshTest("a split receipt counts only its line in the category asked about", async () => {
  const HOUSEHOLD_GOODS = "a9100000-0000-4000-8000-0000000000c2";
  backend.tables.categories.push(
    { id: GROCERIES, household_id: HOUSEHOLD, name: "Groceries", kind: "expense", archived: false, is_savings: false },
    { id: HOUSEHOLD_GOODS, household_id: HOUSEHOLD, name: "Household", kind: "expense", archived: false, is_savings: false },
  );
  // 500 at the supermarket: 400 groceries, 100 household goods.
  backend.tables.transactions.push({
    id: "split-1", household_id: HOUSEHOLD, account_id: "a9100000-0000-4000-8000-0000000000a1", category_id: null, is_split: true,
    amount: -500, kind: "expense", occurred_at: thisMonthFirst(), is_shared: true, owner_member_id: null, merchant: "Supermarket",
  });
  backend.tables.transaction_splits = [
    { id: "l1", household_id: HOUSEHOLD, transaction_id: "split-1", category_id: GROCERIES, amount: -400 },
    { id: "l2", household_id: HOUSEHOLD, transaction_id: "split-1", category_id: HOUSEHOLD_GOODS, amount: -100 },
  ];
  backend.route = { tool: "get_category_spend", args: { category: "Household", period: "this_month" } };
  await handler(textUpdate(9320, "how much on household this month?"));
  // The member asking carries half of a shared receipt: half of the 100
  // household line, not half of the 500 receipt.
  const given = backend.phrasePrompts.join("\n");
  assert(given.includes('\\"spend_aed\\":50}'), given);
});

for (const [tool, args, table] of [
  ["get_category_spend", { category: "Groceries", period: "this_month" }, "transactions"],
  ["get_budget_status", { category: "Groceries" }, "budgets"],
  ["get_net_worth", {}, "holdings"],
  ["get_account_balance", { account_name: "bank" }, "accounts"],
  ["get_holdings", { range: "1m" }, "holding_value_history"],
] as Array<[string, Row, string]>) {
  freshTest(`${tool} with ${table} unreadable answers that it cannot, and records nothing`, async () => {
    backend.tables.categories.push({ id: GROCERIES, household_id: HOUSEHOLD, name: "Groceries", kind: "expense", archived: false, is_savings: false });
    backend.tables.holdings = [{ id: "a9100000-0000-4000-8000-0000000000d1", household_id: HOUSEHOLD, name: "Fund", asset_class: "equity", value_aed: 100, is_shared: true, owner_member_id: null }];
    backend.route = { tool, args };
    backend.faults.failReads = [table];
    await handler(textUpdate(9310, "how are we doing?"));
    assertEquals(lastReply(), figuresUnavailableMessage());
    assertEquals(capturedIntake().length, 0);
  });
}

// A broker's uninvested cash is never where an expense was paid from: "paid
// on Wio" must not land in the broker's funds account (SHR-367).
Deno.test("a broker funds account is never offered for spending", () => {
  assertEquals(isSpendingAccount({ type: "broker_funds" }), false);
  assertEquals(isSpendingAccount({ type: "checking" }), true);
  assertEquals(isSpendingAccount({ type: "credit_card" }), true);
});


freshTest("a question asked while the AI service is briefly busy is still answered", async () => {
  backend.tables.holdings = [{ id: "a9100000-0000-4000-8000-0000000000d1", household_id: HOUSEHOLD, name: "Fund", asset_class: "equity", value_aed: 100, is_shared: true, owner_member_id: null }];
  backend.route = { tool: "get_net_worth", args: {} };
  backend.faults.aiBusyFirst = 1;
  await handler(textUpdate(7301, "whats our networth?"));
  assertEquals(capturedIntake().length, 0);
  assertEquals(lastReply(), "Done.");
  assertEquals(aiCalls().slice(0, 2), [["classify_and_route", "http_429"], ["classify_and_route", null]]);
});

freshTest("a message the AI service cannot read even on a second try is kept, and the reply says so", async () => {
  backend.faults.aiBusyFirst = 4;
  await handler(textUpdate(7302, "whats our networth?"));
  assertEquals(capturedIntake().length, 1);
  assertEquals(lastReply(), "I couldn't read that just now, so it's saved in the Inbox. If it was a question, ask again in a minute.");
  assertEquals(aiCalls(), [["classify_and_route", "http_429"], ["classify_and_route", "http_429"], ["parse_intake", "http_429"], ["parse_intake", "http_429"]]);
});

freshTest("an expense read while routing was busy gets the ordinary reply", async () => {
  backend.faults.aiBusyFirst = 2;
  backend.parse = [{ merchant: "Cafe", amount: 40, currency: "AED", occurred_at: "2026-09-24", date_stated: true, source: "typed", category: null, card_last4: null, account_hint: null, confidence: 1, kind: "expense" }];
  await handler(textUpdate(7303, "spent 40 at cafe"));
  assertEquals(capturedIntake().length, 1);
  assertEquals(capturedIntake()[0].parsed_amount, 40);
  assert(!lastReply().includes("couldn't read"), lastReply());
});

freshTest("an AI service that answers at once is asked once for each step", async () => {
  backend.parse = [{ merchant: "Cafe", amount: 40, currency: "AED", occurred_at: "2026-09-24", date_stated: true, source: "typed", category: null, card_last4: null, account_hint: null, confidence: 1, kind: "expense" }];
  await handler(textUpdate(7304, "spent 40 at cafe"));
  assertEquals(aiCalls(), [["classify_and_route", null], ["parse_intake", null]]);
});

// ---------------------------------------------------------------------------
// Share trades by message (SHR-370)
// ---------------------------------------------------------------------------
