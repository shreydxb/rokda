// The bot's trade helpers (trades.ts): reading a trade message's arguments,
// matching the stock to a member's holdings, asking for what is missing, and
// writing the confirmation from the database's own figures. Pure functions,
// so they are tested here on their own; index.test.ts drives them through the
// handler.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  ANSWER_HINT,
  applyAnswer,
  draftFromArgs,
  formatMoney,
  type HoldingLite,
  matchHoldings,
  newHoldingFor,
  nextQuestion,
  normaliseSymbol,
  type TradeDraft,
  tradeConfirmation,
  tradeDropSummary,
  tradeRefusal,
  tradeSavedMessage,
  undoConfirmation,
} from "./trades.ts";

const SENDER = "m-sender";
const PARTNER = "m-partner";
const MEMBERS = [{ id: SENDER, display_name: "Tester" }, { id: PARTNER, display_name: "Partner" }];
const TODAY = "2026-10-28";

function holding(over: Partial<HoldingLite>): HoldingLite {
  return {
    id: "h-abc", name: "ABC", currency: "USD", asset_class: "us_equity", price_symbol: "ABC", price_provider: "twelvedata",
    owner_member_id: SENDER, funds_account_id: "f-usd", trades_version: 3, quantity: 15, current_price: 150, ...over,
  };
}

function draft(over: Partial<TradeDraft>): TradeDraft {
  return {
    side: "buy", stock: "ABC", units: 10, price: 120, priceCurrency: null, ratio: null, tradeDate: TODAY, tradedAt: null,
    fees: 0, tax: null, ownerMemberId: SENDER, holdingId: "h-abc", candidates: [], newHolding: null, awaiting: null,
    lastUpdateId: null, ...over,
  };
}

Deno.test("a symbol is matched however the exchange is written", () => {
  assertEquals(normaliseSymbol("abc.ns"), "ABC");
  assertEquals(normaliseSymbol("NSE:ABC"), "ABC");
  assertEquals(normaliseSymbol("A.B.C"), "ABC");
});

Deno.test("a stock is matched to the sender's holdings by symbol or name, closed ones included", () => {
  const mine = holding({});
  const closed = holding({ id: "h-closed", name: "Old Co", price_symbol: "OLD", quantity: 0 });
  const partners = holding({ id: "h-partner-abc", owner_member_id: PARTNER });
  const all = [mine, closed, partners];
  assertEquals(matchHoldings(all, SENDER, "abc").map((h) => h.id), ["h-abc"]);
  assertEquals(matchHoldings(all, SENDER, "old co").map((h) => h.id), ["h-closed"]);
  assertEquals(matchHoldings(all, SENDER, "OLD").map((h) => h.id), ["h-closed"]);
  assertEquals(matchHoldings(all, PARTNER, "ABC").map((h) => h.id), ["h-partner-abc"]);
});

Deno.test("two lots of one stock both match, and another member's never does", () => {
  const lots = [holding({}), holding({ id: "h-abc-2", name: "ABC lot 2" }), holding({ id: "h-p", owner_member_id: PARTNER })];
  assertEquals(matchHoldings(lots, SENDER, "ABC").map((h) => h.id), ["h-abc", "h-abc-2"]);
});

Deno.test("a trade message's arguments become a draft for the sender, or the member named", () => {
  const sale = draftFromArgs({ side: "sell", stock: "ABC", units: 2, price: 150, trade_date: "2026-10-24", brokerage: 1 },
    { senderId: SENDER, members: MEMBERS, today: TODAY });
  assert(!("error" in sale));
  assertEquals([sale.side, sale.units, sale.price, sale.fees, sale.tradeDate, sale.ownerMemberId], ["sell", 2, 150, 1, "2026-10-24", SENDER]);
  const partners = draftFromArgs({ side: "buy", stock: "XYZ", units: 3, price: 600, member: "partner" },
    { senderId: SENDER, members: MEMBERS, today: TODAY });
  assert(!("error" in partners));
  assertEquals([partners.ownerMemberId, partners.tradeDate], [PARTNER, TODAY]);
  assertEquals(draftFromArgs({ side: "buy", stock: "ABC", units: 1, price: 1, trade_date: "2026-11-30" }, { senderId: SENDER, members: MEMBERS, today: TODAY }),
    { error: "future_date" });
  assertEquals(draftFromArgs({ side: "buy", stock: " ", units: 1 }, { senderId: SENDER, members: MEMBERS, today: TODAY }), { error: "no_stock" });
  assertEquals(draftFromArgs({ side: "buy", stock: "ABC", member: "Nobody" }, { senderId: SENDER, members: MEMBERS, today: TODAY }),
    { error: "unknown_member" });
});

