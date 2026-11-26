// Reading a reply to a batch list, and writing the list (batch.ts). Pure: no handler, no backend.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { batchListMessage, chooseKeyboard, decodeListTap, encodeListTap, LIST_QUESTION_ALL, LIST_QUESTION_SOME, listKeyboard, listNumbers, parseBatchReply, readBatchDate, renderList } from "./batch.ts";

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
  // Weeks ahead is a slip too, not last year: only a day in the last two months is read back a year.
  assertEquals(readBatchDate("15 Dec", "2026-11-13"), "future");
  assertEquals(readBatchDate("1 Sep", "2026-08-01"), "future");
  assertEquals(readBatchDate("29/2", "2026-10-09"), null);
  assertEquals(readBatchDate("someday", TODAY), null);
});

const LIST_TODAY = "2026-10-20";
const TAXI = { amount: 20, merchant: "City Taxi", account: "Bank card", category: "Transport", date: null, undated: true };
const SHOP = { amount: 45.5, merchant: "Corner Shop", account: "Bank card", category: "Groceries", date: null, undated: true };

Deno.test("the list names each entry in the one format, asks the day when the SMS gave none, and names what it left out", () => {
  const text = batchListMessage([TAXI, SHOP], { recorded: [{ merchant: "City Taxi", amount: 20 }], waiting: [{ merchant: "Pharmacy", reason: "needs a category" }], overCap: 0 }, LIST_TODAY);
  assertEquals(text.split("\n"), [
    "4 from that message",
    "1. City Taxi · AED 20 · Transport · Bank card",
    "2. Corner Shop · AED 45.50 · Groceries · Bank card",
    LIST_QUESTION_ALL,
    "Already recorded, left out · City Taxi · AED 20",
    "In the Inbox · Pharmacy · needs a category",
  ]);
  assertEquals(LIST_QUESTION_ALL, "No dates in the SMS: when were they paid?");
});

Deno.test("a dated list shows each entry's day and asks nothing; a mixed one marks the undated", () => {
  const dated = batchListMessage([{ ...TAXI, undated: false, date: "2026-10-03" }, { ...SHOP, undated: false, date: "2026-10-04" }], { recorded: [], waiting: [], overCap: 3 }, LIST_TODAY);
  assertEquals(dated.split("\n"), [
    "5 from that message",
    "1. City Taxi · AED 20 · Transport · Bank card · 3 Oct",
    "2. Corner Shop · AED 45.50 · Groceries · Bank card · 4 Oct",
    "In the Inbox · 3 more · a list takes 20",
  ]);
  const mixed = batchListMessage([{ ...TAXI, undated: false, date: "2026-10-03" }, SHOP], { recorded: [], waiting: [], overCap: 0 }, LIST_TODAY);
  assertEquals(mixed.split("\n").slice(2), ["2. Corner Shop · AED 45.50 · Groceries · Bank card · no date", LIST_QUESTION_SOME]);
  assertEquals(LIST_QUESTION_SOME, "Some have no date in the SMS: when were those paid?");
});

type Button = { text: string; callback_data: string };
const labels = (k: { inline_keyboard: Button[][] } | null) => (k?.inline_keyboard ?? []).flat().map((b) => b.text);

Deno.test("the list's buttons: Record all and Choose… when each entry has its day; Today, Yesterday and Other day when one has none", () => {
  assertEquals(labels(listKeyboard(false)), ["Record all", "Choose…"]);
  assertEquals(labels(listKeyboard(true)), ["Today", "Yesterday", "Other day", "Choose…"]);
  for (const b of listKeyboard(true).inline_keyboard.flat()) assert(b.callback_data.length <= 64);
});

Deno.test("a list button is read back as what it does, and anything else is not one", () => {
  assertEquals(decodeListTap(encodeListTap("a")), { op: "a", mask: 0 });
  assertEquals(decodeListTap(encodeListTap("t", 0b101)), { op: "t", mask: 5 });
  assertEquals(decodeListTap(encodeListTap("x", (1 << 20) - 1)), { op: "x", mask: (1 << 20) - 1 });
  for (const bad of ["", "L", "Lq", "La!", "Xa", "La" + "z".repeat(9)]) assertEquals(decodeListTap(bad), null, bad);
  assertEquals(listNumbers(0b1010), [2, 4]);
});

