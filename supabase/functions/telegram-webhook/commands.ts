// The bot's commands (the revamp, phase 8d; the UI review's T20): /help says
// what the bot does in a few lines, /brief the day in short, /inbox how many
// entries wait there, with Open Inbox, and /undo takes back the expense the
// member last recorded with Record (or the one a reply points at), within ten
// minutes. A transfer, a goal contribution or a list's Record all is not one:
// those have no Undo, and /undo says "expense" so as not to promise it. /start
// from an account already linked, and a command the bot does not know, are
// answered with help, never read as an expense or sent to the AI. The setup
// registers the same list as Telegram's command menu (COMMANDS), so the menu
// and /help never disagree.
import { supabase } from "./env.ts";
import { inboxKeyboard, undoLatest } from "./choices.ts";
import { buildBriefMessage } from "./tools.ts";
import { reply } from "./transport.ts";

// What the bot does, in a few lines: the failures' explanations live here
// (the design note's T21 and T22), and so does the statement routine the
// reminder no longer spells out (decision 5).
export const HELP_TEXT = [
  'Send a receipt photo, a bank SMS or "42 groceries": tap Record, or it waits in the Inbox.',
  "Paste several at once and they come as one list.",
  'Ask about your money: "net worth?", "groceries this month?"',
  "A card statement: check it against Rokda in Month end, or send the PDF to Claude, then tap Checked.",
  "Each morning: what needs you, then a question each with buttons.",
  "/brief · the day in short",
  "/inbox · how many wait in the Inbox",
  "/undo · take back the expense you last recorded, within ten minutes",
].join("\n");

// Telegram's command menu, in the order /help lists them.
export const COMMANDS = [
  { command: "help", description: "What I do, in a few lines" },
  { command: "brief", description: "The day in short" },
  { command: "inbox", description: "How many wait in the Inbox" },
  { command: "undo", description: "Take back your last expense" },
];

// "/help", "/help@SomeBot" and "/start payload" are help and start; anything
// not starting with a slash is not a command.
export function commandOf(text: string): string | null {
  const match = /^\/([a-z0-9_]+)(?:@\w+)?(?:\s|$)/i.exec(text.trim());
  return match ? match[1].toLowerCase() : null;
}

const INBOX_UNREAD = "Couldn't read the Inbox just now. Try again in a minute.";

// "2 in the Inbox" with Open Inbox, counted as the app's sidebar counts it
// (src/shell/useInboxCount.js): the household's pending entries, past 99 no
// more.
export async function inboxReply(householdId: string): Promise<{ text: string; markup: ReturnType<typeof inboxKeyboard> }> {
  const { data, error } = await supabase.from("intake").select("id").eq("household_id", householdId).eq("status", "pending").limit(100);
  if (error) return { text: INBOX_UNREAD, markup: null };
  const n = data?.length ?? 0;
  if (n === 0) return { text: "The Inbox is clear.", markup: null };
  return { text: `${n > 99 ? "99+" : n} in the Inbox`, markup: inboxKeyboard() };
}

// Answers a command from a linked member. brief and digest are the brief, as
// typed "brief" is (tools.ts BRIEF_TRIGGERS). The update and the message it
// replies to are /undo's (undoLatest).
export async function handleCommand(
  chatId: number,
  member: { id: string; household_id: string },
  command: string,
  context: { updateId: unknown; repliedTo: number | null },
): Promise<void> {
  if (command === "brief" || command === "digest") {
    await reply(chatId, await buildBriefMessage(member.household_id));
    return;
  }
  if (command === "inbox") {
    const { text, markup } = await inboxReply(member.household_id);
    await reply(chatId, text, markup);
    return;
  }
  if (command === "undo") {
    await undoLatest(chatId, member, context.updateId, context.repliedTo);
    return;
  }
  await reply(chatId, HELP_TEXT);
}