Deno.test("a split reads its ratio, with no units or price", () => {
  const split = draftFromArgs({ side: "split", stock: "ABC", ratio: 10 }, { senderId: SENDER, members: MEMBERS, today: TODAY });
  assert(!("error" in split));
  assertEquals([split.side, split.ratio, split.units, split.price], ["split", 10, null, null]);
});

Deno.test("the questions come one at a time: which holding, then units, then price", () => {
  const lots = [holding({}), holding({ id: "h-abc-2", name: "ABC lot 2", quantity: 5 })];
  const which = nextQuestion(draft({ holdingId: null, candidates: ["h-abc", "h-abc-2"], units: null }), lots);
  assertEquals(which?.field, "holding");
  assert(which!.text.includes("1. ") && which!.text.includes("2. "), which!.text);
  assertEquals(nextQuestion(draft({ units: null }), lots), { field: "units", text: "How many ABC did you buy?" });
  assertEquals(nextQuestion(draft({ price: null }), lots), { field: "price", text: "At what price per share, in dollars?" });
  assertEquals(nextQuestion(draft({ price: 1500, priceCurrency: "AED" }), lots),
    { field: "price", text: "ABC trades in dollars. What was the price per share in dollars?" });
  assertEquals(nextQuestion(draft({}), lots), null);
});

Deno.test("a stock not yet held is asked its currency when the message did not say", () => {
  const q = nextQuestion(draft({ stock: "XYZ", holdingId: null, priceCurrency: null }), []);
  assertEquals(q?.field, "currency");
  assertEquals(nextQuestion(draft({ stock: "XYZ", holdingId: null, priceCurrency: "INR" }), []), null);
});

Deno.test("answers are read as numbers, a holding's place in the list, or a currency", () => {
  const lots = [holding({}), holding({ id: "h-abc-2", name: "ABC lot 2" })];
  assertEquals(applyAnswer(draft({ units: null, awaiting: "units" }), "10", lots)?.units, 10);
  assertEquals(applyAnswer(draft({ units: null, awaiting: "units" }), "2.5", lots)?.units, 2.5);
  assertEquals(applyAnswer(draft({ units: null, awaiting: "units" }), "1,000", lots)?.units, 1000);
  assertEquals(applyAnswer(draft({ units: null, awaiting: "units" }), "lunch", lots), null);
  assertEquals(applyAnswer(draft({ holdingId: null, candidates: ["h-abc", "h-abc-2"], awaiting: "holding" }), "2", lots)?.holdingId, "h-abc-2");
  assertEquals(applyAnswer(draft({ holdingId: null, candidates: ["h-abc", "h-abc-2"], awaiting: "holding" }), "3", lots), null);
  assertEquals(applyAnswer(draft({ price: null, awaiting: "price" }), "$150", lots)?.price, 150);
  const dollars = applyAnswer(draft({ price: 1500, priceCurrency: "AED", awaiting: "price" }), "150.5", lots);
  assertEquals([dollars?.price, dollars?.priceCurrency], [150.5, "USD"]);
  assertEquals(applyAnswer(draft({ stock: "XYZ", holdingId: null, awaiting: "currency" }), "rupees", [])?.priceCurrency, "INR");
  // A first buy priced in dirhams, then said to be in dollars: the dirham
  // price is dropped and asked again in dollars, never converted.
  const priced = applyAnswer(draft({ stock: "XYZ", holdingId: null, price: 1500, priceCurrency: "AED", awaiting: "currency" }), "dollars", []);
  assertEquals([priced?.priceCurrency, priced?.price], ["USD", null]);
  assertEquals(nextQuestion(priced!, [])?.text, "At what price per share, in dollars?");
  const filled = applyAnswer(draft({ units: null, awaiting: "units" }), "10", lots);
  assertEquals(filled?.awaiting, null);
});

Deno.test("a stock not yet held gets its feed symbol, class and the owner's one fund in that currency", () => {
  const funds = [
    { id: "f-inr", currency: "INR", owner_member_id: SENDER, archived_at: null },
    { id: "f-usd", currency: "USD", owner_member_id: SENDER, archived_at: null },
    { id: "f-partner-inr", currency: "INR", owner_member_id: PARTNER, archived_at: null },
    { id: "f-old-inr", currency: "INR", owner_member_id: SENDER, archived_at: "2026-01-01T00:00:00Z" },
  ];
  assertEquals(newHoldingFor("xyz", "INR", SENDER, funds), {
    owner_member_id: SENDER, name: "XYZ", asset_class: "india_equity", currency: "INR", price_symbol: "XYZ.NS",
    price_provider: "yahoo", sector: null, funds_account_id: "f-inr",
  });
  const us = newHoldingFor("XYZ", "USD", SENDER, funds);
  assertEquals([us.asset_class, us.price_symbol, us.price_provider, us.funds_account_id], ["us_equity", "XYZ", "twelvedata", "f-usd"]);
  assertEquals(newHoldingFor("XYZ", "USD", PARTNER, funds).funds_account_id, null);
});

