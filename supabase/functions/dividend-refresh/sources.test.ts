// What the dividend feed reads from Yahoo and Alpha Vantage, and which checks
// it plans for a night. The Alpha Vantage dividends and splits answers and
// its refusal are its public demo answers, renamed; every other fixture is
// synthetic, in each source's exact shape.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  type FollowedSymbol,
  parseAlphaVantageDividends,
  parseAlphaVantageSplits,
  parseYahooChart,
  planAlphaVantageCalls,
  planYahooSymbols,
} from "./sources.ts";

const fixture = (name: string) => JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

Deno.test("Yahoo: a combined ordinary and special dividend is one amount, on its Indian ex-date", () => {
  const { dividends } = parseYahooChart(fixture("yahoo-combined-special.json"));
  assert(dividends.ok);
  const feb = dividends.items.find((d) => d.ex_date === "2025-02-14");
  assertEquals(feb, { ex_date: "2025-02-14", amount: 60, currency: "INR", pay_date: null, record_date: null, declared_on: null });
  assertEquals(dividends.covered_from, "2005-04-01");
});

Deno.test("Yahoo: a bonus issue arrives as a split with its ratio", () => {
  const { splits } = parseYahooChart(fixture("yahoo-bonus.json"));
  assert(splits.ok);
  assertEquals(splits.items.find((s) => s.effective_date === "2023-03-10"), { effective_date: "2023-03-10", ratio: 2 });
});

Deno.test("Yahoo: an unknown symbol is a failure, not an empty list", () => {
  const { dividends, splits } = parseYahooChart(fixture("yahoo-not-found.json"));
  assertEquals(dividends.ok, false);
  assertEquals(splits.ok, false);
  assertEquals(parseYahooChart({}).dividends.ok, false);
});

Deno.test("Alpha Vantage: dividends with every date, and None read as no date", () => {
  const result = parseAlphaVantageDividends(fixture("av-dividends.json"));
  assert(result.ok);
  assertEquals(result.items[0], {
    ex_date: "2026-11-10", amount: 1.69, currency: null, pay_date: "2026-12-10", record_date: "2026-11-10", declared_on: "2026-10-21",
  });
  const oldest = result.items[result.items.length - 1];
  assertEquals(oldest.pay_date, null);
  assertEquals(oldest.declared_on, null);
  assertEquals(result.covered_from, oldest.ex_date);
});

Deno.test("Alpha Vantage: amounts as paid, and a zero entry skipped", () => {
  const result = parseAlphaVantageDividends(fixture("av-dividends-split.json"));
  assert(result.ok);
  assertEquals(result.items.find((d) => d.ex_date === "2025-05-16")?.amount, 0.2);
  assertEquals(result.items.some((d) => d.ex_date === "2025-05-30"), false);
});

Deno.test("Alpha Vantage: a note or limit message at HTTP 200 is a failure", () => {
  assertEquals(parseAlphaVantageDividends(fixture("av-information.json")).ok, false);
  assertEquals(parseAlphaVantageDividends({}).ok, false);
  assertEquals(parseAlphaVantageDividends({ symbol: "ABC" }).ok, false);
  assertEquals(parseAlphaVantageSplits(fixture("av-information.json")).ok, false);
});

Deno.test("Alpha Vantage: splits with their factors", () => {
  const result = parseAlphaVantageSplits(fixture("av-splits.json"));
  assert(result.ok);
  assertEquals(result.items[0], { effective_date: "2021-11-04", ratio: 1.046 });
});

const NOW = new Date("2026-11-02T01:30:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const sym = (symbol: string, over: Partial<FollowedSymbol> = {}): FollowedSymbol => ({
  symbol, provider: "alphavantage", held: true,
  dividends_last_success_at: daysAgo(1), splits_last_success_at: daysAgo(1),
  ex_passed_since_success: false, needs_splits: false, ...over,
});

Deno.test("Yahoo plan: held shares every night, sold ones weekly", () => {
  const plan = planYahooSymbols([
    sym("A.NS", { provider: "yahoo" }),
    sym("B.NS", { provider: "yahoo", held: false, dividends_last_success_at: daysAgo(2) }),
    sym("C.NS", { provider: "yahoo", held: false, dividends_last_success_at: daysAgo(8) }),
    sym("D.NS", { provider: "yahoo", held: false, dividends_last_success_at: null }),
    sym("E"),
  ], NOW);
  assertEquals(plan, ["A.NS", "C.NS", "D.NS"]);
});

Deno.test("Alpha Vantage plan: nothing due, no calls", () => {
  assertEquals(planAlphaVantageCalls([sym("A"), sym("B", { dividends_last_success_at: daysAgo(2) })], NOW), []);
});

