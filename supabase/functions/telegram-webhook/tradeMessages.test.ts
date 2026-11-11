// Trades by message: previews, questions, confirmations, undo, splits and profit.
// The fake backend these drive the real handler against is testing/harness.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { ABC, aiCalls, backend, capturedIntake, dailyCheck, dubaiDaysAgo, dubaiToday, figuresUnavailableMessage, freshTest, handler, HOUSEHOLD, lastReply, MEMBER, replyUpdate, Row, sendCount, textUpdate, tradeFixtures, USD_FUND } from "./testing/harness.ts";

freshTest("a share bought by message goes to the trade preview, never the Inbox", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC", units: 10, price: 120 } };
  await handler(textUpdate(7401, "bought 10 ABC at 120"));
  assertEquals(capturedIntake().length, 0);
  const preview = backend.rpcCalls.find((c) => c.fn === "preview_trade");
  assert(preview, "preview_trade was never called");
  assertEquals([preview.args.p_holding_id, preview.args.p_kind, preview.args.p_units, preview.args.p_price], [ABC, "buy", 10, 120]);
});

freshTest("a trade dated after today is refused before any preview", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC", units: 10, price: 120, trade_date: "2099-11-30" } };
  await handler(textUpdate(7402, "bought 10 ABC at 120 on 30 Nov 2099"));
  assert(lastReply().startsWith("That date hasn't happened yet"), lastReply());
  assertEquals(backend.rpcCalls.filter((c) => c.fn.startsWith("preview")).length, 0);
  assertEquals(capturedIntake().length, 0);
  assertEquals(backend.tables.bot_proposals.length, 0);
});

freshTest("a sale of a stock not held says so and saves nothing", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "sell", stock: "XYZ", units: 2, price: 50 } };
  await handler(textUpdate(7403, "sold 2 XYZ at 50"));
  assertEquals(lastReply(), "You don't hold XYZ, so nothing was saved.");
  assertEquals(capturedIntake().length, 0);
  assertEquals(backend.tables.bot_proposals.length, 0);
});

freshTest("the router is told a share trade is log_trade, never an expense", async () => {
  await handler(textUpdate(7404, "spent 40 on lunch"));
  assert(backend.routerPrompts[0]?.includes("call log_trade"), backend.routerPrompts[0]);
});

// The member's trade still being asked about, if any.
function askingRow(): Row | undefined {
  return backend.tables.bot_proposals.find((r) => r.kind === "trade" && r.status === "asking");
}

function tradeProposals(): Row[] {
  return backend.tables.bot_proposals.filter((r) => r.kind === "trade" && r.status !== "asking");
}

freshTest("a trade with no units asks how many, and the answer completes it", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC", price: 120 } };
  await handler(textUpdate(7411, "bought ABC at 120"));
  assertEquals(lastReply(), "How many ABC did you buy?");
  const asked = askingRow();
  assert(asked, "no asking draft was kept");
  await handler(replyUpdate(7412, "10", Number(asked.prompt_message_id)));
  const preview = backend.rpcCalls.find((c) => c.fn === "preview_trade");
  assertEquals([preview?.args.p_units, preview?.args.p_price], [10, 120]);
  assertEquals(tradeProposals().map((r) => r.status), ["proposed"]);
  assertEquals(askingRow(), undefined);
  assert(lastReply().startsWith("Buy 10 ABC at $120"), lastReply());
});

// D-07: a clarifying question that never reached the member, or whose
// message could not be recorded, is not a finished update: Telegram is asked
// to deliver the message again, and the retry asks the question afresh.
freshTest("a trade question Telegram refuses is retried, and the retry asks it", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC", price: 120 } };
  backend.faults.refuseFirstSends = 1;
  const first = await handler(textUpdate(7421, "bought ABC at 120"));
  assertEquals(first.status, 500);
  assertEquals(backend.log.get(7421)?.status, "failed");
  // The retry finds the draft and asks again: the message is not read afresh.
  const aiBefore = backend.aiCalls;
  const retried = await handler(textUpdate(7421, "bought ABC at 120"));
  assertEquals(backend.aiCalls, aiBefore, "the retry read the message again instead of asking the draft's question");
  assertEquals(retried.status, 200);
  assertEquals(lastReply(), "How many ABC did you buy?");
  assertEquals(backend.tables.bot_proposals.filter((r) => r.status === "asking").length, 1);
  assert(askingRow()?.prompt_message_id, "the question asked on the retry was not bound");
});

