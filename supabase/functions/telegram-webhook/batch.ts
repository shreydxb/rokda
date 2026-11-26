// Reviewing a pasted batch in Telegram (docs/decisions.md, "A pasted batch
// is finished in Telegram", and the revamp's phase 8b, "A pasted list is
// answered with buttons"): reading a reply to the numbered list, writing the
// list and its buttons, and showing it again as its entries come to stand.
// Pure, so all of it is tested without the handler; the handler side is
// batchReview.ts.
import { day, facts, money } from "../_shared/applib/botFormat.js";
import { householdToday } from "../_shared/applib/day.js";

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

export type ListedEntry = { amount: number; merchant: string; account: string; category: string; date: string | null; undated: boolean };

export type ListNotes = {
  recorded: Array<{ merchant: string; amount: number }>;
  waiting: Array<{ merchant: string | null; reason: string }>;
  overCap: number;
};

// One entry as the list shows it, after its number, in the bot's one format:
// who, how much, the category and card, and its day when the SMS gave one.
// A reply is checked against this, so an entry changed since is never
// recorded unseen.
export function listLine(e: Omit<ListedEntry, "undated">, today = householdToday()): string {
  return facts(e.merchant, money(e.amount), e.category, e.account, e.date && day(e.date, today));
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

// Asked under the entries while one the SMS gave no day waits on the list.
export const LIST_QUESTION_ALL = "No dates in the SMS: when were they paid?";
export const LIST_QUESTION_SOME = "Some have no date in the SMS: when were those paid?";

// The numbered list sent after a paste of several entries: how many the
// message held, a line an entry, the question for the day when the SMS gave
// none (in a list where only some lack one, those are marked), then what was
// left out and why. Its buttons are listKeyboard's.
export function batchListMessage(listed: ListedEntry[], notes: ListNotes, today = householdToday()): string {
  const total = listed.length + notes.recorded.length + notes.waiting.length + notes.overCap;
  const undated = listed.filter((e) => e.undated).length;
  const mixed = undated > 0 && undated < listed.length;
  const lines = [`${total} from that message`];
  listed.forEach((e, i) => {
    lines.push(`${i + 1}. ${listLine(e, today)}${mixed && e.undated ? " · no date" : ""}`);
  });
  if (undated) lines.push(mixed ? LIST_QUESTION_SOME : LIST_QUESTION_ALL);
  for (const r of notes.recorded) lines.push(`Already recorded, left out · ${facts(r.merchant, money(r.amount))}`);
  for (const w of notes.waiting) lines.push(`In the Inbox · ${facts(w.merchant ?? "One entry", w.reason)}`);
  if (notes.overCap) lines.push(`In the Inbox · ${notes.overCap} more · a list takes ${BATCH_LIST_CAP}`);
  return lines.join("\n");
}

// --- The list's buttons ----------------------------------------------------
//
// "L", what the button does, and which entries it is about as a bit mask of
// their numbers (bit 0 is entry 1), in base 36; no mask is every entry still
// offered. a records, t and y record on today or yesterday (the day goes to
// entries the SMS gave none), o says how to give another day, c and x show
// the entries to choose from (x with those chosen so far), s discards those
// chosen (sets them aside, as Discard does an expense's), b goes back. The list is the message tapped, and every tap is
// checked against it and the database (batchReview.ts).

export type ListOp = "a" | "t" | "y" | "o" | "c" | "x" | "s" | "b";
type Button = { text: string; callback_data: string };
export type ListKeyboard = { inline_keyboard: Button[][] };

export function encodeListTap(op: ListOp, mask = 0): string {
  return `L${op}${mask ? mask.toString(36) : ""}`;
}

export function decodeListTap(data: string): { op: ListOp; mask: number } | null {
  const m = /^L([atyocxsb])([0-9a-z]{0,5})$/.exec(data);
  if (!m) return null;
  const mask = m[2] ? parseInt(m[2], 36) : 0;
  return mask < 2 ** BATCH_LIST_CAP ? { op: m[1] as ListOp, mask } : null;
}

// The entry numbers a mask names, ascending.
export function listNumbers(mask: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < BATCH_LIST_CAP; i++) if (mask & (1 << i)) out.push(i + 1);
  return out;
}

