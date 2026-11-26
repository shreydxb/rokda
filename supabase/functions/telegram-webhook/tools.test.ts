// Questions answered from the household's figures, the brief, and the AI service being busy.
// The fake backend these drive the real handler against is testing/harness.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { aiCalls, backend, capturedIntake, dubaiDaysAgo, EPF, MEMBER, figuresUnavailableMessage, freshTest, GROCERIES, handler, HOUSEHOLD, isSpendingAccount, lastReply, MY_BANK, Row, seedExpenses, textUpdate, thisMonthFirst } from "./testing/harness.ts";
// After the harness, which sets the environment tools.ts reads as it loads.
import { briefMessage, NOT_READ, toolGetAccountBalance, toolGetCashCover, toolGetHoldings, toolGetNetWorth, toolGetTradeProfit, toolGetUpcomingBills } from "./tools.ts";

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

// The brief as the review's T24 has it (the revamp, phase 8a): one label
// and figure a line, in the bot's one format, and what a figure leaves out on
// a ⚠ line of its own.
Deno.test("the brief gives one figure a line, and what it leaves out on a ⚠ line", () => {
  const text = briefMessage(
    {
      netWorth: { net_worth_aed: 245000.5, unconverted_accounts: 1, unvalued_holdings: 0 },
      monthSpend: 10850,
      bills: {
        recurring: [{ name: "Rent", amount_aed: 5000, due_date: "2026-11-28" }],
        credit_cards: [
          { name: "Card •0004", amount_owed_aed: 1250, due_date: "2026-11-22" },
          { name: "Travel card", amount_owed_aed: null, amount_owed: 300, currency: "USD", due_date: "2026-12-02" },
        ],
      },
      budgetAlerts: [{ category: "Groceries", pct: 92 }, { category: "Dining out", pct: 85 }],
      cashCover: NOT_READ,
      pendingCount: 2,
    },
    "2026-11-20",
  );
  assertEquals(text, [
    "Net worth: AED 245,000.50",
    "⚠ Leaves out 1 account not converted",
    "Spent this month: AED 10,850",
    "Due in 14 days:",
    "• Rent · AED 5,000 · 28 Nov",
    "• Card •0004 · AED 1,250 · 22 Nov",
    "• Travel card · USD 300 · not converted · 2 Dec",
    "Budget: Groceries 92% · Dining out 85%",
    "Cash cover: couldn't be read just now.",
    "Inbox: 2 to review",
  ].join("\n"));
});

// The revamp, phase 8c: cash cover in the brief is a label and its figures,
// with what it leaves out on ⚠ lines, as net worth's is.
Deno.test("the brief gives cash cover its figures, and what they leave out on a ⚠ line", () => {
  const text = briefMessage(
    {
      netWorth: NOT_READ, monthSpend: NOT_READ, bills: NOT_READ, budgetAlerts: NOT_READ, pendingCount: NOT_READ,
      cashCover: { liquidAed: 5000, dueAed: 7000, days: 7, covered: false, certain: false, shortfallAed: 2000, unvalued: 0, unvaluedDue: 1 },
    },
    "2026-11-20",
  );
  assert(text.includes("\nCash cover: AED 5,000 liquid · AED 7,000 due in 7 days · short by at least AED 2,000\n⚠ 1 bill due has no AED amount, so more is due\n"), text);
});

// The fresh review of 8a: the brief's ⚠ line, end to end, right under the
// figure it qualifies.
freshTest("the brief says what net worth leaves out, right under it", async () => {
  backend.tables.accounts.push(MY_BANK, { ...EPF, balance: 1000 });
  await handler(textUpdate(9331, "brief"));
  assert(lastReply().startsWith("Net worth: AED 0\n⚠ Leaves out 1 account not converted\n"), lastReply());
});

freshTest("a category's spend names the period it was worked out for", async () => {
  backend.tables.categories.push({ id: GROCERIES, household_id: HOUSEHOLD, name: "Groceries", kind: "expense", archived: false, is_savings: false });
  backend.route = { tool: "get_category_spend", args: { category: "Groceries", period: "this_week" } };
  await handler(textUpdate(9332, "groceries this week?"));
  const prompt = (JSON.parse(backend.phrasePrompts.at(-1) ?? "[]") as Array<{ content: string }>).map((m) => m.content).join("\n");
  assert(prompt.includes('"period":"this_month"'), prompt);
});

