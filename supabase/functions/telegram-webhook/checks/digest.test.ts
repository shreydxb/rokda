// The morning digest (checks/digest.ts): one message per person for the
// reminders that need no answer. Pure apart from the sender, which is passed in.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Digest, type Delivery, DIGEST_ORDER } from "./digest.ts";

function fakeSender(outcomes: Record<number, Delivery> = {}) {
  const sent: Array<{ chatId: number; text: string; markup?: unknown }> = [];
  const send = (chatId: number, text: string, markup?: unknown): Promise<Delivery> => {
    sent.push({ chatId, text, ...(markup ? { markup } : {}) });
    return Promise.resolve(outcomes[chatId] ?? "sent");
  };
  return { sent, send };
}

Deno.test("a person's reminders go out as one message, in groups: what needs doing today, then how the month is going", async () => {
  const digest = new Digest();
  const recorded: string[] = [];
  digest.line([1], "Groceries · 80% of budget · AED 1,600 of AED 2,000", DIGEST_ORDER.budget, () => void recorded.push("budget"));
  digest.line([1], "Cash cover · AED 5,000 liquid · AED 7,000 due in 7 days · short by AED 2,000", DIGEST_ORDER.cashCover, () => void recorded.push("cash"));
  digest.line([1], "Rent · Late · was due 3 Oct · AED 6,500", DIGEST_ORDER.billNotSeen, () => void recorded.push("rent"));
  const { sent, send } = fakeSender();
  const result = await digest.send(send);
  assertEquals(sent.length, 1);
  assertEquals(sent[0].text, "Today\nRent · Late · was due 3 Oct · AED 6,500\nCash cover · AED 5,000 liquid · AED 7,000 due in 7 days · short by AED 2,000\nThis month\nGroceries · 80% of budget · AED 1,600 of AED 2,000");
  assertEquals(recorded.sort(), ["budget", "cash", "rent"]);
  assertEquals(result, { chats: 1, recorded: 3 });
});

Deno.test("Open Overview goes under each person's message, on its last part", async () => {
  const digest = new Digest();
  const open = { inline_keyboard: [[{ text: "Open Overview", url: "https://app.example.test/" }]] };
  digest.head([1], "R".repeat(3990), 10, () => {});
  digest.line([1], "Rent · Late · was due 3 Oct · AED 6,500", DIGEST_ORDER.billNotSeen, () => {});
  digest.line([2], "Rent · Late · was due 3 Oct · AED 6,500", DIGEST_ORDER.billNotSeen, () => {});
  const { sent, send } = fakeSender();
  await digest.send(send, open);
  assertEquals(sent.map((s) => [s.chatId, s.markup ?? null]), [[1, null], [1, open], [2, open]]);
});

Deno.test("each person gets only the lines meant for them", async () => {
  const digest = new Digest();
  digest.line([1], "Your card is due.", DIGEST_ORDER.cardDueSoon, () => {});
  digest.line([1, 2], "Cash looks short this week.", DIGEST_ORDER.cashCover, () => {});
  const { sent, send } = fakeSender();
  await digest.send(send);
  const byChat = Object.fromEntries(sent.map((s) => [s.chatId, s.text]));
  assert(byChat[1].includes("Your card is due.") && byChat[1].includes("Cash looks short"), byChat[1]);
  assertEquals(byChat[2], "Today\nCash looks short this week.");
});

Deno.test("on a brief's morning the lines go at the end of it", async () => {
  const digest = new Digest();
  digest.head([1], "This week:\nSpent AED 100.00.", 10, () => {});
  digest.line([1], "Your card is due.", DIGEST_ORDER.cardDueSoon, () => {});
  const { sent, send } = fakeSender();
  await digest.send(send);
  assertEquals(sent[0].text, "This week:\nSpent AED 100.00.\n\nToday\nYour card is due.");
});

Deno.test("two heads for one person are one message, in order", async () => {
  const digest = new Digest();
  digest.head([1], "Balances, please.", 20, () => {});
  digest.head([1], "Last month: AED 900.00 spent.", 10, () => {});
  const { sent, send } = fakeSender();
  await digest.send(send);
  assertEquals(sent.length, 1);
  assertEquals(sent[0].text, "Last month: AED 900.00 spent.\n\nBalances, please.");
});

