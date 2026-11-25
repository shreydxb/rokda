// Commands and linking (the revamp, phase 8d; the UI review's T19 and T20):
// the reply when a Telegram account is linked, /help (and /start once
// linked), /inbox, /undo, and the command menu the setup registers. The fake
// backend is testing/harness.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { linkTokenDigest } from "../_shared/applib/telegramLink.js";
import { backend, CARD, capturedIntake, dubaiToday, freshTest, handler, HOUSEHOLD, lastReply, MEMBER, PARTNER, reactionUpdate, replyUpdate, type Row, SECRET, tapUpdate, TELEGRAM_USER, textUpdate } from "./testing/harness.ts";
// After the harness, which sets the environment env.ts reads.
import { HELP_TEXT } from "./commands.ts";
import { LIST_NO_UNDO } from "./choices.ts";

type Button = { text: string; url?: string; callback_data?: string };

function buttonsOf(body: Row | undefined): Button[] {
  return (((body?.reply_markup as Row | undefined)?.inline_keyboard ?? []) as Button[][]).flat();
}

const GROCERIES = "c3000000-0000-4000-8000-0000000000f2";
const NOTHING = "No expense recorded in the last ten minutes to undo.";

// An expense read in full, shown with Record, as expenseButtons.test.ts
// captures one; the message's id, as the fake Telegram numbers them.
async function capture(update: number, merchant = "Corner Bakery", amount = 30): Promise<{ id: number; text: string; buttons: Button[] }> {
  backend.now = Date.now();
  if (!backend.tables.accounts.length) {
    backend.tables.accounts.push({ ...CARD, household_id: HOUSEHOLD, owner_member_id: MEMBER, is_shared: false });
    backend.tables.categories.push({ id: GROCERIES, household_id: HOUSEHOLD, name: "Groceries", kind: "expense", parent_id: null, archived: false, is_savings: false });
  }
  backend.parse = [{ merchant, amount, currency: "AED", occurred_at: dubaiToday(), date_stated: true, source: "bank_sms", category: "Groceries", card_last4: "0004", account_hint: null, confidence: 0.95, kind: "expense" }];
  await handler(textUpdate(update, `pasted sms ${update}`));
  const body = backend.telegramSent.at(-1)!.body;
  return { id: 1000 + backend.telegramSent.length, text: String(body.text), buttons: buttonsOf(body) };
}

async function record(update: number, prompt: { id: number; buttons: Button[] }): Promise<void> {
  await handler(tapUpdate(update, prompt.id, prompt.buttons.find((b) => b.text === "Record")!.callback_data!));
}

function edits(messageId: number): Row[] {
  return backend.telegramCalls.filter((c) => c.method === "editMessageText" && c.body.message_id === messageId).map((c) => c.body);
}

freshTest("linking says who the account is linked as, what to send, and where help is", async () => {
  const CODE = "0f8cb1e4a2d94f6b8c1e2a3b4c5d6e7f";
  Object.assign(backend.tables.household_members[0], {
    display_name: "Alex", telegram_user_id: null, telegram_link_code: await linkTokenDigest(CODE), telegram_link_code_expires_at: "2099-01-01T00:00:00Z",
  });
  await handler(textUpdate(9901, CODE));
  assertEquals(lastReply(), 'Linked as Alex. Send a receipt, "42 groceries", or a question. /help for more.');
});

freshTest("/help says what the bot does in a few lines, with the commands", async () => {
  await handler(textUpdate(9902, "/help"));
  assertEquals(lastReply(), HELP_TEXT);
  for (const command of ["/brief", "/inbox", "/undo"]) assert(HELP_TEXT.includes(command), command);
  assert(HELP_TEXT.split("\n").length <= 9, HELP_TEXT);
  assertEquals(backend.aiCalls, 0, "/help went to the AI");
  assertEquals(backend.tables.intake.length, 0, "/help was captured as an expense");
});

