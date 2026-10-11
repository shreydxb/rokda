// How old a fetched price is: the provider's quote time, never the fetch time.

import { assertEquals } from "jsr:@std/assert@1";
import { navQuoteTime, quoteTime } from "./quoteTime.ts";

const NOW = Date.parse("2026-10-11T20:00:00Z");

Deno.test("a quote time in seconds becomes an ISO timestamp", () => {
  assertEquals(quoteTime(Date.parse("2026-10-09T10:00:00Z") / 1000, NOW), "2026-10-09T10:00:00.000Z");
  assertEquals(quoteTime(String(Date.parse("2026-10-09T10:00:00Z") / 1000), NOW), "2026-10-09T10:00:00.000Z");
});

Deno.test("a missing, malformed or future quote time is unknown, not now", () => {
  for (const bad of [undefined, null, "", "abc", 0, -5, Number.NaN, Infinity, { t: 1 }]) {
    assertEquals(quoteTime(bad, NOW), null, String(bad));
  }
  // More than an hour ahead is a clock or unit error (milliseconds sent as seconds).
  assertEquals(quoteTime(NOW / 1000 + 7200, NOW), null);
  assertEquals(quoteTime(NOW, NOW), null);
  // Within the hour is a clock difference, and allowed.
  assertEquals(quoteTime(NOW / 1000 + 600, NOW), new Date(NOW + 600_000).toISOString());
});

Deno.test("a fund NAV is dated its Indian trading day's close", () => {
  assertEquals(navQuoteTime("09-10-2026", NOW), "2026-10-09T10:00:00.000Z");
  for (const bad of [undefined, null, "", "2026-10-09", "9-10-2026", "31-02-2026x", "12-10-2026"]) {
    assertEquals(navQuoteTime(bad, NOW), null, String(bad));
  }
});