const tap = (text: string, op: ListOp, mask = 0): Button => ({ text, callback_data: encodeListTap(op, mask) });

// Under the list: Record all when every entry offered has its day, or the
// days to record them on when one has none; Choose… for some of them.
export function listKeyboard(undated: boolean): ListKeyboard {
  return undated
    ? { inline_keyboard: [[tap("Today", "t"), tap("Yesterday", "y")], [tap("Other day", "o"), tap("Choose…", "c")]] }
    : { inline_keyboard: [[tap("Record all", "a"), tap("Choose…", "c")]] };
}

// Choose…: a button an entry still offered, labelled with who and how much
// as the list shows them, ticked once chosen (a tap toggles it), then what
// can be done with those chosen, and Back.
export function chooseKeyboard(entries: Array<{ n: number; label: string; undated: boolean }>, mask: number): ListKeyboard {
  const rows: Button[][] = entries.map((e) => {
    const bit = 1 << (e.n - 1);
    const label = `${mask & bit ? "✓ " : ""}${e.n}. ${e.label}`;
    return [tap(label.length > 40 ? `${label.slice(0, 39)}…` : label, "x", mask ^ bit)];
  });
  const chosen = entries.filter((e) => mask & (1 << (e.n - 1)));
  if (chosen.length) {
    rows.push(chosen.some((e) => e.undated) ? [tap("Today", "t", mask), tap("Yesterday", "y", mask), tap("Other day", "o", mask)] : [tap(`Record ${chosen.length}`, "a", mask)]);
    rows.push([tap(`Discard ${chosen.length}`, "s", mask)]);
  }
  rows.push([tap("Back", "b")]);
  return { inline_keyboard: rows };
}

// What became of an entry by what was just done on the list.
export type ListMark = "recorded" | "dropped" | "changed" | "repeat";

// The list shown again as its entries now stand. The lines under the header
// are its entries, in order, one each: an entry still offered keeps its
// numbered line; one recorded or cancelled from the list keeps what it
// showed, with a tick or "Cancelled"; one left in the Inbox, or settled in
// the app since, says so. Only what the list showed is ever repeated, never
// figures or names read since: an entry is named as its line names it. offered are the numbers still offered, and undated whether one of
// them still needs its day. Null when the text is not a list of these
// entries.
export function renderList(
  text: string,
  rows: Array<{ status: string; undated: boolean }>,
  marks: Map<number, ListMark>,
): { text: string; offered: number[]; undated: boolean } | null {
  const lines = text.split("\n");
  if (!rows.length || lines.length < rows.length + 1) return null;
  let rest = lines.slice(rows.length + 1);
  if (rest[0] === LIST_QUESTION_ALL || rest[0] === LIST_QUESTION_SOME) rest = rest.slice(1);
  const offered: number[] = [];
  let undated = 0;
  const items = lines.slice(1, rows.length + 1).map((line, i) => {
    const m = /^(\d+)\. (.*?)( · no date)?$/.exec(line);
    // Settled on the list before: shown as it was, unless it was left in the
    // Inbox and a typed "drop" has now discarded it.
    if (!m || Number(m[1]) !== i + 1) {
      return marks.get(i) === "dropped" && line.startsWith("In the Inbox · ") ? `Cancelled · ${line.split(" · ")[1]}` : line;
    }
    const shown = m[2];
    const row = rows[i];
    // Who first, as this list writes it; a list sent before the one format
    // led with the amount.
    const who = shown.split(" · ").find((f) => !/^AED [\d,.]+$/.test(f)) || "One entry";
    switch (marks.get(i)) {
      case "recorded":
        return `✓ ${shown}`;
      case "dropped":
        return `Cancelled · ${shown}`;
      case "changed":
        return `In the Inbox · ${who} · changed since`;
      case "repeat":
        return `In the Inbox · ${shown} · looks recorded already`;
    }
    if (row.status === "approved") return `Already recorded · ${who}`;
    if (row.status !== "pending") return `Already cancelled · ${who}`;
    offered.push(i + 1);
    if (row.undated) undated++;
    return line;
  });
  const question = undated ? [undated < offered.length ? LIST_QUESTION_SOME : LIST_QUESTION_ALL] : [];
  return { text: [lines[0], ...items, ...question, ...rest].join("\n"), offered, undated: undated > 0 };
}
