// The bot's dividend messages (dividends.ts): the morning question about
// dividends due in a fund, what a "yes" recorded, what a "no" left, and the
// guard that keeps a dividend typed as income out of the ledger. Pure
// functions; the handler tests (dividendReceipts.test.ts) drive them through
// the handler.
import { assertEquals } from "jsr:@std/assert@1";
import {
  DIVIDEND_GUARD_REPLY,
  type DividendLine,
  dividendsDropSummary,
  dividendsQuestion,
  dividendsRefusal,
  dividendsSavedMessage,
  readsAsDividend,
} from "./dividends.ts";

const ABC: DividendLine = { holding_name: "ABC", units: 40, per_share: 0.25, gross: 10, tax: 3, fees: 0, net: 7, pay_date: "2026-11-12" };
const XYZ: DividendLine = { holding_name: "XYZ", units: 10, per_share: 0.5, gross: 5, tax: 1.5, fees: 0, net: 3.5, pay_date: "2026-11-12" };

// The revamp, phase 8c (review T12): the lines in the one format, and the
// question in a few words above its buttons.
Deno.test("question: each line's sum, withholding and net, then the question", () => {
  assertEquals(
    dividendsQuestion("Dollar funds", "USD", [ABC, XYZ], null),
    [
      "Dividends due in Dollar funds today",
      "ABC · 40 × USD 0.25 = USD 10 · USD 3 withheld · USD 7",
      "XYZ · 10 × USD 0.50 = USD 5 · USD 1.50 withheld · USD 3.50",
      "Arrived? USD 10.50 in all.",
    ].join("\n"),
  );
});

Deno.test("question: fees come before the net; one dividend reads in the singular", () => {
  assertEquals(
    dividendsQuestion("Dollar funds", "USD", [{ ...ABC, fees: 0.2, net: 6.8 }], null),
    [
      "Dividend due in Dollar funds today",
      "ABC · 40 × USD 0.25 = USD 10 · USD 3 withheld · USD 0.20 fees · USD 6.80",
      "Arrived? USD 6.80 in all.",
    ].join("\n"),
  );
});

Deno.test("question: a small amount per share keeps its digits, and nothing withheld shows no net twice", () => {
  const line = dividendsQuestion("Rupee funds", "INR", [{ ...ABC, units: 100, per_share: 0.0625, gross: 6.25, tax: 0, net: 6.25 }], null)
    .split("\n")[1];
  assertEquals(line, "ABC · 100 × INR 0.0625 = INR 6.25");
});

Deno.test("question: when the fund was confirmed on or after the pay date, it asks whether it was already in", () => {
  const lines = dividendsQuestion("Dollar funds", "USD", [ABC, XYZ], { confirmedOn: "2026-11-12" }, "2026-11-13").split("\n");
  assertEquals(lines[lines.length - 1], "Dollar funds was confirmed 12 Nov. Already in that balance? USD 10.50 in all.");
});

Deno.test("saved: what moved the fund, each line, and a repeat", () => {
  const result = { lines: [{ ...ABC, moved: 7 }, { ...XYZ, moved: 3.5 }], total: 10.5 };
  assertEquals(
    dividendsSavedMessage("Dollar funds", "USD", result, false),
    [
      "✓ USD 10.50 into Dollar funds",
      "ABC · 40 × USD 0.25 = USD 10 · USD 3 withheld · USD 7",
      "XYZ · 10 × USD 0.50 = USD 5 · USD 1.50 withheld · USD 3.50",
    ].join("\n"),
  );
  assertEquals(dividendsSavedMessage("Dollar funds", "USD", result, true).split("\n")[0], "Already recorded · USD 10.50 into Dollar funds");
});

Deno.test("saved: already in the fund's balance moves nothing; part of it, part", () => {
  const none = { lines: [{ ...ABC, moved: 0 }, { ...XYZ, moved: 0 }], total: 10.5 };
  assertEquals(dividendsSavedMessage("Dollar funds", "USD", none, false).split("\n")[0], "✓ USD 10.50 · already in Dollar funds' balance");
  assertEquals(dividendsSavedMessage("Dollar funds", "USD", none, true).split("\n")[0], "Already recorded · USD 10.50 · already in Dollar funds' balance");
  assertEquals(dividendsSavedMessage("Rupee fund", "INR", none, false).split("\n")[0], "✓ INR 10.50 · already in Rupee fund's balance");
  const part = { lines: [{ ...ABC, moved: 7 }, { ...XYZ, moved: 0 }], total: 10.5 };
  assertEquals(dividendsSavedMessage("Dollar funds", "USD", part, false).split("\n")[0], "✓ USD 10.50 · USD 7 into Dollar funds, the rest already in its balance");
});

Deno.test("saved: figures may arrive as strings from the database", () => {
  const line = { holding_name: "ABC", units: "40", per_share: "0.25", gross: "10.0000", tax: "3.0000", fees: "0", net: "7.0000", pay_date: "2026-11-12", moved: "7" };
  // deno-lint-ignore no-explicit-any
  const message = dividendsSavedMessage("Dollar funds", "USD", { lines: [line as any], total: "7.0000" as any }, false);
  assertEquals(message, "✓ USD 7 into Dollar funds\nABC · 40 × USD 0.25 = USD 10 · USD 3 withheld · USD 7");
});

Deno.test("dropped: how many, into which fund, for how much", () => {
  assertEquals(dividendsDropSummary({ fund_name: "Dollar funds", currency: "USD", total: 10.5, lines: [ABC, XYZ] }), "2 dividends into Dollar funds · USD 10.50");
  assertEquals(dividendsDropSummary({ fund_name: "Dollar funds", currency: "USD", total: 7, lines: [ABC] }), "1 dividend into Dollar funds · USD 7");
});

Deno.test("refused: a reason the member can act on", () => {
  assertEquals(dividendsRefusal("fund_archived"), "That fund is archived, so nothing was recorded. Record them in the app if they arrived elsewhere.");
  assertEquals(dividendsRefusal("something_new"), "I couldn't record them (something_new). Nothing was saved; you can record them in the app.");
});

Deno.test("reads as a dividend: the word, or div on its own", () => {
  for (const text of ["ABC dividend credit", "DIVIDEND", "div credit ABC", "Dividends from XYZ"]) assertEquals(readsAsDividend(text), true, text);
  for (const text of ["salary", "divine pizza", "individual", "", null, undefined]) assertEquals(readsAsDividend(text), false, String(text));
});

Deno.test("the guard's reply", () => {
  assertEquals(
    DIVIDEND_GUARD_REPLY,
    "That looks like a dividend, so I haven't logged it as income: Rokda records dividends from US and Indian shares on the holding that paid them, under Wealth → Investments. If it came from anything else, add it as income in the app.",
  );
});