Deno.test("Alpha Vantage plan: an ex-date just passed first, then never checked, never more than five", () => {
  const plan = planAlphaVantageCalls([
    sym("OLD1", { dividends_last_success_at: daysAgo(9) }),
    sym("OLD2", { dividends_last_success_at: daysAgo(5) }),
    sym("NEW", { dividends_last_success_at: null, splits_last_success_at: daysAgo(1) }),
    sym("EXPASSED", { ex_passed_since_success: true }),
    sym("OLD3", { dividends_last_success_at: daysAgo(4) }),
    sym("OLD4", { dividends_last_success_at: daysAgo(7) }),
    sym("OLD5", { dividends_last_success_at: daysAgo(6) }),
  ], NOW);
  assertEquals(plan.length, 5);
  assertEquals(plan.slice(0, 2), [{ fn: "DIVIDENDS", symbol: "EXPASSED" }, { fn: "DIVIDENDS", symbol: "NEW" }]);
  assertEquals(plan.slice(2).map((c) => c.symbol), ["OLD1", "OLD4", "OLD5"]);
});

Deno.test("Alpha Vantage plan: a split check keeps a place, and a changed past amount goes first", () => {
  const plan = planAlphaVantageCalls([
    sym("A", { dividends_last_success_at: daysAgo(9) }),
    sym("B", { dividends_last_success_at: daysAgo(8) }),
    sym("C", { dividends_last_success_at: daysAgo(7) }),
    sym("D", { dividends_last_success_at: daysAgo(6) }),
    sym("E", { dividends_last_success_at: daysAgo(5) }),
    sym("F", { splits_last_success_at: null }),
    sym("G", { needs_splits: true }),
  ], NOW);
  assertEquals(plan.length, 5);
  assertEquals(plan.filter((c) => c.fn === "DIVIDENDS").length, 4);
  assertEquals(plan[4], { fn: "SPLITS", symbol: "G" });
});

Deno.test("Alpha Vantage plan: a sold share is checked weekly", () => {
  assertEquals(planAlphaVantageCalls([sym("S", { held: false, dividends_last_success_at: daysAgo(5) })], NOW), []);
  assertEquals(planAlphaVantageCalls([sym("S", { held: false, dividends_last_success_at: daysAgo(8) })], NOW), [{ fn: "DIVIDENDS", symbol: "S" }]);
});

// An answer with an item that cannot be read is a failure, never a shorter
// list: a shorter list would read as dividends the source dropped.
Deno.test("Yahoo: an unreadable dividend or split fails the answer; a zero amount is skipped", () => {
  const chart = (dividends: unknown, splits: unknown = {}) => ({
    chart: { result: [{ meta: { currency: "INR", exchangeTimezoneName: "Asia/Kolkata", firstTradeDate: 1_000_000_000 }, events: { dividends, splits } }] },
  });
  assertEquals(parseYahooChart(chart({ a: { amount: "abc", date: 1_700_000_000 } })).dividends.ok, false);
  assertEquals(parseYahooChart(chart({ a: { amount: 1, date: "soon" } })).dividends.ok, false);
  assertEquals(parseYahooChart(chart({}, { a: { numerator: 2, denominator: 0, date: 1_700_000_000 } })).splits.ok, false);
  const zero = parseYahooChart(chart({ a: { amount: 0, date: 1_700_000_000 }, b: { amount: 1, date: 1_710_000_000 } })).dividends;
  assert(zero.ok);
  assertEquals(zero.items.length, 1);
});

Deno.test("Yahoo: a share with no events reads as no dividends (the database refuses that for a share it had)", () => {
  const result = parseYahooChart({ chart: { result: [{ meta: { currency: "INR", exchangeTimezoneName: "Asia/Kolkata", firstTradeDate: 1_000_000_000 } }] } });
  assert(result.dividends.ok);
  assertEquals(result.dividends.items, []);
});

Deno.test("Alpha Vantage: an unreadable entry fails the answer; a zero amount is skipped", () => {
  const entry = (over: Record<string, string>) => ({ ex_dividend_date: "2025-03-01", declaration_date: "None", record_date: "None", payment_date: "None", amount: "0.5", ...over });
  assertEquals(parseAlphaVantageDividends({ data: [entry({}), entry({ ex_dividend_date: "None" })] }).ok, false);
  assertEquals(parseAlphaVantageDividends({ data: [entry({ amount: "n/a" })] }).ok, false);
  assertEquals(parseAlphaVantageSplits({ data: [{ effective_date: "2025-06-01", split_factor: "x" }] }).ok, false);
  const zero = parseAlphaVantageDividends({ data: [entry({ amount: "0.0" }), entry({ ex_dividend_date: "2025-06-01" })] });
  assert(zero.ok);
  assertEquals(zero.items.length, 1);
});