// The fresh review of the second group (R1): the draft remembers the update
// that last used it, so a question asked again for an older draft (a stale
// "yes") is remembered against this update, not the draft's earlier one.
freshTest("a stale trade's question, lost, is asked again on the retry", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "sell", stock: "ABC", price: 150 } };
  await handler(textUpdate(7601, "sold ABC at 150"));
  assertEquals(lastReply(), "How many ABC did you sell?");
  await handler(replyUpdate(7602, "6", Number(askingRow()!.prompt_message_id)));
  assertEquals(tradeProposals().map((r) => r.status), ["proposed"]);
  // The holding became two of the same name in between.
  const h = backend.tables.holdings[0];
  backend.tables.holdings = [{ ...h, id: "a1000000-0000-4000-8000-0000000000a2" }, { ...h, id: "a1000000-0000-4000-8000-0000000000a3" }];
  backend.tradeOutcome = { outcome: "stale" };
  // The lead and the "Which ABC?" question are both refused.
  backend.faults.refuseFirstSends = sendCount + 2;
  assertEquals((await handler(textUpdate(7603, "yes"))).status, 500);
  backend.tradeOutcome = undefined;
  assertEquals((await handler(textUpdate(7603, "yes"))).status, 200);
  assert(lastReply().startsWith("Which ABC?"), lastReply());
});

freshTest("a trade question whose message cannot be recorded is retried until it is", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC", price: 120 } };
  backend.faults.failPromptRecord = 2;
  const first = await handler(textUpdate(7422, "bought ABC at 120"));
  assertEquals(first.status, 500);
  const retried = await handler(textUpdate(7422, "bought ABC at 120"));
  assertEquals(retried.status, 200);
  const asked = askingRow();
  assert(asked?.prompt_message_id, "the question was not bound");
  // A reply to the question that was recorded reaches the draft.
  await handler(replyUpdate(7423, "10", Number(asked!.prompt_message_id)));
  assertEquals(tradeProposals().map((r) => r.status), ["proposed"]);
});

freshTest("a trade with no price asks for it, and the next message answers it", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC", units: 10 } };
  await handler(textUpdate(7413, "bought 10 ABC"));
  assertEquals(lastReply(), "At what price per share, in dollars?");
  await handler(textUpdate(7414, "120"));
  assertEquals(backend.rpcCalls.find((c) => c.fn === "preview_trade")?.args.p_price, 120);
  assertEquals(tradeProposals().length, 1);
});

freshTest("two lots of one stock are asked about by number", async () => {
  tradeFixtures();
  const second = "a3700000-0000-4000-8000-0000000000a2";
  backend.tables.holdings.push({ ...backend.tables.holdings[0], id: second, name: "ABC lot 2", quantity: 5 });
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC", units: 1, price: 120 } };
  await handler(textUpdate(7415, "bought 1 ABC at 120"));
  assert(lastReply().includes("1. ") && lastReply().includes("2. "), lastReply());
  await handler(textUpdate(7416, "2"));
  assertEquals(backend.rpcCalls.find((c) => c.fn === "preview_trade")?.args.p_holding_id, second);
});

freshTest("a price in dirhams for a dollar share is asked again in dollars, never converted", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC", units: 10, price: 1500, currency: "AED" } };
  await handler(textUpdate(7417, "bought 10 ABC at AED 1500"));
  assertEquals(lastReply(), "ABC trades in dollars. What was the price per share in dollars?");
  await handler(textUpdate(7418, "130"));
  assertEquals(backend.rpcCalls.find((c) => c.fn === "preview_trade")?.args.p_price, 130);
});

