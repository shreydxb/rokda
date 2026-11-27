// The morning digest (docs/decisions.md, "One morning message instead of
// many reminders"). The reminders that need no answer -- a bill not seen, a
// card due, a budget passed, cash cover, unusual spending -- used to be a
// message each. Each check now adds its line here instead of sending, with
// who it is for and how to record it sent; the morning run then sends each
// person one message and records a line once everyone it was for received
// theirs. A line not delivered is tried again the next morning, as its
// message was before.
//
// On the mornings of the weekly brief or the monthly review, those are
// "heads": the lines follow them in the same message. Questions that need an
// answer tied to their own message (autopay, dividends, statements, a split,
// the month-end check-in) are not part of this: they follow it, each its own
// message (the revamp, phase 8c).
//
// The lines are short and grouped (checks/morningWords.ts): what needs doing
// today first, then how the month is going, with Open Overview under the
// message when the app's address is set.

export type Delivery = "sent" | "retry" | "final";
export type Sender = (chatId: number, text: string, replyMarkup?: unknown) => Promise<Delivery>;

type Part = { chatIds: number[]; text: string; order: number; head: boolean; record: () => unknown; givesCashCover?: boolean; inBrief?: boolean };

// Where each kind of line sits: things late first, then what is coming due
// and whether the money is there for it, then how the month is going. Heads
// have their own order (below).
export const DIGEST_ORDER = {
  billNotSeen: 10,
  cardOverdue: 20,
  cardDueSoon: 30,
  cashCover: 35,
  budget: 40,
  unusualSpend: 60,
  weeklyBrief: 5,
  monthlyReview: 10,
} as const;

// The groups the lines go under, by their order: a line belongs to the last
// group whose start it has reached.
export const DIGEST_GROUPS: Array<{ title: string; from: number }> = [
  { title: "Today", from: 0 },
  { title: "This month", from: DIGEST_ORDER.budget },
];

// Telegram refuses a message over 4,096 characters for good, so a long
// morning goes in parts, each kept under this, broken only between lines.
export const DIGEST_PART_LIMIT = 4000;

// Where it can, a part ends at a blank line (between a brief and the groups,
// or two groups), so a group's title is never the last line of a part with
// its lines in the next.
export function splitMessage(text: string, limit = DIGEST_PART_LIMIT): string[] {
  const parts: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    // A single line longer than a part is cut, which beats losing it.
    for (let piece = line; ; piece = piece.slice(limit)) {
      const chunk = piece.slice(0, limit);
      if (current && current.length + 1 + chunk.length > limit) {
        const blank = current.lastIndexOf("\n\n");
        const carried = blank > 0 ? current.slice(blank + 2) : "";
        if (blank > 0 && carried.length + 1 + chunk.length <= limit) {
          parts.push(current.slice(0, blank));
          current = `${carried}\n${chunk}`;
        } else {
          parts.push(current);
          current = chunk;
        }
      } else {
        current = current ? `${current}\n${chunk}` : chunk;
      }
      if (piece.length <= limit) break;
    }
  }
  if (current) parts.push(current);
  return parts;
}

// Whether a record went in: Supabase answers { error } rather than throwing.
async function recordedOk(record: () => unknown): Promise<boolean> {
  const result = (await record()) as { error?: unknown } | undefined;
  return !(result && typeof result === "object" && "error" in result && result.error);
}

export class Digest {
  private parts: Part[] = [];

  // A reminder line, in the list. inBrief: a brief gives the same figure a
  // line of its own (cash cover), so under one this is left out of the
  // message, and recorded all the same.
  line(chatIds: number[], text: string, order: number, record: () => unknown, opts: { inBrief?: boolean } = {}): void {
    this.parts.push({ chatIds, text, order, head: false, record, inBrief: opts.inBrief });
  }

  // A brief or review the lines follow in the same message.
  // givesCashCover: it has a cash cover line (the weekly brief, the monthly
  // review).
  head(chatIds: number[], text: string, order: number, record: () => unknown, opts: { givesCashCover?: boolean } = {}): void {
    this.parts.push({ chatIds, text, order, head: true, record, givesCashCover: opts.givesCashCover });
  }


  // The one message a person gets this morning, or null for none: the heads,
  // then each group's title and its lines.
  messageFor(chatId: number): string | null {
    const mine = this.parts.filter((p) => p.chatIds.includes(chatId)).sort((a, b) => a.order - b.order);
    const heads = mine.filter((p) => p.head && p.text).map((p) => p.text);
    const underBrief = mine.some((p) => p.head && p.givesCashCover);
    const lines = mine.filter((p) => !p.head && !(underBrief && p.inBrief));
    if (!heads.length && !lines.length) return null;
    const groups = DIGEST_GROUPS.map((g, i) => {
      const until = DIGEST_GROUPS[i + 1]?.from ?? Infinity;
      const inGroup = lines.filter((p) => p.order >= g.from && p.order < until).map((p) => p.text);
      return inGroup.length ? [g.title, ...inGroup].join("\n") : null;
    }).filter(Boolean);
    const body = groups.join("\n\n");
    return [...heads, ...(body ? [body] : [])].join("\n\n");
  }

  // Sends each person their message, then records each part whose every
  // recipient got it (or refused for good: blocked, chat gone). A part for
  // nobody is recorded at once, as a message to nobody counted as sent.
  // replyMarkup (Open Overview) goes under each person's message, on its
  // last part.
  async send(send: Sender, replyMarkup: unknown = null): Promise<{ chats: number; recorded: number }> {
    const chats = [...new Set(this.parts.flatMap((p) => p.chatIds))];
    const outcome = new Map<number, Delivery>();
    for (const chatId of chats) {
      const text = this.messageFor(chatId);
      if (!text) continue;
      // Every part has to arrive: one not delivered holds the whole morning
      // for that person for tomorrow, as a lost reminder is worse than a repeat.
      let worst: Delivery = "sent";
      const parts = splitMessage(text);
      for (const [i, part] of parts.entries()) {
        let result: Delivery;
        try {
          result = await send(chatId, part, i === parts.length - 1 && replyMarkup ? replyMarkup : undefined);
        } catch {
          result = "retry";
        }
        if (result === "retry") worst = "retry";
        else if (result === "final" && worst === "sent") worst = "final";
      }
      outcome.set(chatId, worst);
    }
    let recorded = 0;
    for (const part of this.parts) {
      if (part.chatIds.some((c) => outcome.get(c) === "retry")) continue;
      try {
        if (await recordedOk(part.record)) recorded++;
      } catch {
        // Not recorded: the line comes again tomorrow, which beats losing it.
      }
    }
    return { chats: outcome.size, recorded };
  }
}