freshTest("/start from an account already linked is answered with help, not read as a message", async () => {
  await handler(textUpdate(9903, "/start"));
  assertEquals(lastReply(), HELP_TEXT);
  assertEquals(backend.aiCalls, 0);
});

freshTest("/inbox says how many wait, with Open Inbox; an empty one says it is clear", async () => {
  await handler(textUpdate(9904, "/inbox"));
  assertEquals(lastReply(), "The Inbox is clear.");
  const pending = (id: string) => ({ id, household_id: HOUSEHOLD, member_id: MEMBER, status: "pending", created_at: new Date().toISOString() });
  backend.tables.intake.push(pending("a9900000-0000-4000-8000-000000000001"), pending("a9900000-0000-4000-8000-000000000002"), { ...pending("a9900000-0000-4000-8000-000000000003"), status: "approved" });
  await handler(textUpdate(9905, "/inbox"));
  assertEquals(lastReply(), "2 in the Inbox");
  assertEquals(buttonsOf(backend.telegramSent.at(-1)!.body), [{ text: "Open Inbox", url: "https://app.example.test/inbox" }]);
});

freshTest("a command meant for this bot by name works too", async () => {
  await handler(textUpdate(9906, "/help@RokdaBot"));
  assertEquals(lastReply(), HELP_TEXT);
});

freshTest("the setup registers the command menu", async () => {
  const res = await handler(new Request("http://edge.test/telegram-webhook?setup=1", { method: "GET", headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET } }));
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const menu = backend.telegramCalls.find((c) => c.method === "setMyCommands")?.body.commands as Array<{ command: string; description: string }> | undefined;
  assertEquals(menu?.map((c) => c.command), ["help", "brief", "inbox", "undo"]);
  for (const c of menu ?? []) assert(c.description.length > 0 && c.description.length <= 40, c.description);
  // In private chats only: the bot answers nothing else.
  assertEquals(backend.telegramCalls.find((c) => c.method === "setMyCommands")?.body.scope, { type: "all_private_chats" });
});

freshTest("/undo takes back the latest Record, and the entry comes back with its buttons", async () => {
  const prompt = await capture(9910);
  await record(9911, prompt);
  const recordedAs = backend.tables.transactions[0].id;
  const aiCalls = backend.aiCalls;
  await handler(textUpdate(9912, "/undo"));
  assertEquals(backend.rpcCalls.filter((c) => c.fn === "undo_intake_approval").at(-1)?.args, { p_intake_id: capturedIntake()[0].id, p_member_id: MEMBER, p_transaction_id: recordedAs });
  assertEquals(capturedIntake()[0].status, "pending");
  assertEquals(backend.tables.transactions.length, 0);
  // The tick line above no longer says recorded, nor offers Undo.
  const above = edits(prompt.id).at(-1)!;
  assertEquals(above.text, "Undone · Corner Bakery · AED 30 · Groceries");
  assertEquals(buttonsOf(above).length, 0);
  // The entry again, as it was before Record, under the /undo, tied to it,
  // saying what happened.
  const sent = backend.telegramSent.at(-1)!.body;
  assertEquals(sent.text, `${prompt.text}\nUndone.`);
  assertEquals(buttonsOf(sent).map((b) => b.text), ["Record", "Category", "Account", "Discard"]);
  assertEquals(capturedIntake()[0].confirm_message_id, 1000 + backend.telegramSent.length);
  assertEquals(backend.aiCalls, aiCalls, "/undo went to the AI");
});

freshTest("/undo again takes back the Record before", async () => {
  await record(9921, await capture(9920, "Corner Bakery", 30));
  await record(9923, await capture(9922, "Fruit Stall", 12));
  await handler(textUpdate(9924, "/undo"));
  assertEquals(capturedIntake().map((r) => r.status), ["approved", "pending"]);
  await handler(textUpdate(9925, "/undo"));
  assertEquals(capturedIntake().map((r) => r.status), ["pending", "pending"]);
});