freshTest("a message that does not answer the question is its own message; a reply that does not is told what is needed", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC", price: 120 } };
  await handler(textUpdate(7419, "bought ABC at 120"));
  const asked = askingRow();
  backend.route = { tool: "log_expense", args: {} };
  await handler(textUpdate(7420, "spent 40 on lunch"));
  assertEquals(capturedIntake().length, 1);
  assert(askingRow(), "the draft was dropped by an unrelated message");
  await handler(replyUpdate(7421, "lunch", Number(asked!.prompt_message_id)));
  assertEquals(lastReply(), "I need a number, like 10 or 2.5.");
  assertEquals(capturedIntake().length, 1);
});

freshTest("an answer Telegram delivers twice fills its question once, and the next question is asked again", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC" } };
  await handler(textUpdate(7422, "bought ABC"));
  assertEquals(lastReply(), "How many ABC did you buy?");
  await handler(textUpdate(7423, "10"));
  assertEquals(lastReply(), "At what price per share, in dollars?");
  // The run failed after answering, so Telegram delivers "10" again.
  backend.log.get(7423)!.status = "failed";
  await handler(textUpdate(7423, "10"));
  assertEquals(lastReply(), "At what price per share, in dollars?");
  const draft = (askingRow()!.payload as Row).draft as Row;
  assertEquals([draft.units, draft.price], [10, null]);
  assertEquals(backend.rpcCalls.filter((c) => c.fn === "preview_trade").length, 0);
});

freshTest("the answer that completes a trade, delivered twice, proposes it once", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC", price: 120 } };
  await handler(textUpdate(7424, "bought ABC at 120"));
  await handler(textUpdate(7425, "10"));
  backend.log.get(7425)!.status = "failed";
  backend.route = { tool: "log_expense", args: {} };
  await handler(textUpdate(7425, "10"));
  assertEquals(tradeProposals().length, 1);
  assertEquals(capturedIntake().length, 0);
});

freshTest("a bare yes while a trade is still being asked about applies nothing", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC", price: 120 } };
  await handler(textUpdate(7426, "bought ABC at 120"));
  await handler(textUpdate(7427, "yes"));
  assertEquals(backend.applyCalls, 0);
  assert(askingRow(), "the draft was dropped by a bare yes");
  assertEquals(tradeProposals().length, 0);
});

const TRADE_PARTNER = "a3700000-0000-4000-8000-0000000000b2";
const XYZ = "a3700000-0000-4000-8000-0000000000a3";

// Partner holds XYZ, bought through their own dollar fund.
function partnerFixtures(): void {
  backend.tables.household_members.push({ id: TRADE_PARTNER, household_id: HOUSEHOLD, display_name: "Partner", telegram_user_id: null, role: "member" });
  backend.tables.holdings.push({ ...backend.tables.holdings[0], id: XYZ, name: "XYZ", price_symbol: "XYZ", owner_member_id: TRADE_PARTNER, funds_account_id: "a3700000-0000-4000-8000-0000000000f2" });
  backend.tables.accounts.push({
    id: "a3700000-0000-4000-8000-0000000000f2", household_id: HOUSEHOLD, name: "Partner's dollar funds", type: "broker_funds",
    currency: "USD", owner_member_id: TRADE_PARTNER, is_shared: false, archived_at: null, balance: 1000,
  });
}

async function sixABCSoldOn27Oct(updateId: number): Promise<void> {
  backend.route = { tool: "log_trade", args: { side: "sell", stock: "ABC", units: 6, price: 150, trade_date: "2026-10-27", brokerage: 1 } };
  await handler(textUpdate(updateId, "sold 6 ABC at 150 on 27 Oct, brokerage 1"));
}