const SALE_EFFECT = {
  ok: true, units: 6, price: 150, fees: 1, tax_withheld: 0, units_before: 15, avg_before: 110, holding_units_after: 9,
  holding_avg_after: 110, realised: 239, funds_moves: true, funds_delta: 899, funds_balance_after: 1899, warnings: [],
};
const SALE_CTX = { holdingName: "ABC", ownerName: null, fundName: "Dollar broker funds", currency: "USD", newHolding: null };
const SALE = draft({ side: "sell", units: 6, price: 150, fees: 1, tradeDate: "2026-10-27" });

Deno.test("the spec's worked sale is confirmed in its exact words", () => {
  assertEquals(
    tradeConfirmation(SALE, SALE_EFFECT, SALE_CTX),
    "Sell 6 ABC at $150 on 27 Oct, brokerage $1\nABC: 15 → 9 shares, average stays $110\nProfit $239 · Dollar broker funds +$899\n\n" +
      ANSWER_HINT,
  );
});

Deno.test("each warning the preview raises adds its own line", () => {
  const warned = (w: string, extra: Record<string, unknown> = {}, ctx = {}) =>
    tradeConfirmation(SALE, { ...SALE_EFFECT, ...extra, warnings: [w] }, { ...SALE_CTX, ...ctx });
  assert(warned("possible_duplicate").includes(
    "This looks like a trade already saved: same stock, units and price within two days. Save it again?",
  ));
  assert(warned("fund_below_zero", { funds_balance_after: -120 }).includes(
    "Dollar broker funds would go to −$120. If you added money, record that too; reply yes to save the trade anyway.",
  ));
  assert(warned("price_off_market", {}, { lastPrice: 150 }).includes("Check the price: ABC was last $150."));
  assert(warned("fund_confirmed_after", { funds_moves: false, funds_delta: 0 }).includes(
    "Dollar broker funds is not moved: its balance was confirmed after this trade.",
  ));
});

Deno.test("another member's holding is named as theirs, and an Indian sale's tax is still to confirm", () => {
  assert(tradeConfirmation(SALE, SALE_EFFECT, { ...SALE_CTX, ownerName: "Partner" }).split("\n")[1].startsWith("Partner's ABC:"));
  const indian = tradeConfirmation(draft({ side: "sell", units: 6, price: 150, tax: null }), SALE_EFFECT,
    { ...SALE_CTX, currency: "INR", fundName: "Rupee broker funds" });
  assert(indian.includes("Tax: to confirm from the broker's statement."), indian);
  assert(indian.startsWith("Sell 6 ABC at ₹150"), indian);
});

Deno.test("a buy shows the average moving, and a first buy names the new holding", () => {
  const buy = tradeConfirmation(draft({ units: 5, price: 130 }), {
    ok: true, units: 5, price: 130, fees: 0, units_before: 10, avg_before: 100, holding_units_after: 15, holding_avg_after: 110,
    realised: null, funds_moves: true, funds_delta: -650, funds_balance_after: 350, warnings: [],
  }, SALE_CTX);
  assertEquals(buy.split("\n").slice(0, 3), ["Buy 5 ABC at $130 on 28 Oct", "ABC: 10 → 15 shares, average $100 → $110", "Dollar broker funds −$650"]);
  const first = tradeConfirmation(draft({ stock: "XYZ", units: 3, price: 690, holdingId: null }), {
    ok: true, units: 3, price: 690, fees: 0, units_before: 0, avg_before: null, holding_units_after: 3, holding_avg_after: 690,
    realised: null, funds_moves: true, funds_delta: -2070, funds_balance_after: 930, warnings: [], new_holding: true,
  }, {
    holdingName: "XYZ", ownerName: null, fundName: "Dollar broker funds", currency: "USD",
    newHolding: { owner_member_id: SENDER, name: "XYZ", asset_class: "us_equity", currency: "USD", price_symbol: "XYZ", price_provider: "twelvedata", sector: null, funds_account_id: "f-usd" },
  });
  assert(first.includes("New holding: XYZ (US equity, priced by Twelve Data as XYZ), paid from Dollar broker funds"), first);
  assert(first.includes("XYZ: 3 shares, average $690"), first);
});

