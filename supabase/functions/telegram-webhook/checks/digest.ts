// The morning digest (docs/decisions.md, "One morning message instead of
// many reminders"). The reminders that need no answer -- a bill not seen, a
// card due, a budget passed, cash cover, unusual spending -- used to be a
// message each. Each check now adds its line here instead of sending, with
// who it is for and how to record it sent; the morning run then sends each
// person one message and records a line once everyone it was for received
// theirs. A line not delivered is tried again the next morning, as its
// message was before.
//
// On the mornings of the weekly brief, the monthly review or the balance
// check-in, those are "heads": the lines follow them in the same message.
// Questions that need an answer tied to their own message (autopay,
// dividends, statements, a split) are not part of this.

export type Delivery = "sent" | "retry" | "final";
export type Sender = (chatId: number, text: string) => Promise<Delivery>;

type Part = { chatIds: number[]; text: string; order: number; head: boolean; record: () => unknown };

// Where each kind of line sits: things late first, then what is coming due,
// then how the month is going.
export const DIGEST_ORDER = {
  billNotSeen: 10,
  cardOverdue: 20,
  cardDueSoon: 30,
  budget: 40,
  cashCover: 50,
  unusualSpend: 60,
  monthlyReview: 10,
  weeklyBrief: 10,
  balanceCheckin: 20,
} as const;

export class Digest {
  private parts: Part[] = [];

  // A reminder line, in the list.
  line(chatIds: number[], text: string, order: number, record: () => unknown): void {
    this.parts.push({ chatIds, text, order, head: false, record });
  }

  // A brief, review or check-in the lines follow in the same message.
  head(chatIds: number[], text: string, order: number, record: () => unknown): void {
    this.parts.push({ chatIds, text, order, head: true, record });
  }

  // Something recorded once every one of these people got their message,
  // with no text of its own: the balance check-in, sent to each member in
  // their own words, is recorded for the household as a whole.
  afterAll(chatIds: number[], record: () => unknown): void {
    this.parts.push({ chatIds, text: "", order: 0, head: true, record });
  }

  // The one message a person gets this morning, or null for none.
  messageFor(chatId: number): string | null {
    const mine = this.parts.filter((p) => p.chatIds.includes(chatId)).sort((a, b) => a.order - b.order);
    const heads = mine.filter((p) => p.head && p.text).map((p) => p.text);
    const lines = mine.filter((p) => !p.head).map((p) => `• ${p.text}`);
    if (!heads.length && !lines.length) return null;
    if (!heads.length) return `Good morning. ${lines.length} ${lines.length === 1 ? "thing" : "things"} today:\n${lines.join("\n")}`;
    return lines.length ? `${heads.join("\n\n")}\n\nAlso today:\n${lines.join("\n")}` : heads.join("\n\n");
  }

  // Sends each person their message, then records each part whose every
  // recipient got it (or refused for good: blocked, chat gone). A part for
  // nobody is recorded at once, as a message to nobody counted as sent.
  async send(send: Sender): Promise<{ chats: number; recorded: number }> {
    const chats = [...new Set(this.parts.flatMap((p) => p.chatIds))];
    const outcome = new Map<number, Delivery>();
    for (const chatId of chats) {
      const text = this.messageFor(chatId);
      if (!text) continue;
      try {
        outcome.set(chatId, await send(chatId, text));
      } catch {
        outcome.set(chatId, "retry");
      }
    }
    let recorded = 0;
    for (const part of this.parts) {
      if (part.chatIds.some((c) => outcome.get(c) === "retry")) continue;
      try {
        await part.record();
        recorded++;
      } catch {
        // Not recorded: the line comes again tomorrow, which beats losing it.
      }
    }
    return { chats: outcome.size, recorded };
  }
}
