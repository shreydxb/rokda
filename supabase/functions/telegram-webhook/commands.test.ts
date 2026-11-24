// Commands and linking (the revamp, phase 8d; the UI review's T19 and T20):
// the reply when a Telegram account is linked, /help (and /start once
// linked), /inbox, /undo, and the command menu the setup registers. The fake
// backend is testing/harness.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { linkTokenDigest } from "../_shared/applib/telegramLink.js";
import { backend, CARD, capturedIntake, dubaiToday, freshTest, handler, HOUSEHOLD, lastReply, MEMBER, type Row, SECRET, tapUpdate, textUpdate } from "./testing/harness.ts";
// After the harness, which sets the environment env.ts reads.
import { HELP_TEXT } from "./commands.ts";

type Button = { text: string; url?: string; callback_data?: string };

function buttonsOf(body: Row | undefined): Button[] {
  return (((body?.reply_markup as Row | undefined)?.inline_keyboard ?? []) as Button[][]).flat();
}

const GROCERIES = "c3000000-0000-4000-8000-0000000000f2";

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
  // The entry again, as it was before Record, under the /undo, tied to it.
  const sent = backend.telegramSent.at(-1)!.body;
  assertEquals(sent.text, prompt.text);
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
  assertEquals(lastReply(), "Nothing to undo. Undo lasts ten minutes after Record.");
  // Recorded eleven minutes ago: too late, so not looked for.
  await record(9932, await capture(9931));
  backend.tables.bot_recordings[0].recorded_at = new Date(Date.now() - 11 * 60_000).toISOString();
  await handler(textUpdate(9933, "/undo"));
  assertEquals(lastReply(), "Nothing to undo. Undo lasts ten minutes after Record.");
  assertEquals(capturedIntake()[0].status, "approved");
  assertEquals(backend.rpcCalls.filter((c) => c.fn === "undo_intake_approval").length, 0);
});

freshTest("/undo never takes back an approval made in the app", async () => {
  await capture(9940);
  // Approved in the Inbox: the bot recorded nothing, so there is nothing of its own to take back.
  Object.assign(capturedIntake()[0], { status: "approved", transaction_id: "a9900000-0000-4000-8000-0000000000aa" });
  await handler(textUpdate(9941, "/undo"));
  assertEquals(lastReply(), "Nothing to undo. Undo lasts ten minutes after Record.");
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