freshTest("the three trades are confirmed with the database's figures, in the spec's words", async () => {
  tradeFixtures();
  partnerFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC", units: 10, price: 182.5 } };
  await handler(textUpdate(7501, "bought 10 ABC at 182.5"));
  const buy = lastReply().split("\n");
  assert(buy[0].startsWith("Buy 10 ABC at $182.50 on "), buy[0]);
  assertEquals(buy.slice(1, 3), ["ABC: 15 → 25 shares, average $110 → $139", "Dollar broker funds −$1,825"]);
  backend.route = { tool: "log_trade", args: { side: "sell", stock: "ABC", units: 2, price: 430, trade_date: "2026-10-24", brokerage: 1 } };
  await handler(textUpdate(7502, "sold 2 ABC at 430 on 24 Oct, brokerage 1"));
  assertEquals(lastReply().split("\n").slice(0, 3), ["Sell 2 ABC at $430 on 24 Oct, brokerage $1", "ABC: 15 → 13 shares, average stays $110", "Profit $639 · Dollar broker funds +$859"]);
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "XYZ", units: 3, price: 690, member: "Partner" } };
  await handler(textUpdate(7503, "Partner bought 3 XYZ at 690"));
  assert(lastReply().split("\n")[1].startsWith("Partner's XYZ: 15 → 18 shares"), lastReply());
  assert(lastReply().includes("Partner's dollar funds −$2,070"), lastReply());
  assertEquals(tradeProposals().length, 3);
});

freshTest("yes saves the trade once and says what was saved", async () => {
  tradeFixtures();
  await sixABCSoldOn27Oct(7511);
  await handler(textUpdate(7512, "yes"));
  assertEquals(backend.applyCalls, 1);
  assertEquals(lastReply(), "Saved: Sell 6 ABC at $150 on 27 Oct. ABC now 9 shares; Dollar broker funds +$899.");
  await handler(textUpdate(7513, "yes"));
  assert(lastReply().startsWith("Already saved: Sell 6 ABC at $150 on 27 Oct."), lastReply());
});

freshTest("no drops the trade and says which", async () => {
  tradeFixtures();
  await sixABCSoldOn27Oct(7514);
  await handler(textUpdate(7515, "no"));
  assertEquals(lastReply(), "Dropped the sale of 6 ABC at $150. Nothing was saved.");
  assertEquals(backend.applyCalls, 0);
});

freshTest("a yes after the holding changed saves nothing and confirms again with today's figures", async () => {
  tradeFixtures();
  await sixABCSoldOn27Oct(7516);
  backend.tradeOutcome = { outcome: "stale" };
  await handler(textUpdate(7517, "yes"));
  const sent = backend.telegramSent.map((m) => String(m.body.text));
  assertEquals(sent.at(-2), "ABC changed since I asked, so nothing was saved. Here it is again with today's figures:");
  assert(sent.at(-1)!.startsWith("Sell 6 ABC at $150 on 27 Oct"), sent.at(-1));
  assertEquals(tradeProposals().map((r) => r.status), ["expired", "proposed"]);
});

freshTest("a yes after the confirmation lapsed confirms again with today's figures", async () => {
  tradeFixtures();
  await sixABCSoldOn27Oct(7518);
  backend.tradeOutcome = { outcome: "expired" };
  await handler(textUpdate(7519, "yes"));
  assert(lastReply().startsWith("Sell 6 ABC at $150 on 27 Oct"), lastReply());
  assertEquals(tradeProposals().filter((r) => r.status === "proposed").length, 1);
});

freshTest("a trade the database refuses on yes says why, and saves nothing", async () => {
  tradeFixtures();
  await sixABCSoldOn27Oct(7520);
  backend.tradeOutcome = { outcome: "refused", error: "exceeds_units" };
  await handler(textUpdate(7521, "yes"));
  assertEquals(lastReply(), "That sells more ABC than was held on that date (6), so nothing was saved.");
});

freshTest("a first buy of a stock is previewed as a new holding, with its feed and fund shown", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "XYZ", units: 3, price: 690, currency: "USD" } };
  await handler(textUpdate(7522, "bought 3 XYZ at $690"));
  const preview = backend.rpcCalls.find((c) => c.fn === "preview_new_holding_trade");
  assert(preview, "the new holding was not previewed");
  assertEquals((preview.args.p_new_holding as Row).price_symbol, "XYZ");
  assert(lastReply().includes("New holding: XYZ (US equity, priced by Twelve Data as XYZ), paid from Dollar broker funds"), lastReply());
  assertEquals(((tradeProposals()[0].payload as Row).new_holding as Row).name, "XYZ");
});

