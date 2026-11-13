// Reading a reply to a batch list, and writing the list (batch.ts). Pure: no handler, no backend.
import { assertEquals } from "jsr:@std/assert@1";
import { batchListMessage, parseBatchReply, readBatchDate } from "./batch.ts";

const TODAY = "2026-10-09";

Deno.test("a reply naming all, some, or one to drop is read with its date", () => {
  assertEquals(parseBatchReply("all on 2 Oct", TODAY), { kind: "all", date: "2026-10-02" });
  assertEquals(parseBatchReply("All", TODAY), { kind: "all", date: null });
  assertEquals(parseBatchReply("1-3, 5 on 2/10", TODAY), { kind: "some", numbers: [1, 2, 3, 5], date: "2026-10-02" });
  assertEquals(parseBatchReply("5 3 3", TODAY), { kind: "some", numbers: [3, 5], date: null });
  assertEquals(parseBatchReply("drop 4", TODAY), { kind: "drop", numbers: [4] });
  assertEquals(parseBatchReply("drop 2, 4", TODAY), { kind: "drop", numbers: [2, 4] });
  assertEquals(parseBatchReply("all today", TODAY), { kind: "all", date: "2026-10-09" });
  assertEquals(parseBatchReply("all yesterday", TODAY), { kind: "all", date: "2026-10-08" });
  assertEquals(parseBatchReply("all on 2 October.", TODAY), { kind: "all", date: "2026-10-02" });
});

Deno.test("a future day, a day that does not exist, or drop with no number is refused", () => {
  assertEquals(parseBatchReply("all on 20 Oct", TODAY)?.kind, "invalid");
  assertEquals(parseBatchReply("all on 31 Sep", TODAY)?.kind, "invalid");
  assertEquals(parseBatchReply("drop", TODAY)?.kind, "invalid");
  assertEquals(parseBatchReply("1-3 on someday", TODAY)?.kind, "invalid");
  assertEquals(parseBatchReply("3-1", TODAY)?.kind, "invalid");
});

Deno.test("an ordinary message is not a batch command", () => {
  assertEquals(parseBatchReply("spent 40 at cafe", TODAY), null);
  assertEquals(parseBatchReply("yes", TODAY), null);
  assertEquals(parseBatchReply("40 coffee", TODAY), null);
  assertEquals(parseBatchReply("all good thanks", TODAY), null);
});

Deno.test("a day and month is the latest such day not after today", () => {
  assertEquals(readBatchDate("28 Dec", "2027-01-05"), "2026-12-28");
  assertEquals(readBatchDate("5 jan", "2027-01-05"), "2027-01-05");
  assertEquals(readBatchDate("20 Oct", TODAY), "future");
  assertEquals(readBatchDate("29/2", "2026-10-09"), null);
  assertEquals(readBatchDate("someday", TODAY), null);
});

const TAXI = { amount: 20, merchant: "City Taxi", account: "Bank card", category: "Transport", undated: true };
const SHOP = { amount: 45.5, merchant: "Corner Shop", account: "Bank card", category: "Groceries", undated: true };

Deno.test("the list numbers each entry, asks for the date, and names what it left out", () => {
  const text = batchListMessage([TAXI, SHOP], { recorded: [{ merchant: "City Taxi", amount: 20 }], waiting: [{ merchant: "Pharmacy", reason: "no category" }], overCap: 0 });
  assertEquals(text.split("\n"), [
    "Got 4 from that message. Reply to this to record them:",
    "1. AED 20.00 · City Taxi · Bank card · Transport",
    "2. AED 45.50 · Corner Shop · Bank card · Groceries",
    'No date in the SMS: say the day they were paid, like "all on 2 Oct", or "1-2 on 2 Oct" for some. "drop 2" sets one aside.',
    "1 more is already recorded (City Taxi, AED 20.00), left out.",
    "1 needs a look in the Inbox (Pharmacy: no category).",
  ]);
});

Deno.test("a list of dated entries asks only for all, and marks an undated one in a mixed list", () => {
  const dated = batchListMessage([{ ...TAXI, undated: false }, { ...SHOP, undated: false }], { recorded: [], waiting: [], overCap: 3 });
  assertEquals(dated.split("\n").slice(3), [
    'Reply "all" to record them, or "1-2" for some. "drop 2" sets one aside.',
    "3 more wait in the Inbox (a list takes 20 at most).",
  ]);
  const mixed = batchListMessage([{ ...TAXI, undated: false }, SHOP], { recorded: [], waiting: [], overCap: 0 });
  assertEquals(mixed.split("\n")[2], "2. AED 45.50 · Corner Shop · Bank card · Groceries · no date");
  assertEquals(mixed.split("\n")[3].startsWith("Some have no date in the SMS: say the day they were paid"), true);
});
