// The bot's share trades, as pure helpers (SHR-370; docs/decisions.md, "The
// bot records trades"). index.ts reads a trade message with the router,
// matches it here, asks here for whatever is missing, previews it in the
// database, and writes the confirmation here from the preview's figures.
// Nothing in this file reads the database or the network, and nothing here
// works out a figure the member is asked to confirm: every number in a
// confirmation is the database's.
import { shortDay } from "../_shared/applib/autopay.js";

// How a member answers any of the bot's confirmations. Kept here, beside the
// trade confirmation that ends with it, and imported by index.ts for the rest.
export const ANSWER_HINT = 'Reply "yes" to this message (or react 👍) to save it, or "no" to drop it.';

export type Field = "holding" | "units" | "price" | "currency";

export type HoldingLite = {
  id: string;
  name: string;
  currency: string;
  asset_class: string;
  price_symbol: string | null;
  price_provider: string | null;
  owner_member_id: string | null;
  funds_account_id: string | null;
  trades_version: number;
  quantity: number | null;
  current_price: number | null;
};

export type NewHolding = {
  owner_member_id: string;
  name: string;
  asset_class: string;
  currency: string;
  price_symbol: string;
  price_provider: string;
  sector: null;
  funds_account_id: string | null;
};

export type TradeDraft = {
  side: "buy" | "sell" | "split";
  stock: string;
  units: number | null;
  price: number | null;
  priceCurrency: string | null;
  ratio: number | null;
  tradeDate: string;
  tradedAt: string | null;
  fees: number;
  tax: number | null;
  ownerMemberId: string;
  holdingId: string | null;
  candidates: string[];
  newHolding: NewHolding | null;
  awaiting: Field | null;
  lastUpdateId: number | null;
};

type Effect = Record<string, unknown>;

const CURRENCY_WORDS: Record<string, string> = { USD: "dollars", INR: "rupees", AED: "dirhams" };
const ASSET_CLASS_WORDS: Record<string, string> = { us_equity: "US equity", india_equity: "Indian equity" };
const PROVIDER_WORDS: Record<string, string> = { twelvedata: "Twelve Data", yahoo: "Yahoo Finance" };

// A ticker as the household writes it, the broker shows it and the price feed
// stores it: "abc.ns", "NSE:ABC" and "ABC" are one stock. An exchange prefix
// or a Yahoo exchange suffix is dropped, then anything but letters and digits.
export function normaliseSymbol(s: string): string {
  return String(s ?? "")
    .toUpperCase()
    .trim()
    .replace(/^[A-Z]+:/, "")
    .replace(/\.(NS|BO|NSE|BSE|AE)$/, "")
    .replace(/[^A-Z0-9]/g, "");
}

// The member's own holdings of a stock, by its feed symbol or its name, closed
// ones included (a stock bought again after selling out goes back into its
// old holding). Shared holdings and another member's are never matched: a
// trade lands on the holding of whoever made it.
export function matchHoldings(holdings: HoldingLite[], ownerMemberId: string, stock: string): HoldingLite[] {
  const wanted = normaliseSymbol(stock);
  const wantedName = String(stock ?? "").trim().toLowerCase();
  if (!wanted && !wantedName) return [];
  return holdings.filter((h) =>
    h.owner_member_id === ownerMemberId &&
    ((h.price_symbol !== null && normaliseSymbol(h.price_symbol) === wanted) ||
      h.name.trim().toLowerCase() === wantedName ||
      normaliseSymbol(h.name) === wanted)
  );
}

function positive(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value.replace(/,/g, "")) : Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(n) && n > 0 ? n : null;
}