freshTest("a first buy with no broker fund in its currency says one is needed", async () => {
  tradeFixtures();
  backend.tables.accounts = backend.tables.accounts.filter((a) => a.id !== USD_FUND);
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "XYZ", units: 3, price: 690, currency: "USD" } };
  await handler(textUpdate(7523, "bought 3 XYZ at $690"));
  assertEquals(lastReply(), "There's no broker funds account for XYZ's money to come from or go to, so nothing was saved. Add one in Wealth, then send the trade again.");
  assertEquals(tradeProposals().length, 0);
});


// The sender's trades on ABC: its opening, a buy, then the sale of 6 at 150
// (their latest); and a later trade someone else recorded.
function recordedTrades(): void {
  const trade = (id: string, kind: string, units: number, price: number | null, day: string, by: string) => ({
    id, household_id: HOUSEHOLD, holding_id: ABC, kind, units, price, trade_date: day, created_by: by,
    created_at: `${day}T08:00:00Z`, funds_account_id: kind === "opening" ? null : USD_FUND,
  });
  backend.tables.holding_trades = [
    trade("t-open", "opening", 15, 110, "2026-10-20", MEMBER),
    trade("t-buy", "buy", 1, 120, "2026-10-25", MEMBER),
    trade("t-sale", "sell", 6, 150, "2026-10-27", MEMBER),
    trade("t-other", "buy", 1, 140, "2026-10-28", "a3700000-0000-4000-8000-0000000000b9"),
  ];
}

freshTest("undo last trade proposes undoing the sender's latest trade, and yes undoes it", async () => {
  tradeFixtures();
  recordedTrades();
  backend.route = { tool: "undo_last_trade", args: {} };
  await handler(textUpdate(7601, "undo last trade"));
  assertEquals(backend.rpcCalls.find((c) => c.fn === "preview_delete_trade")?.args.p_trade_id, "t-sale");
  assertEquals(lastReply().split("\n").slice(0, 3), ["Undo: Sell 6 ABC at $150 on 27 Oct", "ABC: 9 → 15 shares, average stays $110", "Dollar broker funds −$899"]);
  assertEquals(backend.tables.bot_proposals.filter((r) => r.kind === "trade_undo").length, 1);
  assertEquals(capturedIntake().length, 0);
  await handler(textUpdate(7602, "yes"));
  assertEquals(lastReply(), "Undone: Sell 6 ABC at $150 on 27 Oct. ABC now 15 shares; Dollar broker funds −$899.");
});

freshTest("undo with no trades of the sender's says there is nothing to undo", async () => {
  tradeFixtures();
  backend.tables.holding_trades = [];
  backend.route = { tool: "undo_last_trade", args: {} };
  await handler(textUpdate(7603, "undo last trade"));
  assertEquals(lastReply(), "You have no trades to undo.");
  assertEquals(capturedIntake().length, 0);
});

freshTest("a split is confirmed with the units and average it gives, and no money line", async () => {
  tradeFixtures();
  backend.previews.preview_trade = {
    ok: true, units: 10, price: null, fees: 0, tax_withheld: 0, trades_version: 3, units_before: 9, avg_before: 110,
    holding_units_after: 90, holding_avg_after: 11, realised: null, funds_account_id: null, funds_delta: 0, warnings: [],
  };
  backend.route = { tool: "log_trade", args: { side: "split", stock: "ABC", ratio: 10 } };
  await handler(textUpdate(7604, "ABC split 10 for 1"));
  const lines = lastReply().split("\n");
  assert(lines[0].startsWith("Split ABC 10 for 1 on "), lines[0]);
  assertEquals(lines.slice(1, 3), ["ABC: 9 → 90 shares, average $110 → $11", ""]);
  const preview = backend.rpcCalls.find((c) => c.fn === "preview_trade");
  assertEquals([preview?.args.p_kind, preview?.args.p_units, preview?.args.p_price], ["split", 10, null]);
});