Deno.test("Choose… shows a button an entry, ticked when chosen, and offers what fits those chosen", () => {
  const entries = [{ n: 1, label: "City Taxi · AED 20", undated: true }, { n: 2, label: "Corner Shop · AED 45.50", undated: false }];
  assertEquals(labels(chooseKeyboard(entries, 0)), ["1. City Taxi · AED 20", "2. Corner Shop · AED 45.50", "Back"]);
  assertEquals(labels(chooseKeyboard(entries, 0b10)), ["1. City Taxi · AED 20", "✓ 2. Corner Shop · AED 45.50", "Record 1", "Discard 1", "Back"]);
  assertEquals(labels(chooseKeyboard(entries, 0b11)), ["✓ 1. City Taxi · AED 20", "✓ 2. Corner Shop · AED 45.50", "Today", "Yesterday", "Other day", "Discard 2", "Back"]);
  const tick = chooseKeyboard(entries, 0b10).inline_keyboard.flat()[0];
  assertEquals(decodeListTap(tick.callback_data), { op: "x", mask: 0b11 });
});

Deno.test("the list is shown again as its entries stand: recorded, cancelled, left in the Inbox, or still offered", () => {
  const text = batchListMessage([TAXI, SHOP, { ...SHOP, merchant: "Fresh Market", amount: 120 }, { ...TAXI, merchant: "Bakery", amount: 9 }], { recorded: [], waiting: [{ merchant: "Pharmacy", reason: "needs a category" }], overCap: 0 }, LIST_TODAY);
  const rows = [
    { status: "approved", undated: true },
    { status: "rejected", undated: true },
    { status: "pending", undated: true },
    { status: "pending", undated: true },
  ];
  const once = renderList(text, rows, new Map([[0, "recorded"], [1, "dropped"], [2, "changed"]]));
  assertEquals(once?.text.split("\n"), [
    "5 from that message",
    "✓ City Taxi · AED 20 · Transport · Bank card",
    "Cancelled · Corner Shop · AED 45.50 · Groceries · Bank card",
    "In the Inbox · Fresh Market · changed since",
    "4. Bakery · AED 9 · Transport · Bank card",
    LIST_QUESTION_ALL,
    "In the Inbox · Pharmacy · needs a category",
  ]);
  assertEquals([once?.offered, once?.undated], [[4], true]);
  // Shown again with nothing done: the same, and an entry settled in the app
  // since is said to be settled, never offered.
  const settled = renderList(once!.text, rows.map((r, i) => i === 3 ? { ...r, status: "approved" } : r), new Map());
  assertEquals(settled?.text.split("\n").slice(1, 5).at(-1), "Already recorded · Bakery");
  assertEquals([settled?.offered, settled?.text.includes(LIST_QUESTION_ALL)], [[], false]);
  // A list it cannot read is not redrawn.
  assertEquals(renderList("1 from that message", rows, new Map()), null);
});

Deno.test("the list repeats only what it showed: an entry renamed in the Inbox keeps the list's name, and one left there can still be cancelled", () => {
  const text = batchListMessage([TAXI, SHOP], { recorded: [], waiting: [], overCap: 0 }, LIST_TODAY);
  // Renamed in the Inbox since: the list still names it as it showed it.
  const rows = [{ status: "pending", undated: true }, { status: "pending", undated: true }];
  const changed = renderList(text, rows, new Map([[0, "changed"]]));
  assertEquals(changed?.text.split("\n")[1], "In the Inbox · City Taxi · changed since");
  const dropped = renderList(changed!.text, rows.map((r, i) => i === 0 ? { ...r, status: "rejected" } : r), new Map([[0, "dropped"]]));
  assertEquals(dropped?.text.split("\n")[1], "Cancelled · City Taxi");
});