freshTest("/undo with no Record in the last ten minutes says so, and changes nothing", async () => {
  await handler(textUpdate(9930, "/undo"));
  assertEquals(lastReply(), NOTHING);
  // Recorded eleven minutes ago: too late, so not looked for.
  await record(9932, await capture(9931));
  backend.tables.bot_recordings[0].recorded_at = new Date(Date.now() - 11 * 60_000).toISOString();
  await handler(textUpdate(9933, "/undo"));
  assertEquals(lastReply(), NOTHING);
  assertEquals(capturedIntake()[0].status, "approved");
  assertEquals(backend.rpcCalls.filter((c) => c.fn === "undo_intake_approval").length, 0);
});

freshTest("/undo never takes back an approval made in the app", async () => {
  await capture(9940);
  // Approved in the Inbox: the bot recorded nothing, so there is nothing of its own to take back.
  Object.assign(capturedIntake()[0], { status: "approved", transaction_id: "a9900000-0000-4000-8000-0000000000aa" });
  await handler(textUpdate(9941, "/undo"));
  assertEquals(lastReply(), NOTHING);
  assertEquals(capturedIntake()[0].status, "approved");
});

freshTest("/undo after a change in the app leaves it recorded, says why, and the line above loses Undo", async () => {
  const prompt = await capture(9950);
  await record(9951, prompt);
  backend.undoOutcome = "changed";
  await handler(textUpdate(9952, "/undo"));
  assertEquals(lastReply(), "It was changed in the app, so it stays. Change it there.");
  assertEquals(capturedIntake()[0].status, "approved");
  const above = edits(prompt.id).at(-1)!;
  assertEquals(above.text, "✓ Corner Bakery · AED 30 · Groceries");
  assertEquals(buttonsOf(above).length, 0);
});

freshTest("an unknown command is answered with help, not read as an expense", async () => {
  await handler(textUpdate(9960, "/settings"));
  assertEquals(lastReply(), HELP_TEXT);
  assertEquals(backend.aiCalls, 0);
  assertEquals(backend.tables.intake.length, 0);
});

freshTest("/undo after a typed yes turns the tick reply, and a yes or 👍 on it records nothing", async () => {
  const prompt = await capture(9970);
  await handler(replyUpdate(9971, "yes", prompt.id));
  const tick = 1000 + backend.telegramSent.length;
  await handler(textUpdate(9972, "/undo"));
  assertEquals(capturedIntake()[0].status, "pending");
  assertEquals(edits(tick).at(-1)?.text, "Undone · Corner Bakery · AED 30 · Groceries");
  assertEquals(buttonsOf(edits(tick).at(-1)).length, 0);
  assertEquals(capturedIntake()[0].confirm_message_id, 1000 + backend.telegramSent.length);
  await handler(replyUpdate(9973, "yes", tick));
  await handler(reactionUpdate(9974, tick, "👍"));
  assertEquals(capturedIntake()[0].status, "pending");
});

freshTest("/undo sent as a reply takes back the Record that message shows", async () => {
  const first = await capture(9975, "Corner Bakery", 30);
  await record(9976, first);
  await record(9978, await capture(9977, "Fruit Stall", 12));
  await handler(replyUpdate(9979, "/undo", first.id));
  assertEquals(capturedIntake().map((r) => r.status), ["pending", "approved"]);
  // A message with no Record of the bot's under it is said so, and nothing goes back.
  await handler(replyUpdate(9980, "/undo", 4242));
  assertEquals(lastReply(), "That message has no expense to undo.");
  assertEquals(capturedIntake().map((r) => r.status), ["pending", "approved"]);
});