freshTest("a large move between two price days with no trade between asks the owner about a split, once", async () => {
  tradeFixtures();
  const today = dubaiToday();
  const yesterday = dubaiDaysAgo(1);
  // The providers' own day change is adjusted for a split, so it cannot show
  // one: the move is read from the holding's own stored values.
  backend.tables.holding_value_history = [
    { id: "v1", holding_id: ABC, as_of: yesterday, value_aed: 1000 },
    { id: "v2", holding_id: ABC, as_of: today, value_aed: 500 },
  ];
  backend.tables.holding_trades = [];
  Object.assign(backend.tables.holdings[0], { day_change_pct: 0, split_asked_for: null });
  // Moved as much, but never traded: its units are its own, not a replay's.
  backend.tables.holdings.push({ ...backend.tables.holdings[0], id: "a3700000-0000-4000-8000-0000000000a9", name: "UNTRADED", trades_version: 0 });
  backend.tables.holding_value_history.push(
    { id: "v3", holding_id: "a3700000-0000-4000-8000-0000000000a9", as_of: yesterday, value_aed: 1000 },
    { id: "v4", holding_id: "a3700000-0000-4000-8000-0000000000a9", as_of: today, value_aed: 400 },
  );
  await handler(dailyCheck());
  const asked = () => backend.telegramSent.map((m) => String(m.body.text)).filter((t) => t.includes("If it split"));
  assertEquals(asked(), ['ABC moved −50% on its last price. If it split, tell me, e.g. "ABC split 2 for 1". If not, ignore this.']);
  assertEquals(backend.tables.holdings[0].split_asked_for, today);
  await handler(dailyCheck());
  assertEquals(asked().length, 1);
});

freshTest("a value that moved because of a trade is not asked about as a split", async () => {
  tradeFixtures();
  const today = dubaiToday();
  const yesterday = dubaiDaysAgo(1);
  backend.tables.holding_value_history = [
    { id: "v1", holding_id: ABC, as_of: yesterday, value_aed: 1000 },
    { id: "v2", holding_id: ABC, as_of: today, value_aed: 500 },
  ];
  backend.tables.holding_trades = [{
    id: "t-half", household_id: HOUSEHOLD, holding_id: ABC, kind: "sell", units: 7, price: 150, trade_date: today,
    created_by: MEMBER, created_at: `${today}T08:00:00Z`, funds_account_id: USD_FUND,
  }];
  Object.assign(backend.tables.holdings[0], { split_asked_for: null });
  await handler(dailyCheck());
  assertEquals(backend.telegramSent.filter((m) => String(m.body.text).includes("If it split")).length, 0);
});

const RUPCO = "a3700000-0000-4000-8000-0000000000a4";

// ABC sold twice this year (100 profit each) and once last year; RUPCO, an
// Indian share, sold once this year for a profit of 2,290 rupees.
function recordedSales(): number {
  const year = Number(dubaiToday().slice(0, 4));
  backend.tables.holdings.push({
    ...backend.tables.holdings[0], id: RUPCO, name: "RUPCO", currency: "INR", asset_class: "india_equity", price_symbol: "RUPCO.NS",
    price_provider: "yahoo",
  });
  const sale = (id: string, holding: string, day: string, realised: number, tax: number) => ({
    id, household_id: HOUSEHOLD, holding_id: holding, kind: "sell", units: 1, price: 1, trade_date: day, realised, tax_withheld: tax,
    created_by: MEMBER, created_at: `${day}T08:00:00Z`, funds_account_id: USD_FUND,
  });
  backend.tables.holding_trades = [
    sale("s1", ABC, `${year}-03-10`, 100, 0),
    sale("s2", ABC, `${year}-06-10`, 100, 0),
    sale("s3", ABC, `${year - 1}-12-10`, 999, 0),
    sale("s4", RUPCO, `${year}-05-01`, 2290, 10),
  ];
  backend.tables.fx_rate_history = [
    { base: "AED", quote: "INR", day: `${year}-04-30`, rate: 22.9 },
    { base: "AED", quote: "INR", day: `${year}-06-01`, rate: 25 },
  ];
  return year;
}

