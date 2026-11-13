// Reviewing a pasted batch in Telegram (docs/decisions.md, "A pasted batch
// is finished in Telegram"): reading a reply to the numbered list, and
// writing the list. Pure, so both are tested without the handler; the
// handler side is batchReview.ts.

// More than this many entries is not a list anyone checks line by line in a
// chat; the rest wait in the Inbox, and the list says how many.
export const BATCH_LIST_CAP = 20;

export type BatchCommand =
  | { kind: "all"; date: string | null }
  | { kind: "some"; numbers: number[]; date: string | null }
  | { kind: "drop"; numbers: number[] };

export type BatchReply = BatchCommand | { kind: "invalid"; reason: string };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_WORDS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const DAY_MS = 86_400_000;

function isoOf(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

function shiftDay(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function monthNumber(word: string): number | null {
  if (/^\d{1,2}$/.test(word)) {
    const n = Number(word);
    return n >= 1 && n <= 12 ? n : null;
  }
  const full = MONTH_WORDS.indexOf(word);
  if (full >= 0) return full + 1;
  const short = MONTHS.indexOf(word.replace(/^sept$/, "sep"));
  return short >= 0 ? short + 1 : null;
}

// The day a reply names: "today", "yesterday", a day and month ("2 Oct",
// "2 October", "2/10"). A day and month with no year is the latest such day
// not after today, so "28 Dec" said in January is last December. A paste
// covers recent days, so a year back is taken only within the last two
// months; any other day after today is a slip and refused ("future"), never
// moved back a year: "20 Oct" said on 9 Oct is not last October.
// Null when the words are not a day at all, or name one that does not exist.
export function readBatchDate(words: string, today: string): string | null | "future" {
  const w = words.trim().toLowerCase().replace(/[.!]+$/, "");
  if (w === "today") return today;
  if (w === "yesterday") return shiftDay(today, -1);
  const m = /^(\d{1,2})(?:st|nd|rd|th)?(?:\s+|\/)([a-z]+|\d{1,2})$/.exec(w);
  if (!m) return null;
  const day = Number(m[1]);
  const month = monthNumber(m[2]);
  if (!month) return null;
  const year = Number(today.slice(0, 4));
  const thisYear = isoOf(year, month, day);
  if (!thisYear) return null;
  if (thisYear <= today) return thisYear;
  const lastYear = isoOf(year - 1, month, day);
  return lastYear && Date.parse(today) - Date.parse(lastYear) <= 60 * DAY_MS ? lastYear : "future";
}

// "1-3, 5", "2 4", "1 and 3" -> ascending, without repeats. Null when a range
// runs backwards or names entry 0.
function readNumbers(words: string): number[] | null {
  const parts = words.split(/\s*(?:,|\band\b|\s)\s*/).filter(Boolean);
  if (!parts.length) return null;
  const out = new Set<number>();
  for (const part of parts) {
    const range = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!range) return null;
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    if (from < 1 || to < from || to - from > 100) return null;
    for (let n = from; n <= to; n++) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

const NUMBERS = /^(\d+(?:\s*-\s*\d+)?(?:\s*(?:,|\band\b|\s)\s*\d+(?:\s*-\s*\d+)?)*)(.*)$/;

// What follows "all" or the numbers: nothing, or a day ("on 2 Oct", "today").
// Words after them that are not a day mean the message was not a command at
// all ("all good thanks", "40 coffee"), unless they start with "on", which
// only a day follows.
function readTail(tail: string, today: string): { date: string | null } | { kind: "invalid"; reason: string } | null {
  const t = tail.trim();
  if (!t) return { date: null };
  const saysOn = /^on\b/.test(t);
  const date = readBatchDate(t.replace(/^on\s+/, ""), today);
  if (date === "future") return { kind: "invalid", reason: "That day is still to come. Say the day they were paid, like \"all on 2 Oct\"." };
  if (date) return { date };
  return saysOn ? { kind: "invalid", reason: "I couldn't read that day. Say it like \"2 Oct\", \"2/10\", \"today\" or \"yesterday\"." } : null;
}

// A reply to a batch list, or null when the text is not a batch command at
// all (it is then answered as any other reply to the list would be).
export function parseBatchReply(text: string, today: string): BatchReply | null {
  const s = text.trim().toLowerCase().replace(/[.!]+$/, "").replace(/\s+/g, " ");

  const drop = /^drop\b(.*)$/.exec(s);
  if (drop) {
    const numbers = readNumbers(drop[1].trim());
    return numbers ? { kind: "drop", numbers } : { kind: "invalid", reason: "Say which to set aside by its number, like \"drop 4\"." };
  }

  const all = /^all\b(.*)$/.exec(s);
  if (all) {
    const tail = readTail(all[1], today);
    if (!tail) return null;
    return "kind" in tail ? tail : { kind: "all", date: tail.date };
  }

  const some = NUMBERS.exec(s);
  if (some) {
    const numbers = readNumbers(some[1].trim());
    const tail = readTail(some[2], today);
    if (!tail) return null;
    if ("kind" in tail) return tail;
    if (!numbers) return { kind: "invalid", reason: "I couldn't read those numbers. Say them like \"1-3, 5\"." };
    return { kind: "some", numbers, date: tail.date };
  }
  return null;
}

// A command a list would take, read in full: "drop-off laundry 25" is an
// expense, not a malformed "drop".
export function isBatchCommand(text: string, today: string): boolean {
  const command = parseBatchReply(text, today);
  return command != null && command.kind !== "invalid";
}

export type ListedEntry = { amount: number; merchant: string; account: string; category: string; undated: boolean };

export type ListNotes = {
  recorded: Array<{ merchant: string; amount: number }>;
  waiting: Array<{ merchant: string | null; reason: string }>;
  overCap: number;
};

function aed(amount: number): string {
  return `AED ${Number(amount).toFixed(2)}`;
}

// One entry as the list shows it, after its number. A reply is checked
// against this, so an entry changed since is never recorded unseen.
export function listLine(e: Omit<ListedEntry, "undated">): string {
  return `${aed(e.amount)} · ${e.merchant} · ${e.account} · ${e.category}`;
}

// The numbered lines of a list as sent, by number, without the "no date" mark.
export function listedLines(text: string): Map<number, string> {
  const lines = new Map<number, string>();
  for (const line of text.split("\n")) {
    const m = /^(\d+)\. (.*?)( · no date)?$/.exec(line);
    if (m) lines.set(Number(m[1]), m[2]);
  }
  return lines;
}

// The numbered list sent after a paste of several entries. Entries with no
// date in the SMS are dated by the reply, so the instruction asks for a day
// whenever one is undated; in a list where only some are, those are marked.
export function batchListMessage(listed: ListedEntry[], notes: ListNotes): string {
  const total = listed.length + notes.recorded.length + notes.waiting.length + notes.overCap;
  const undated = listed.filter((e) => e.undated).length;
  const mixed = undated > 0 && undated < listed.length;
  const lines = [`Got ${total} from that message. Reply to this to record them:`];
  listed.forEach((e, i) => {
    lines.push(`${i + 1}. ${listLine(e)}${mixed && e.undated ? " · no date" : ""}`);
  });
  const range = listed.length > 1 ? `1-${listed.length}` : "1";
  if (undated) {
    lines.push(`${mixed ? "Some have no date" : "No date"} in the SMS: say the day they were paid, like "all on 2 Oct", or "${range} on 2 Oct" for some. "drop 2" sets one aside.`);
  } else {
    lines.push(`Reply "all" to record them, or "${range}" for some. "drop 2" sets one aside.`);
  }
  if (notes.recorded.length) {
    const n = notes.recorded.length;
    const named = notes.recorded.map((r) => `${r.merchant}, ${aed(r.amount)}`).join("; ");
    lines.push(`${n} more ${n === 1 ? "is" : "are"} already recorded (${named}), left out.`);
  }
  if (notes.waiting.length) {
    const n = notes.waiting.length;
    const named = notes.waiting.map((w) => (w.merchant ? `${w.merchant}: ${w.reason}` : w.reason)).join("; ");
    lines.push(`${n} ${n === 1 ? "needs" : "need"} a look in the Inbox (${named}).`);
  }
  if (notes.overCap) lines.push(`${notes.overCap} more wait in the Inbox (a list takes ${BATCH_LIST_CAP} at most).`);
  return lines.join("\n");
}