function isoDate(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

// A trade from the router's log_trade arguments. Dates are calendar days in
// Dubai, compared as strings: a trade dated after today has not happened. The
// holding is left for index.ts to match.
export function draftFromArgs(
  args: Record<string, unknown>,
  ctx: { senderId: string; members: Array<{ id: string; display_name: string }>; today: string },
): TradeDraft | { error: "future_date" | "no_stock" | "unknown_member" | "no_side" } {
  const side = String(args.side ?? "").toLowerCase();
  if (side !== "buy" && side !== "sell" && side !== "split") return { error: "no_side" };
  const stock = String(args.stock ?? "").trim();
  if (!stock) return { error: "no_stock" };
  let ownerMemberId = ctx.senderId;
  const named = String(args.member ?? "").trim().toLowerCase();
  if (named) {
    const member = ctx.members.find((m) => m.display_name.trim().toLowerCase() === named);
    if (!member) return { error: "unknown_member" };
    ownerMemberId = member.id;
  }
  const tradeDate = isoDate(args.trade_date) ?? ctx.today;
  if (tradeDate > ctx.today) return { error: "future_date" };
  const currency = String(args.currency ?? "").trim().toUpperCase();
  const tax = args.tax === null || args.tax === undefined || args.tax === "" ? null : Number(args.tax);
  return {
    side,
    stock,
    units: side === "split" ? null : positive(args.units),
    price: side === "split" ? null : positive(args.price),
    priceCurrency: ["USD", "INR", "AED"].includes(currency) ? currency : null,
    ratio: side === "split" ? positive(args.ratio) : null,
    tradeDate,
    tradedAt: typeof args.traded_at === "string" && !Number.isNaN(Date.parse(args.traded_at)) ? args.traded_at : null,
    fees: positive(args.brokerage) ?? 0,
    tax: tax !== null && Number.isFinite(tax) && tax >= 0 ? tax : null,
    ownerMemberId,
    holdingId: null,
    candidates: [],
    newHolding: null,
    awaiting: null,
    lastUpdateId: null,
  };
}

// The currency the trade is in: its holding's, or for a stock not yet held,
// the one its message named (dollars or rupees, the funds the household has).
function draftCurrency(draft: TradeDraft, holdings: HoldingLite[]): string | null {
  const held = draft.holdingId ? holdings.find((h) => h.id === draft.holdingId) : null;
  if (held) return held.currency;
  if (draft.newHolding) return draft.newHolding.currency;
  return draft.priceCurrency === "USD" || draft.priceCurrency === "INR" ? draft.priceCurrency : null;
}

function units(n: unknown): string {
  return String(Number(Number(n).toFixed(8)));
}

// The one thing still missing, as the question to ask, or null when the
// draft can be previewed. Asked in this order: which holding, how many, the
// currency of a stock not yet held, the price. A price in another currency
// than the holding's is asked again, never converted.
export function nextQuestion(draft: TradeDraft, holdings: HoldingLite[]): { field: Field; text: string } | null {
  if (!draft.holdingId && draft.candidates.length > 1) {
    const lines = draft.candidates.map((id, i) => {
      const h = holdings.find((x) => x.id === id);
      return `${i + 1}. ${h?.name ?? id}${h?.quantity !== null && h?.quantity !== undefined ? ` (${units(h.quantity)} shares)` : ""}`;
    });
    return { field: "holding", text: `Which ${draft.stock}?\n${lines.join("\n")}\nReply with its number.` };
  }
  if (draft.side === "split") return null;
  if (draft.units === null) {
    return { field: "units", text: `How many ${draft.stock} did you ${draft.side === "buy" ? "buy" : "sell"}?` };
  }
  const currency = draftCurrency(draft, holdings);
  if (!currency) {
    return { field: "currency", text: `Is ${draft.stock} bought in dollars or rupees?` };
  }
  const word = CURRENCY_WORDS[currency] ?? currency;
  if (draft.price === null) {
    return { field: "price", text: `At what price per share, in ${word}?` };
  }
  if (draft.priceCurrency && draft.priceCurrency !== currency) {
    return { field: "price", text: `${draft.stock} trades in ${word}. What was the price per share in ${word}?` };
  }
  return null;
}

function readNumber(text: string): number | null {
  const m = /^\s*(?:\$|₹|rs\.?|usd|inr|aed)?\s*([\d,]*\.?\d+)\s*(?:shares?|units?|\$|usd|inr|rupees?|dollars?)?\s*$/i.exec(text);
  return m ? positive(m[1]) : null;
}

function readCurrency(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (/^(\$|usd|dollars?|us\$?)$/.test(t)) return "USD";
  if (/^(₹|inr|rs\.?|rupees?)$/.test(t)) return "INR";
  return null;
}

// The draft with the awaited answer filled in, or null when the text does not
// answer the question (the caller then treats it as a message of its own).
export function applyAnswer(draft: TradeDraft, text: string, holdings: HoldingLite[]): TradeDraft | null {
  const done = (changes: Partial<TradeDraft>): TradeDraft => ({ ...draft, ...changes, awaiting: null });
  switch (draft.awaiting) {
    case "units": {
      const n = readNumber(text);
      return n === null ? null : done({ units: n });
    }
    case "price": {
      const n = readNumber(text);
      // Asked in the holding's currency, so the answer is in it.
      return n === null ? null : done({ price: n, priceCurrency: draftCurrency({ ...draft, priceCurrency: null }, holdings) ?? draft.priceCurrency });
    }
    case "holding": {
      const n = Number(text.trim().replace(/\.$/, ""));
      return Number.isInteger(n) && n >= 1 && n <= draft.candidates.length ? done({ holdingId: draft.candidates[n - 1] }) : null;
    }
    case "currency": {
      const currency = readCurrency(text);
      if (!currency) return null;
      // A price given with no currency was in the stock's, so it stands; one
      // given in another currency is dropped, to be asked again in this one.
      const mismatched = draft.priceCurrency !== null && draft.priceCurrency !== currency;
      return done({ priceCurrency: currency, price: mismatched ? null : draft.price });
    }
    default:
      return null;
  }
}

// A stock bought for the first time: its feed symbol (NSE shares take ".NS"
// on Yahoo; US shares are Twelve Data's), its class, and the owner's one open
// broker fund in its currency, if they have exactly one. With none or several
// the fund is left empty and the preview says one is needed.
export function newHoldingFor(
  stock: string,
  currency: string,
  ownerMemberId: string,
  funds: Array<{ id: string; currency: string; owner_member_id: string | null; archived_at: string | null }>,
): NewHolding {
  const symbol = normaliseSymbol(stock);
  const indian = currency === "INR";
  const own = funds.filter((f) => f.owner_member_id === ownerMemberId && f.currency === currency && !f.archived_at);
  return {
    owner_member_id: ownerMemberId,
    name: symbol,
    asset_class: indian ? "india_equity" : "us_equity",
    currency,
    price_symbol: indian ? `${symbol}.NS` : symbol,
    price_provider: indian ? "yahoo" : "twelvedata",
    sector: null,
    funds_account_id: own.length === 1 ? own[0].id : null,
  };
}

// "$1,234.50", "₹1,234.50", "AED 1,234.50"; a whole amount has no decimals.
// A negative amount carries the minus sign before the currency.
export function formatMoney(amount: number, currency: string): string {
  const n = Number(amount);
  const whole = Math.abs(n - Math.round(n)) < 0.005;
  const digits = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  });
  const body = currency === "USD" ? `$${digits}` : currency === "INR" ? `₹${digits}` : `${currency} ${digits}`;
  return n < 0 && !(whole && Math.round(n) === 0) ? `−${body}` : body;
}