freshTest("what a share made this year is summed from its sales this year, in dirhams at the peg", async () => {
  tradeFixtures();
  recordedSales();
  backend.route = { tool: "get_trade_profit", args: { stock: "ABC", scope: "me" } };
  await handler(textUpdate(7701, "what did I make on ABC this year?"));
  const given = backend.phrasePrompts.join("\n");
  assert(given.includes('\\"sales\\":2'), given);
  assert(given.includes('\\"profit\\":200'), given);
  assert(given.includes('\\"profit_aed\\":734.5'), given);
});

freshTest("a rupee sale is valued in dirhams at its own day's rate", async () => {
  tradeFixtures();
  recordedSales();
  backend.route = { tool: "get_trade_profit", args: { stock: "RUPCO", scope: "me" } };
  await handler(textUpdate(7702, "what did I make on RUPCO this year?"));
  const given = backend.phrasePrompts.join("\n");
  assert(given.includes('\\"profit_aed\\":100'), given);
  assert(given.includes('\\"tax_withheld\\":10'), given);
});

freshTest("profit on a share not held names the ones that are", async () => {
  tradeFixtures();
  recordedSales();
  backend.route = { tool: "get_trade_profit", args: { stock: "XYZ", scope: "me" } };
  await handler(textUpdate(7703, "what did I make on XYZ this year?"));
  const given = backend.phrasePrompts.join("\n");
  assert(given.includes("holding_not_found") && given.includes("ABC") && given.includes("RUPCO"), given);
});

freshTest("profit with its trades unreadable says the figures are unavailable", async () => {
  tradeFixtures();
  recordedSales();
  backend.faults.failReads = ["holding_trades"];
  backend.route = { tool: "get_trade_profit", args: { stock: "ABC", scope: "me" } };
  await handler(textUpdate(7704, "what did I make on ABC this year?"));
  assertEquals(lastReply(), figuresUnavailableMessage());
  assertEquals(capturedIntake().length, 0);
});


freshTest("the router is told today's date, so a day and month are read in this year", async () => {
  await handler(textUpdate(7801, "sold 2 ABC at 150 on 24 Oct"));
  assert(backend.routerPrompts[0]?.includes(`Today's date is ${dubaiToday()}`), backend.routerPrompts[0]);
});

freshTest("a reply to an earlier question of the same trade answers the question now asked", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC" } };
  await handler(textUpdate(7802, "bought ABC"));
  const first = Number(askingRow()!.prompt_message_id);
  await handler(replyUpdate(7803, "10", first));
  assertEquals(lastReply(), "At what price per share, in dollars?");
  backend.route = { tool: "log_expense", args: {} };
  await handler(replyUpdate(7804, "120", first));
  assertEquals(backend.rpcCalls.find((c) => c.fn === "preview_trade")?.args.p_price, 120);
  assertEquals(capturedIntake().length, 0);
});

freshTest("an answer Telegram delivers again long after the question is still recognised", async () => {
  tradeFixtures();
  backend.route = { tool: "log_trade", args: { side: "buy", stock: "ABC" } };
  await handler(textUpdate(7805, "bought ABC"));
  await handler(textUpdate(7806, "10"));
  const row = askingRow()!;
  (row.payload as Row).asked_at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  backend.log.get(7806)!.status = "failed";
  backend.route = { tool: "log_expense", args: {} };
  await handler(textUpdate(7806, "10"));
  assertEquals(lastReply(), "At what price per share, in dollars?");
  assertEquals(capturedIntake().length, 0);
});

// ---------------------------------------------------------------------------
// Dividends: asked about once they are due in a fund, received on a "yes"
// (SHR-366), and never logged as income
// ---------------------------------------------------------------------------