Deno.test("an undo says what the holding and the fund go back to", () => {
  const text = undoConfirmation(
    { kind: "sell", units: 6, price: 150, trade_date: "2026-10-27", currency: "USD", holding_name: "ABC" },
    { ok: true, units_before: 9, avg_before: 110, holding_units_after: 15, holding_avg_after: 110, funds_delta: -899 },
    "Dollar broker funds",
  );
  assertEquals(text.split("\n").slice(0, 3), ["Undo: Sell 6 ABC at $150 on 27 Oct", "ABC: 9 → 15 shares, average stays $110", "Dollar broker funds −$899"]);
  assert(text.endsWith(ANSWER_HINT));
});

Deno.test("every refusal says plainly that nothing was saved", () => {
  for (const code of ["exceeds_units", "no_opening", "whole_units_only", "fund_required", "not_broker_funds", "currency_mismatch", "fund_archived", "before_opening", "bad_input", "not_held", "something_new"]) {
    const line = tradeRefusal(code, { holdingName: "ABC", units: 6 });
    assert(line.includes("nothing was saved"), `${code}: ${line}`);
  }
  assertEquals(tradeRefusal("not_held", { holdingName: "XYZ" }), "You don't hold XYZ, so nothing was saved.");
  assert(tradeRefusal("exceeds_units", { holdingName: "ABC", units: 6 }) !== tradeRefusal("fund_required", { holdingName: "ABC" }));
});

Deno.test("money is written the way each currency is, with decimals only when needed", () => {
  assertEquals(formatMoney(1234.5, "USD"), "$1,234.50");
  assertEquals(formatMoney(150, "USD"), "$150");
  assertEquals(formatMoney(1234.5, "INR"), "₹1,234.50");
  assertEquals(formatMoney(1234.5, "AED"), "AED 1,234.50");
  assertEquals(formatMoney(-120, "USD"), "−$120");
});

Deno.test("what a yes saved and what a no dropped are said from the proposal and the database's answer", () => {
  const sale = { kind: "sell", trade_date: "2026-10-27", units: 6, price: 150, holding_name: "ABC", currency: "USD", fund_name: "Dollar broker funds" };
  const effect = { holding_units_after: 9, funds_delta: 899 };
  assertEquals(tradeSavedMessage(sale, effect, { repeat: false, undo: false }), "Saved: Sell 6 ABC at $150 on 27 Oct. ABC now 9 shares; Dollar broker funds +$899.");
  assert(tradeSavedMessage(sale, effect, { repeat: true, undo: false }).startsWith("Already saved: Sell 6 ABC"));
  assertEquals(tradeSavedMessage(sale, { holding_units_after: 15, funds_delta: -899 }, { repeat: false, undo: true }),
    "Undone: Sell 6 ABC at $150 on 27 Oct. ABC now 15 shares; Dollar broker funds −$899.");
  assertEquals(tradeDropSummary(sale, "trade"), "the sale of 6 ABC at $150");
  assertEquals(tradeDropSummary({ ...sale, kind: "buy", units: 10, price: 120 }, "trade_undo"), "the undo of the buy of 10 ABC at $120");
  assertEquals(tradeDropSummary({ kind: "split", units: 10, holding_name: "ABC" }, "trade"), "the split of ABC 10 for 1");
});


Deno.test("a price answered in another currency is asked again, never taken as the holding's", () => {
  const lots = [holding({})];
  const asked = draft({ price: null, awaiting: "price" });
  for (const [answer, currency] of [["AED 480", "AED"], ["₹500", "INR"], ["rs 500", "INR"], ["500 rupees", "INR"]]) {
    const read = applyAnswer(asked, answer, lots);
    assertEquals(read?.priceCurrency, currency, answer);
    assertEquals(nextQuestion(read!, lots)?.text, "ABC trades in dollars. What was the price per share in dollars?", answer);
  }
  const dollars = applyAnswer(asked, "$150", lots);
  assertEquals([dollars?.price, dollars?.priceCurrency, nextQuestion(dollars!, lots)], [150, "USD", null]);
});

Deno.test("a trade dated in another year shows its year in the confirmation", () => {
  const text = tradeConfirmation(draft({ side: "sell", units: 6, price: 150, fees: 1, tradeDate: "2025-12-28" }), SALE_EFFECT,
    { ...SALE_CTX, today: "2026-01-05" });
  assert(text.startsWith("Sell 6 ABC at $150 on 28 Dec 2025, brokerage $1"), text);
  assert(tradeConfirmation(SALE, SALE_EFFECT, { ...SALE_CTX, today: "2026-10-30" }).startsWith("Sell 6 ABC at $150 on 27 Oct,"));
});
