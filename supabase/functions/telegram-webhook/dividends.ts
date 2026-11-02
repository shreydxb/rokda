// What the bot says about dividends (SHR-366): the morning question about
// dividends due in a broker's fund, what a "yes" recorded, what a "no" left
// for the app, and the reply when a dividend is typed in as income. Figures
// come from the database's own rows; nothing here works one out except the
// sum of the lines it is shown.
import { shortDay } from "../_shared/applib/autopay.js";

export type DividendLine = {
  holding_name: string;
  units: number;
  per_share: number;
  gross: number;
  tax: number;
  fees: number;
  net: number;
  pay_date: string;
};

export const DIVIDEND_GUARD_REPLY =
  "That looks like a dividend. Rokda records dividends from your shares' own records, so I haven't logged it as income. You'll find it on the holding, under Wealth → Investments.";

export const DIVIDENDS_STALE_LEAD = "Something changed since I asked, so nothing was recorded. Here it is again:";

// A dividend is cents, so its amounts always show them ($7.00, unlike a
// trade's $150); an amount per share keeps up to four digits ($0.0625).
function money(amount: number | string, currency: string, maxDigits = 2): string {
  const n = Number(amount);
  const digits = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: maxDigits });
  const body = currency === "USD" ? `$${digits}` : currency === "INR" ? `₹${digits}` : `${currency} ${digits}`;
  return n < 0 && Math.abs(n) >= 0.005 ? `−${body}` : body;
}

function count(n: number | string): string {
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: 4 });
}

// "ABC: 40 × $0.25 = $10.00, $3.00 withheld, $7.00": the net is shown only
// when something was taken from the sum.
function line(l: DividendLine, currency: string): string {
  const parts = [`${l.holding_name}: ${count(l.units)} × ${money(l.per_share, currency, 4)} = ${money(l.gross, currency)}`];
  if (Number(l.tax) > 0) parts.push(`${money(l.tax, currency)} withheld`);
  if (Number(l.fees) > 0) parts.push(`${money(l.fees, currency)} fees`);
  if (Number(l.tax) > 0 || Number(l.fees) > 0) parts.push(money(l.net, currency));
  return parts.join(", ");
}

function sum(lines: Array<{ net: number | string }>): number {
  return lines.reduce((total, l) => total + Number(l.net), 0);
}

// The morning question, one per member and fund. With `ask`, the fund's
// balance was confirmed on or after the pay date, so only the member can say
// whether these were already in it.
export function dividendsQuestion(
  fundName: string,
  currency: string,
  lines: DividendLine[],
  ask: { confirmedOn: string } | null,
): string {
  const one = lines.length === 1;
  const total = money(sum(lines), currency);
  const last = ask
    ? `Your fund's balance was confirmed on ${shortDay(ask.confirmedOn)}. Was this already in it? Reply "yes" if it was (nothing is added), or "no" if it arrived after (adds ${total}).`
    : `Reply "yes" (or react 👍) once ${one ? "it is" : "they are"} in the fund to add ${total}, or "no" to leave ${one ? "it" : "them"} for the app.`;
  return [`${one ? "Dividend" : "Dividends"} due in ${fundName} today:`, ...lines.map((l) => line(l, currency)), last].join("\n");
}

// What a "yes" recorded, from the figures the database saved. A second "yes"
// gets the same, marked as already recorded.
export function dividendsSavedMessage(
  fundName: string,
  currency: string,
  result: { lines: Array<DividendLine & { moved: number }>; total: number },
  repeat: boolean,
): string {
  const total = money(result.total, currency);
  const moved = result.lines.reduce((m, l) => m + Number(l.moved), 0);
  const lead = repeat ? "Already recorded" : "Recorded";
  let head: string;
  if (Math.abs(moved) < 0.005) {
    head = repeat ? `${lead}, as already in the fund's balance: ${total}.` : `${lead} as already in the fund's balance: ${total}.`;
  } else if (Math.abs(moved - Number(result.total)) < 0.005) {
    head = `${lead}: ${total} into ${fundName}.`;
  } else {
    head = `${lead}: ${total}, of which ${money(moved, currency)} into ${fundName}; the rest was already in its balance.`;
  }
  return [head, ...result.lines.map((l) => line(l, currency))].join("\n");
}

// What a "no" left for the app: "2 dividends into Dollar funds, $10.50".
export function dividendsDropSummary(payload: { fund_name: string; currency: string; total?: number; lines: unknown[] }): string {
  const n = payload.lines.length;
  const total = payload.total ?? sum(payload.lines as Array<{ net: number }>);
  return `${n} ${n === 1 ? "dividend" : "dividends"} into ${payload.fund_name}, ${money(total, payload.currency)}`;
}

// Why a "yes" could not be recorded, for the refusals that are not a change
// since the question (those are asked again).
export function dividendsRefusal(error: string): string {
  switch (error) {
    case "fund_archived":
      return "That fund is archived, so nothing was recorded. Record them in the app if they arrived elsewhere.";
    case "currency_mismatch":
      return "That fund is in another currency now, so nothing was recorded. Record them in the app.";
    case "wrong_status":
      return "One of them was already recorded or skipped in the app, so nothing was recorded. Check them in the app.";
    default:
      return `I couldn't record them (${error}). Nothing was saved; you can record them in the app.`;
  }
}

// A message about a dividend: the word itself, or "div" on its own (a bank's
// "DIV CREDIT"), never inside another word ("individual", "divine").
export function readsAsDividend(text: string | null | undefined): boolean {
  if (!text) return false;
  return /\bdividends?\b/i.test(text) || /\bdiv\b/i.test(text);
}

export const DIVIDENDS_STALE_NONE =
  "Something changed since I asked, so nothing was recorded. They were recorded or changed since, here or in the app, so nothing is left to ask about.";