// The review's T25: an answer leads with its figure, in the bot's format,
// and names the period.
freshTest("an answer is asked to lead with the figure, in the bot's format, naming the period", async () => {
  backend.tables.categories.push({ id: GROCERIES, household_id: HOUSEHOLD, name: "Groceries", kind: "expense", archived: false, is_savings: false });
  backend.route = { tool: "get_category_spend", args: { category: "Groceries", period: "this_month" } };
  await handler(textUpdate(9330, "how much on groceries this month?"));
  // The messages as sent, read back as text.
  const prompt = (JSON.parse(backend.phrasePrompts.at(-1) ?? "[]") as Array<{ content: string }>).map((m) => m.content).join("\n");
  assert(prompt.includes("Lead with the figure"), prompt);
  assert(prompt.includes("AED 1,234") && prompt.includes("3 Oct"), prompt);
  assert(prompt.includes("Groceries this month: AED 1,234"), prompt);
  // The fresh review of 8a: money in the currency the data gives, a caveat
  // the data carries said right after the figure, the period only when the
  // data gives one, and today's date to judge the year by.
  assert(prompt.includes("in the currency the data gives"), prompt);
  assert(prompt.includes('"incomplete" or "note"'), prompt);
  assert(prompt.includes("only when the data gives one"), prompt);
  assert(/Today is \d{4}-\d{2}-\d{2}/.test(prompt), prompt);
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

freshTest("a message with an amount that the AI service cannot read even on a second try is kept, and the reply says so", async () => {
  backend.faults.aiBusyFirst = 4;
  await handler(textUpdate(7302, "spent 40 at cafe"));
  assertEquals(capturedIntake().length, 1);
  assertEquals(lastReply(), "Couldn't read that. It's in the Inbox; ask again if it was a question.");
  assertEquals(aiCalls(), [["classify_and_route", "http_429"], ["classify_and_route", "http_429"], ["parse_intake", "http_429"], ["parse_intake", "http_429"]]);
});

// Only an expense, income or refund belongs in the Inbox, and each has an
// amount. A question the AI service could not read used to wait there as an
// entry nobody could approve (the feature review, November 2026).
freshTest("a message with no amount that the AI service cannot read is not kept, and the reply says so", async () => {
  backend.faults.aiBusyFirst = 4;
  await handler(textUpdate(7305, "whats our networth?"));
  assertEquals(capturedIntake().length, 0);
  assertEquals(lastReply(), "Couldn't read that. Nothing saved — send again in a minute.");
  assertEquals(aiCalls(), [["classify_and_route", "http_429"], ["classify_and_route", "http_429"]]);
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

// The review of the whole revamp: expected pay was listed as a bill due, so a
// salary due in three days made cash cover "short by AED 19,000" while
// Overview, which counts only money going out, said covered.
freshTest("pay due is not a bill: upcoming bills and cash cover count only money going out", async () => {
  backend.tables.accounts.push({ ...MY_BANK, balance: 1000, balance_aed: 1000, balance_as_of: new Date().toISOString(), is_shared: true });
  const due = { household_id: HOUSEHOLD, owner_member_id: null, is_shared: true, currency: "AED", native_amount: null, next_due_date: dubaiDaysAgo(-3), ends_on: null, cadence: "monthly", interval_count: 1, account_id: MY_BANK.id, category_id: null, active: true, autopay: false };
  backend.tables.recurring.push(
    { ...due, id: "a9000000-0000-4000-8000-0000000000c1", name: "Salary", amount: 20000 },
    { ...due, id: "a9000000-0000-4000-8000-0000000000c2", name: "Internet", amount: -400 },
  );
  const bills = await toolGetUpcomingBills(HOUSEHOLD, null);
  assertEquals(bills.recurring.map((b: { name: string }) => b.name), ["Internet"]);
  const cover = await toolGetCashCover(HOUSEHOLD) as { covered: boolean; shortfallAed: number };
  assertEquals([cover.covered, cover.shortfallAed], [true, 0]);
});

// The review of the whole revamp: the bot's holdings answers disagreed with
// the app's.
const fund = (id: string, name: string, over: Row = {}) => ({
  id, household_id: HOUSEHOLD, name, asset_class: "us_equity", currency: "USD", quantity: 10, value_aed: 10000, invested_value_aed: 8000,
  day_change_pct: 1.5, priced_at: new Date().toISOString(), is_shared: true, owner_member_id: null, trades_version: 1, price_provider: "feed", price_fetch_error: null, ...over,
});

freshTest("a range change leaves sold holdings out, as Investments does", async () => {
  backend.tables.holdings = [fund("a9000000-0000-4000-8000-0000000000d1", "Index fund"), fund("a9000000-0000-4000-8000-0000000000d2", "Sold fund", { quantity: 0, value_aed: 0 })];
  backend.tables.holding_value_history = [
    { id: "v1", holding_id: "a9000000-0000-4000-8000-0000000000d1", as_of: dubaiDaysAgo(200), value_aed: 10000 },
    { id: "v2", holding_id: "a9000000-0000-4000-8000-0000000000d2", as_of: dubaiDaysAgo(200), value_aed: 5000 },
  ];
  const result = await toolGetHoldings(HOUSEHOLD, null, { range: "3M" }) as { range_value_change: { change_aed: number } };
  assertEquals(result.range_value_change.change_aed, 0);
});

freshTest("a holding whose price feed failed gives no day change, as the app shows none", async () => {
  backend.tables.holdings = [fund("a9000000-0000-4000-8000-0000000000d3", "Index fund", { price_fetch_error: "down" })];
  const result = await toolGetHoldings(HOUSEHOLD, null, { name: "Index" }) as { day_change_pct: number | null };
  assertEquals(result.day_change_pct, null);
});

freshTest("a shared holding's sale profit is halved in one person's view, as the app's Me view is", async () => {
  backend.tables.holdings = [fund("a9000000-0000-4000-8000-0000000000d4", "Index fund")];
  backend.tables.holding_trades = [{ id: "s1", household_id: HOUSEHOLD, holding_id: "a9000000-0000-4000-8000-0000000000d4", kind: "sell", trade_date: "2026-03-01", realised: 1000, tax_withheld: 0 }];
  const whole = await toolGetTradeProfit(HOUSEHOLD, null, { year: 2026 }) as { holdings: Array<{ profit: number }> };
  const mine = await toolGetTradeProfit(HOUSEHOLD, MEMBER, { year: 2026 }) as { holdings: Array<{ profit: number }> };
  assertEquals([whole.holdings[0].profit, mine.holdings[0].profit], [1000, 500]);
});

freshTest("a balance nobody has set is said to be not confirmed, and net worth counts them", async () => {
  backend.tables.accounts.push({ ...MY_BANK, balance: 0, balance_aed: 0, balance_as_of: null, is_shared: true });
  const balance = await toolGetAccountBalance(HOUSEHOLD, { account_name: "Bank" }) as { confirmed?: boolean; note?: string };
  assertEquals(balance.confirmed, false);
  const worth = await toolGetNetWorth(HOUSEHOLD, null) as { unconfirmed_accounts?: number };
  assertEquals(worth.unconfirmed_accounts, 1);
});

// The fresh review of these fixes: a fixed deposit with its principal and
// rate is worked out daily and never stamped, and the app counts it confirmed.
freshTest("a fixed deposit worked out from its principal and rate is not called unconfirmed", async () => {
  backend.tables.accounts.push({ id: "a9000000-0000-4000-8000-0000000000e9", household_id: HOUSEHOLD, name: "Deposit", type: "fd", currency: "AED", balance: 50000, balance_aed: 50000, balance_as_of: null, principal: 50000, interest_rate_pct: 4, is_shared: true, owner_member_id: null, archived_at: null });
  const balance = await toolGetAccountBalance(HOUSEHOLD, { account_name: "Deposit" }) as { confirmed?: boolean };
  assertEquals(balance.confirmed, true);
  const worth = await toolGetNetWorth(HOUSEHOLD, null) as { unconfirmed_accounts?: number };
  assertEquals(worth.unconfirmed_accounts, undefined);
});