freshTest("/undo never takes back the other member's Record", async () => {
  backend.now = Date.now();
  backend.tables.intake.push({ id: "a9900000-0000-4000-8000-0000000000b1", household_id: HOUSEHOLD, member_id: PARTNER, status: "approved", transaction_id: "a9900000-0000-4000-8000-0000000000b2", created_at: new Date().toISOString() });
  backend.tables.bot_recordings.push({ household_id: HOUSEHOLD, intake_id: "a9900000-0000-4000-8000-0000000000b1", member_id: PARTNER, transaction_id: "a9900000-0000-4000-8000-0000000000b2", recorded_at: new Date().toISOString() });
  await handler(textUpdate(9981, "/undo"));
  assertEquals(lastReply(), NOTHING);
  assertEquals(backend.tables.intake[0].status, "approved");
  assertEquals(backend.rpcCalls.filter((c) => c.fn === "undo_intake_approval").length, 0);
});

freshTest("/undo too late says so and leaves it recorded", async () => {
  await record(9983, await capture(9982));
  backend.undoOutcome = "too_late";
  await handler(textUpdate(9984, "/undo"));
  assertEquals(lastReply(), "Undo lasts ten minutes. Change it in the app.");
  assertEquals(capturedIntake()[0].status, "approved");
});

freshTest("a Record whose note fails still records, with its Undo button; /undo then finds nothing", async () => {
  const prompt = await capture(9985);
  backend.faults.failInserts = ["bot_recordings"];
  await record(9986, prompt);
  assertEquals(capturedIntake()[0].status, "approved");
  assertEquals(buttonsOf(edits(prompt.id).at(-1)).map((b) => b.text), ["Undo"]);
  await handler(textUpdate(9987, "/undo"));
  assertEquals(lastReply(), NOTHING);
  assertEquals(capturedIntake()[0].status, "approved");
});

freshTest("an /undo Telegram delivers again takes back the same Record, never the one before", async () => {
  await record(9989, await capture(9988, "Corner Bakery", 30));
  await record(9991, await capture(9990, "Fruit Stall", 12));
  await handler(textUpdate(9992, "/undo"));
  assertEquals(capturedIntake().map((r) => r.status), ["approved", "pending"]);
  // The first delivery died after the undo: Telegram sends it again.
  backend.log.get(9992)!.status = "failed";
  await handler(textUpdate(9992, "/undo"));
  assertEquals(capturedIntake().map((r) => r.status), ["approved", "pending"]);
  assertEquals(backend.rpcCalls.filter((c) => c.fn === "undo_intake_approval").length, 1);
});

// A list's entries are expenses too, with no Undo: /undo stops at them rather
// than reaching past to the expense before (the revamp review).
freshTest("/undo after a list's Record all says a list has no undo, and never reaches past it", async () => {
  await record(9994, await capture(9993, "Corner Bakery", 30));
  const sms = (merchant: string, amount: number) => ({ merchant, amount, currency: "AED", occurred_at: dubaiToday(), date_stated: true, source: "bank_sms", category: "Groceries", card_last4: "0004", account_hint: null, confidence: 0.95, kind: "expense" });
  backend.parse = [sms("Fruit Stall", 12), sms("News Stand", 5)];
  await handler(textUpdate(9995, "pasted two"));
  const at = backend.telegramSent.findLastIndex((m) => buttonsOf(m.body).some((b) => b.text === "Record all"));
  assert(at >= 0, "no list was sent");
  const list = { id: 1001 + at, text: String(backend.telegramSent[at].body.text), buttons: buttonsOf(backend.telegramSent[at].body) };
  // A list's tap is checked against the list's text, which Telegram sends with it.
  await handler(tapUpdate(9996, list.id, list.buttons.find((b) => b.text === "Record all")!.callback_data!, TELEGRAM_USER, list.text));
  assertEquals(capturedIntake().map((r) => r.status), ["approved", "approved", "approved"]);
  await handler(textUpdate(9997, "/undo"));
  assertEquals(lastReply(), LIST_NO_UNDO);
  // Sent as a reply to the list, the same.
  await handler(replyUpdate(9998, "/undo", list.id));
  assertEquals(lastReply(), LIST_NO_UNDO);
  assertEquals(capturedIntake().map((r) => r.status), ["approved", "approved", "approved"]);
  assertEquals(backend.rpcCalls.filter((c) => c.fn === "undo_intake_approval").length, 0);
});
