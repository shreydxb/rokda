// What the bot says about dividends (SHR-366): the morning question about
// dividends due in a broker's fund, what a "yes" recorded, what a "no" left
// for the app, and the reply when a dividend is typed in as income. Figures
// come from the database's own rows; nothing here works one out except the
// sum of the lines it is shown.
import { day, money } from "../_shared/applib/botFormat.js";
import { householdToday } from "../_shared/applib/day.js";

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
  "That looks like a dividend, so I haven't logged it as income: Rokda records dividends from US and Indian shares on the holding that paid them, under Wealth → Investments. If it came from anything else, add it as income in the app.";

// The share classes the dividend feeds cover: the same three as paysDividends
// in src/lib/holdings.js. The guard applies only in a household that has one.
export const DIVIDEND_CLASSES = ["us_equity", "intl_equity", "india_equity"];

export const DIVIDENDS_NOT_YET_REPLY = "Not yet · I'll ask about them again tomorrow";
export const DIVIDENDS_ANSWERED = "Already recorded · another member answered this";

export const DIVIDENDS_STALE_LEAD = "Changed since I asked. Here it is again:";

// An amount per share keeps up to four digits ("USD 0.0625"); every other
// amount is in the bot's one format (botFormat.js): "USD 10", "USD 10.50".
function perShare(amount: number | string, currency: string): string {
  const n = Number(amount);
  const code = String(currency || "AED").toUpperCase();
  const whole = Number.isInteger(n);
  return `${code} ${n.toLocaleString(code === "INR" ? "en-IN" : "en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 4 })}`;
}

function count(n: number | string, currency: string): string {
  return Number(n).toLocaleString(String(currency).toUpperCase() === "INR" ? "en-IN" : "en-US", { maximumFractionDigits: 4 });
}

// "ABC · 40 × USD 0.25 = USD 10 · USD 3 withheld · USD 7": the net is shown
// only when something was taken from the sum.
function line(l: DividendLine, currency: string): string {
  const parts = [`${l.holding_name} · ${count(l.units, currency)} × ${perShare(l.per_share, currency)} = ${money(l.gross, currency)}`];
  if (Number(l.tax) > 0) parts.push(`${money(l.tax, currency)} withheld`);
  if (Number(l.fees) > 0) parts.push(`${money(l.fees, currency)} fees`);
  if (Number(l.tax) > 0 || Number(l.fees) > 0) parts.push(money(l.net, currency));
  return parts.join(" · ");
}

function sum(lines: Array<{ net: number | string }>): number {
  return lines.reduce((total, l) => total + Number(l.net), 0);
}

// The morning question, one per member and fund (the revamp, phase 8c;
// review T12): the lines, then a few words above the buttons. With `ask`,
// the fund's balance was confirmed on or after the pay date, so only the
// member can say whether these were already in it. A typed "yes", "no" or
// "not yet", and a 👍, still answer it.
export function dividendsQuestion(
  fundName: string,
  currency: string,
  lines: DividendLine[],
  ask: { confirmedOn: string } | null,
  today = householdToday(),
): string {
  const one = lines.length === 1;
  const total = money(sum(lines), currency);
  const last = ask
    ? `${fundName} was confirmed ${day(ask.confirmedOn, today)}. Already in that balance? ${total} in all.`
    : `Arrived? ${total} in all.`;
  // "today" only on the pay date: asked again after Not yet, the day it was
  // due (the revamp review), or the earliest when they were due on different days.
  const dates = [...new Set(lines.map((l) => l.pay_date))].sort();
  const when = dates.length > 1 ? `since ${day(dates[0], today)}` : dates[0] && dates[0] < today ? `on ${day(dates[0], today)}` : "today";
  return [`${one ? "Dividend" : "Dividends"} due in ${fundName} ${when}`, ...lines.map((l) => line(l, currency)), last].join("\n");
}

// What an answer recorded, from the figures the database saved: the tick
// line, or "Already recorded" for an answer repeated after it was.
export function dividendsSavedMessage(
  fundName: string,
  currency: string,
  result: { lines: Array<DividendLine & { moved: number }>; total: number },
  repeat: boolean,
): string {
  const total = money(result.total, currency);
  const moved = result.lines.reduce((m, l) => m + Number(l.moved), 0);
  const lead = repeat ? "Already recorded · " : "✓ ";
  let head: string;
  if (Math.abs(moved) < 0.005) head = `${lead}${total} · already in ${fundName}${fundName.endsWith("s") ? "'" : "'s"} balance`;
  else if (Math.abs(moved - Number(result.total)) < 0.005) head = `${lead}${total} into ${fundName}`;
  else head = `${lead}${total} · ${money(moved, currency)} into ${fundName}, the rest already in its balance`;
  return [head, ...result.lines.map((l) => line(l, currency))].join("\n");
}

// What Leave for the app (or a "no") left: "2 dividends into Dollar funds ·
// USD 10.50", after "Left for the app · ".
export function dividendsDropSummary(payload: { fund_name: string; currency: string; total?: number; lines: unknown[] }): string {
  const n = payload.lines.length;
  const total = payload.total ?? sum(payload.lines as Array<{ net: number }>);
  return `${n} ${n === 1 ? "dividend" : "dividends"} into ${payload.fund_name} · ${money(total, payload.currency)}`;
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
      return "Couldn't record them. Nothing saved — record them on the holding in the app.";
  }
}

// A message about a dividend: the word itself, or "div" on its own (a bank's
// "DIV CREDIT"), never inside another word ("individual", "divine").
export function readsAsDividend(text: string | null | undefined): boolean {
  if (!text) return false;
  return /\bdividends?\b/i.test(text) || /\bdiv\b/i.test(text);
}

export const DIVIDENDS_STALE_NONE =
  "Changed since I asked: nothing recorded, and nothing left to ask about.";