function signed(amount: number, currency: string): string {
  return amount > 0 ? `+${formatMoney(amount, currency)}` : formatMoney(amount, currency);
}

function holdingLine(name: string, effect: Effect, currency: string): string {
  const before = effect.units_before === null || effect.units_before === undefined ? 0 : Number(effect.units_before);
  const after = Number(effect.holding_units_after);
  const avgAfter = effect.holding_avg_after === null || effect.holding_avg_after === undefined ? null : Number(effect.holding_avg_after);
  const avgBefore = effect.avg_before === null || effect.avg_before === undefined ? null : Number(effect.avg_before);
  if (before === 0) {
    return avgAfter === null ? `${name}: ${units(after)} shares` : `${name}: ${units(after)} shares, average ${formatMoney(avgAfter, currency)}`;
  }
  const average = avgAfter === null ? "" : avgBefore !== null && Math.abs(avgBefore - avgAfter) < 0.000001
    ? `, average stays ${formatMoney(avgAfter, currency)}`
    : `, average ${avgBefore === null ? "" : `${formatMoney(avgBefore, currency)} → `}${formatMoney(avgAfter, currency)}`;
  return `${name}: ${units(before)} → ${units(after)} shares${average}`;
}

// The confirmation of a trade, from the preview's figures: what was traded,
// the holding before and after, the profit and the fund's movement, then any
// warning the preview raised, then how to answer.
export function tradeConfirmation(
  draft: TradeDraft,
  effect: Effect,
  ctx: { holdingName: string; ownerName: string | null; fundName: string; currency: string; newHolding: NewHolding | null; lastPrice?: number | null },
): string {
  const cur = ctx.currency;
  const name = ctx.holdingName;
  const lines: string[] = [];
  if (draft.side === "split") {
    lines.push(`Split ${name} ${units(draft.ratio)} for 1 on ${shortDay(draft.tradeDate)}`);
  } else {
    const verb = draft.side === "buy" ? "Buy" : "Sell";
    const fees = Number(effect.fees ?? 0);
    lines.push(
      `${verb} ${units(effect.units)} ${name} at ${formatMoney(Number(effect.price), cur)} on ${shortDay(draft.tradeDate)}` +
        (fees > 0 ? `, brokerage ${formatMoney(fees, cur)}` : ""),
    );
  }
  if (ctx.newHolding) {
    const nh = ctx.newHolding;
    lines.push(
      `New holding: ${nh.name} (${ASSET_CLASS_WORDS[nh.asset_class] ?? nh.asset_class}, priced by ${PROVIDER_WORDS[nh.price_provider] ?? nh.price_provider} as ${nh.price_symbol}), paid from ${ctx.fundName}`,
    );
  }
  lines.push(holdingLine(ctx.ownerName ? `${ctx.ownerName}'s ${name}` : name, effect, cur));
  const money: string[] = [];
  if (draft.side === "sell" && effect.realised !== null && effect.realised !== undefined) {
    const realised = Number(effect.realised);
    money.push(realised < 0 ? `Loss ${formatMoney(-realised, cur)}` : `Profit ${formatMoney(realised, cur)}`);
  }
  const delta = Number(effect.funds_delta ?? 0);
  if (draft.side !== "split" && delta !== 0) money.push(`${ctx.fundName} ${signed(delta, cur)}`);
  if (money.length) lines.push(money.join(" · "));
  if (draft.side === "sell" && cur === "INR" && !draft.tax) {
    lines.push("Tax: to confirm from the broker's statement.");
  }
  const warnings = Array.isArray(effect.warnings) ? effect.warnings.map(String) : [];
  if (warnings.includes("possible_duplicate")) {
    lines.push("This looks like a trade already saved: same stock, units and price within two days. Save it again?");
  }
  if (warnings.includes("fund_below_zero")) {
    lines.push(
      `${ctx.fundName} would go to ${formatMoney(Number(effect.funds_balance_after), cur)}. If you added money, record that too; reply yes to save the trade anyway.`,
    );
  }
  if (warnings.includes("price_off_market") && ctx.lastPrice) {
    lines.push(`Check the price: ${name} was last ${formatMoney(ctx.lastPrice, cur)}.`);
  }
  if (warnings.includes("fund_confirmed_after")) {
    lines.push(`${ctx.fundName} is not moved: its balance was confirmed after this trade.`);
  }
  return `${lines.join("\n")}\n\n${ANSWER_HINT}`;
}