Deno.test("a line is recorded only once everyone it was for received it; refused for good counts as done", async () => {
  const digest = new Digest();
  const recorded: string[] = [];
  digest.line([1, 2], "Shared bill late.", 10, () => void recorded.push("shared"));
  digest.line([1], "Mine.", 20, () => void recorded.push("mine"));
  digest.line([3], "Blocked member's.", 20, () => void recorded.push("blocked"));
  const { send } = fakeSender({ 2: "retry", 3: "final" });
  const result = await digest.send(send);
  assertEquals(recorded.sort(), ["blocked", "mine"]);
  assertEquals(result.recorded, 2);
});

Deno.test("one record failing does not stop the others", async () => {
  const digest = new Digest();
  const recorded: string[] = [];
  digest.line([1], "A.", 10, () => Promise.reject(new Error("write failed")));
  digest.line([1], "B.", 20, () => void recorded.push("b"));
  const { send } = fakeSender();
  await digest.send(send);
  assertEquals(recorded, ["b"]);
});

Deno.test("nothing to say sends nothing", async () => {
  const { sent, send } = fakeSender();
  assertEquals(await new Digest().send(send), { chats: 0, recorded: 0 });
  assertEquals(sent.length, 0);
});

Deno.test("the balance check-in is recorded for the household only once every member got theirs", async () => {
  const digest = new Digest();
  const recorded: string[] = [];
  digest.head([1], "Last month: AED 900.00 spent.", 10, () => {});
  digest.head([1], "Balances for your accounts, please.", 20, () => {});
  digest.head([2], "Balances for yours, please.", 20, () => {});
  digest.afterAll([1, 2], () => void recorded.push("checkin"));
  const first = fakeSender({ 2: "retry" });
  await digest.send(first.send);
  assertEquals(recorded, []);
  assertEquals(first.sent.find((s) => s.chatId === 1)?.text, "Last month: AED 900.00 spent.\n\nBalances for your accounts, please.");
  await digest.send(fakeSender().send);
  assertEquals(recorded, ["checkin"]);
});

// The fresh review: a message over Telegram's 4,096 characters is refused
// for good (a 400), which counted as delivered, so every line in it was
// recorded without reaching anyone.
Deno.test("a long morning is sent in parts under Telegram's limit, never cut inside a line", async () => {
  const digest = new Digest();
  digest.head([1], "R".repeat(3000), 10, () => {});
  for (let i = 0; i < 40; i++) digest.line([1], `Reminder ${i} ${"x".repeat(80)}.`, 40, () => {});
  const { sent, send } = fakeSender();
  const result = await digest.send(send);
  assert(sent.length > 1, "not split");
  for (const s of sent) assert(s.text.length <= 4000, `part of ${s.text.length}`);
  const all = sent.map((s) => s.text).join("\n");
  for (let i = 0; i < 40; i++) assert(all.includes(`Reminder ${i} `), `line ${i} lost`);
  assertEquals(result.recorded, 41);
});

Deno.test("a long morning with one part not delivered records none of it", async () => {
  const digest = new Digest();
  const recorded: string[] = [];
  digest.head([1], "R".repeat(3990), 10, () => void recorded.push("head"));
  digest.line([1], "A late bill.", 10, () => void recorded.push("line"));
  let n = 0;
  await digest.send((_chat, _text) => Promise.resolve(++n === 2 ? "retry" : "sent"));
  assertEquals(recorded, []);
});

Deno.test("a record the database refuses is not counted as recorded", async () => {
  const digest = new Digest();
  digest.line([1], "A.", 10, () => Promise.resolve({ error: { message: "refused" } }));
  digest.line([1], "B.", 20, () => Promise.resolve({ error: null }));
  const result = await digest.send(fakeSender().send);
  assertEquals(result.recorded, 1);
});

Deno.test("the weekly brief comes before the monthly review on a Monday the 1st", async () => {
  const digest = new Digest();
  digest.head([1], "Last month.", DIGEST_ORDER.monthlyReview, () => {});
  digest.head([1], "This week.", DIGEST_ORDER.weeklyBrief, () => {});
  assertEquals(digest.messageFor(1), "This week.\n\nLast month.");
});