// The confirmation of undoing a trade, from preview_delete_trade's figures.
export function undoConfirmation(
  trade: { kind: string; units: number; price: number | null; trade_date: string; currency: string; holding_name: string },
  effect: Effect,
  fundName: string | null,
): string {
  const cur = trade.currency;
  const what = trade.kind === "split"
    ? `Split ${trade.holding_name} ${units(trade.units)} for 1 on ${shortDay(trade.trade_date)}`
    : `${trade.kind === "buy" ? "Buy" : "Sell"} ${units(trade.units)} ${trade.holding_name} at ${formatMoney(Number(trade.price), cur)} on ${shortDay(trade.trade_date)}`;
  const lines = [`Undo: ${what}`, holdingLine(trade.holding_name, effect, cur)];
  const delta = Number(effect.funds_delta ?? 0);
  if (fundName && delta !== 0) lines.push(`${fundName} ${signed(delta, cur)}`);
  return `${lines.join("\n")}\n\n${ANSWER_HINT}`;
}

// Why a trade was not saved, in one line, for every reason the database or
// the matching gives. Each says so plainly.
export function tradeRefusal(error: string, ctx: { holdingName: string; units?: number }): string {
  const name = ctx.holdingName;
  switch (error) {
    case "not_held":
      return `You don't hold ${name}, so nothing was saved.`;
    case "exceeds_units":
      return `That sells more ${name} than was held on that date${ctx.units ? ` (${units(ctx.units)})` : ""}, so nothing was saved.`;
    case "no_opening":
      return `${name} has no starting units and average yet, so nothing was saved. Set them in Wealth first.`;
    case "whole_units_only":
      return `Indian shares trade in whole units, so nothing was saved.`;
    case "fund_required":
      return `There's no broker funds account for ${name}'s money to come from or go to, so nothing was saved. Add one in Wealth, then send the trade again.`;
    case "not_broker_funds":
      return `${name}'s money has to go through a broker funds account, so nothing was saved.`;
    case "currency_mismatch":
      return `${name}'s broker funds account is in another currency, so nothing was saved.`;
    case "fund_archived":
      return `${name}'s broker funds account is closed, so nothing was saved.`;
    case "before_opening":
      return `That date is before ${name}'s trade history starts, so nothing was saved.`;
    case "bad_input":
      return `I couldn't make sense of that trade, so nothing was saved.`;
    default:
      return `I couldn't save that trade on ${name}, so nothing was saved.`;
  }
}
