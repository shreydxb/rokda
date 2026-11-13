// Part of the Telegram webhook (index.ts), split out by responsibility in
// the round 2 cleanup (SHR-383). Moved, not changed.
import { householdToday } from "../_shared/applib/day.js";
import { pickCategory } from "../_shared/applib/merchants.js";
import { logTelegramCall, postToAiService } from "./ai.ts";
import { OPENROUTER_API_KEY, PARSE_MODEL, supabase } from "./env.ts";
import { ALREADY_RECORDED_DAYS, alreadyRecordedAll } from "../_shared/applib/alreadyRecorded.js";
import { ReadFailed } from "./tools.ts";

export type IntakeKind = "expense" | "income" | "refund";

export const INTAKE_KIND_VALUES = new Set<IntakeKind>(["expense", "income", "refund"]);


export type ParsedItem = {
  merchant: string | null;
  amount: number | null;
  currency: string | null;
  occurred_at: string | null;
  categoryName: string | null;
  cardLast4: string | null;
  accountHint: string | null;
  confidence: number;
  kind: IntakeKind;
  // Whether the date came from the message itself. A bank SMS or receipt
  // with no date on it, pasted later, is not from today; see datedItems.
  dateStated: boolean;
  source: "bank_sms" | "receipt" | "typed";
};


export function parseItemFields(parsed: Record<string, unknown>): ParsedItem {
  const amount = typeof parsed.amount === "number" && Number.isFinite(parsed.amount) ? parsed.amount : null;
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;
  const occurredAt = typeof parsed.occurred_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.occurred_at) ? parsed.occurred_at : null;
  const currency = typeof parsed.currency === "string" && /^[A-Za-z]{3}$/.test(parsed.currency.trim()) ? parsed.currency.trim().toUpperCase() : null;
  const cardLast4 = typeof parsed.card_last4 === "string" && /^\d{4}$/.test(parsed.card_last4.trim()) ? parsed.card_last4.trim() : null;
  const accountHint = typeof parsed.account_hint === "string" && parsed.account_hint.trim() ? parsed.account_hint.trim() : null;
  // Defaults to 'expense' -- the model is asked for this explicitly (see the
  // prompt below), but an unrecognised or missing value must never silently
  // become something other than today's existing behaviour.
  const kind: IntakeKind = typeof parsed.kind === "string" && INTAKE_KIND_VALUES.has(parsed.kind as IntakeKind) ? (parsed.kind as IntakeKind) : "expense";

  return {
    merchant: typeof parsed.merchant === "string" && parsed.merchant.trim() ? parsed.merchant.trim() : null,
    amount,
    currency,
    occurred_at: occurredAt,
    categoryName: typeof parsed.category === "string" ? parsed.category : null,
    cardLast4,
    accountHint,
    confidence,
    kind,
    // A missing flag means the model followed the old contract, in which a
    // date it returned was one it read; only an explicit false says otherwise.
    dateStated: parsed.date_stated !== false && occurredAt !== null,
    source: parsed.source === "bank_sms" || parsed.source === "receipt" ? parsed.source : "typed",
  };
}


// Dates the items a message produced. A date written in the message is kept.
// Typed with no date ("12 coffee") means today, as it always has. But a bank
// SMS or receipt with no date on it was usually pasted some time after the
// payment: it is dated the day it was forwarded, when Telegram says, or else
// today, and flagged so the Inbox asks for the real date instead of it being
// confirmed with a guess.
export function datedItems(items: ParsedItem[], today: string, forwardedOn: string | null = null): Array<ParsedItem & { dateGuessed: boolean }> {
  return items.map((item) => {
    if (item.dateStated && item.occurred_at) return { ...item, dateGuessed: false };
    if (item.source === "typed") return { ...item, occurred_at: item.occurred_at ?? today, dateGuessed: false };
    return { ...item, occurred_at: forwardedOn ?? today, dateGuessed: true };
  });
}


// The day a forwarded message was first sent, in the household's time zone,
// or null when it was not forwarded. Telegram gives it as forward_origin.date
// (current) or forward_date (older clients), in Unix seconds.
export function forwardedDay(message: Record<string, unknown> | undefined): string | null {
  const origin = message?.forward_origin as Record<string, unknown> | undefined;
  const seconds = typeof origin?.date === "number" ? origin.date : typeof message?.forward_date === "number" ? message.forward_date : null;
  return seconds ? householdToday(new Date(seconds * 1000)) : null;
}


// The line added to a capture reply when some of what was sent had no date:
// which date it was given, and that it waits in the Inbox for the real one.
// Why one expense went to the Inbox rather than being offered for a quick
// "yes", in words the member can act on. "Got it — check the Inbox" read as
// if it had been recorded, so a payment sent without a merchant name
// silently waited there while the member assumed it was in.
export function inboxReason(
  row: { parsed_amount?: number | string | null; parsed_merchant?: string | null; parsed_account_id?: string | null; parsed_category_id?: string | null; parsed_currency?: string | null; confidence?: number | string | null },
  duplicate: { occurred_at: string } | null = null,
): string {
  if (duplicate) {
    return `Not recorded yet: it looks like one already in Rokda from ${duplicate.occurred_at}, so it's in the Inbox rather than recorded twice. Approve it there if it's a second charge.`;
  }
  const missing: string[] = [];
  if (!(Number(row.parsed_amount) > 0)) missing.push("the amount");
  if (!row.parsed_merchant) missing.push("who was paid");
  if (!row.parsed_account_id) missing.push("which card or account");
  if (!row.parsed_category_id) missing.push("the category");
  // Another currency is not something missing: the Inbox keeps that amount
  // and records the AED debited beside it, or an estimate until it is known
  // (docs/decisions.md, "A payment in rupees keeps both amounts").
  const foreign = row.parsed_currency && row.parsed_currency !== "AED" ? row.parsed_currency : null;
  const foreignNote = foreign ? ` It's in ${foreign}: approve it with the AED debited, or leave that blank to record an estimate at the day's rate.` : "";
  if (missing.length === 0) {
    return (Number(row.confidence ?? 0) < 0.85 && !foreign
      ? "Not recorded yet: I wasn't sure I read it right, so it's in the Inbox. Check it there and approve it."
      : "Not recorded yet: it's in the Inbox to check and approve.") + foreignNote;
  }
  const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} or ${missing[missing.length - 1]}`;
  return `Not recorded yet: I couldn't tell ${list}, so it's in the Inbox. Approve it there, or send it again with that added.${foreignNote}`;
}


// The line added when undated entries repeat records already made
// (_shared/applib/alreadyRecorded.js). Read in full: a read that fails says
// nothing, and the Inbox marks them all the same.
export async function alreadyRecordedNote(householdId: string, items: Array<{ parsed_account_id: string | null; parsed_amount: number | string | null; parsed_merchant: string | null; parsed_kind?: string | null; parsed_date: string | null; date_guessed: boolean }>): Promise<string> {
  const undated = items.filter((i) => i.date_guessed && i.parsed_account_id && i.parsed_date).map((i, k) => ({ ...i, id: `item-${k}` }));
  if (undated.length === 0) return "";
  const days = undated.map((i) => i.parsed_date!).sort();
  const latest = days.at(-1)!;
  const from = new Date(Date.parse(days[0]) - ALREADY_RECORDED_DAYS * 86400000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("transactions")
    .select("id, account_id, amount, kind, merchant, occurred_at")
    .eq("household_id", householdId)
    .in("account_id", [...new Set(undated.map((i) => i.parsed_account_id!))])
    .gte("occurred_at", from)
    .lte("occurred_at", latest);
  if (error) return "";
  // The items of one message, none of them recorded yet: nothing to leave out
  // as a sibling's record.
  const found = alreadyRecordedAll(undated, data ?? [], []);
  const repeats = undated.filter((i) => found.has(i.id));
  if (repeats.length === 0) return "";
  const named = repeats.slice(0, 3).map((i) => `${i.parsed_merchant}, AED ${Number(i.parsed_amount).toFixed(2)}`).join("; ");
  const more = repeats.length > 3 ? ` and ${repeats.length - 3} more` : "";
  return ` ${repeats.length} ${repeats.length === 1 ? "looks" : "look"} already recorded (${named}${more}): ${repeats.length === 1 ? "it's" : "they're"} marked in the Inbox, to set aside.`;
}

export function undatedNote(guessedDates: string[], total: number): string {
  if (guessedDates.length === 0) return "";
  const days = [...new Set(guessedDates)];
  const when = days.length === 1 ? `put on ${days[0]}` : "dated the day they were sent";
  if (total === 1) return ` It had no date, so it's ${when} for now — set the real date in the Inbox.`;
  const which = guessedDates.length === total ? "None had a date, so they're" : `${guessedDates.length} had no date, so those are`;
  return ` ${which} ${when} for now — set the real dates in the Inbox.`;
}


// Calls OpenRouter (Gemini 2.5 Flash Lite: cheap, vision-capable, reliable
// instruction-following) to extract structured line items from raw text
// and/or a receipt photo -- including a forwarded/copy-pasted bank SMS,
// which has its own fairly rigid format ("AED 38.80 spent on card ending
// 1234 at FILLI CAFE on 05-09-26") that the model is told about explicitly
// rather than left to guess at like free-form text. A message can describe
// more than one expense ("bought two plants for 260 and 50") -- this
// returns one item per distinct amount rather than summing or silently
// keeping only the first, which is what a single-object result used to do.
// Returns null on any failure -- the caller degrades to "raw content, no
// suggestions" rather than blocking on this.
export async function parseIntakeWithAI(params: {
  rawText: string | null;
  imageBase64: string | null;
  imageMime: string | null;
  categoryNames: string[];
  householdId?: string | null;
  memberId?: string | null;
}): Promise<ParsedItem[] | null> {
  if (!OPENROUTER_API_KEY) return null;
  const { rawText, imageBase64, imageMime, categoryNames, householdId = null, memberId = null } = params;
  if (!rawText && !imageBase64) return null;

  // Dubai, not UTC. This is the date the parser dates an expense to, so
  // deriving it from a UTC runtime filed everything logged between
  // midnight and 04:00 Dubai under the previous day -- in the ledger,
  // permanently, with nothing downstream to notice.
  const today = householdToday();
  // The household's own account and card names, so a hint comes back as one
  // of them ("marriot" -> "ENBD Marriott") rather than as whatever was typed.
  const accountNames = householdId ? await openAccountNames(householdId) : [];
  const instructions =
    `Extract ALL household expenses/income/refunds described in the message and/or receipt photo below. Most messages describe exactly one, but some describe several separate amounts (e.g. "bought two plants for 260 and 50" is TWO expenses -- never sum multiple amounts into one, and never drop any of them). ` +
    `The message may be free-form text, or a bank/card SMS notification copy-pasted verbatim (e.g. "AED 38.80 spent on your card ending 1234 at FILLI CAFE LLC DXB on 05-09-26 14:32") -- extract from either the same way; a bank SMS almost always describes exactly one. ` +
    `Today's date is ${today}. ` +
    `Respond with ONLY a JSON object, no markdown, matching exactly: ` +
    `{"items": [{"merchant": string|null, "amount": number|null, "currency": string|null, "occurred_at": "YYYY-MM-DD"|null, "date_stated": boolean, "source": "bank_sms"|"receipt"|"typed", "category": string|null, "card_last4": string|null, "account_hint": string|null, "confidence": number, "kind": "expense"|"income"|"refund"}, ...]} ` +
    `"occurred_at" is the date written in the message or on the receipt, with relative words ("yesterday", "on Friday") resolved against today's date; "date_stated" is true only then. When no date is written anywhere, "occurred_at" is null and "date_stated" is false -- never fill in today's date yourself. ` +
    `"source" is "bank_sms" for a bank or card notification pasted in, "receipt" for a receipt photo, and "typed" for anything a person wrote themselves. ` +
    `One item per distinct amount. Shared details (date, account, merchant if it applies to all) should be repeated on every item rather than left null just because it was only stated once in the message. ` +
    `"kind" is "expense" if money left the account (a purchase, a bill paid, an EMI) -- this is the default for almost everything. "income" if money arrived that ISN'T tied to a specific earlier expense (a salary credit, a gift received, interest, cashback treated as a reward rather than a refund). "refund" if money came back specifically because an earlier purchase was returned, cancelled or reimbursed (e.g. "got a refund from Noon for the return", "airline refunded my ticket"). When genuinely unsure between income and refund, prefer "income" -- a refund wrongly filed as income is a smaller mistake than one that tries and fails to link to a specific past purchase. ` +
    `"currency" is the real currency of the amount if stated or clearly implied (e.g. "AED", "USD", "INR") -- null if genuinely unstated. Never assume AED just because the household is AED-based -- only state it if the message actually says or implies it. ` +
    `"merchant" is who was paid: the shop, service, company or biller the message names, even in passing and in lower case ("du" in "du wifi paid today", "DEWA" in "dewa bill 500", "Careem" in "careem 19"). When the message names no one, give a short description of what was paid for instead ("Flight ticket", "Haircut"). Use null only when there is nothing at all to go on. ` +
    `"card_last4" is the last 4 digits of a card mentioned (e.g. "card ending 1234", "card no. ...1234"), or null if none is mentioned. ` +
    `"account_hint" is the account/card NAME mentioned in the message, if any (e.g. "Wio", "FAB Z", "ENBD Noon", "FAB Islamic") -- a short free-text name, not digits, or null if no account/card is named. ` +
    (accountNames.length
      ? `The household's accounts and cards are ${JSON.stringify(accountNames)}: when the message names one of them, even misspelt or shortened (e.g. "marriot" for "ENBD Marriott"), "account_hint" MUST be that name exactly as listed. A word that is plainly the merchant or what was bought is not an account. `
      : "") +
    `"category" MUST be exactly one of these household categories, verbatim, or null if none clearly fits -- never invent a category name: ` +
    `${JSON.stringify(categoryNames)}. ` +
    `This list mixes broad categories (e.g. "Transport") with specific subcategories of them (e.g. "Salik / Parking / Misc", "Car EMI", "Fuel" -- all under Transport). Always prefer the most specific one that clearly fits over its broader parent: a toll/parking charge is "Salik / Parking / Misc", not "Transport"; a car loan instalment is "Car EMI", not "Transport". Only fall back to the broad parent when nothing more specific applies (e.g. a taxi fare, which fits none of Transport's subcategories). ` +
    `Noon is three different services, told apart by the name the payment shows: "Noon Minutes" (or "Minutes") is grocery delivery -- a groceries category; plain "Noon" on its own is Noon Food, restaurant delivery -- a food or dining category; "noon.com" (or "Noon.com") is the marketplace -- a shopping category. Apply this unless the message itself says what was bought. ` +
    `"confidence" is your own confidence in this extraction, 0 to 1. ` +
    `If you cannot determine a field, use null rather than guessing.`;

  const content: Array<Record<string, unknown>> = [{ type: "text", text: instructions }];
  if (rawText) content.push({ type: "text", text: `Message: ${rawText}` });
  if (imageBase64 && imageMime) {
    content.push({ type: "image_url", image_url: { url: `data:${imageMime};base64,${imageBase64}` } });
  }

  const startedAt = Date.now();
  try {
    const body = await postToAiService(
      "parse_intake",
      { model: PARSE_MODEL, messages: [{ role: "user", content }], response_format: { type: "json_object" } },
      householdId,
      memberId,
    );
    if (!body) return null;
    const raw = body?.choices?.[0]?.message?.content;
    if (typeof raw !== "string") return null;
    const parsedBody = JSON.parse(raw);

    // Tolerate a flat single-object response (older shape, or the model
    // ignoring the wrapper) by treating it as a one-item array.
    const rawItems: unknown[] = Array.isArray(parsedBody?.items) ? parsedBody.items : [parsedBody];
    const items = rawItems
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map(parseItemFields)
      .filter((item) => item.amount !== null || item.merchant !== null);

    if (items.length > 0) return items;
    // Read, and nothing found: an empty list, which is not the null of a
    // read that failed. The caller keeps a message it could not read and
    // answers one that held nothing. Only the model's own empty list says
    // "nothing": an answer in another shape, or items it gave that could not
    // be used, is a failed read.
    return Array.isArray(parsedBody?.items) && parsedBody.items.length === 0 ? [] : null;
  } catch {
    await logTelegramCall({
      callKind: "parse_intake",
      householdId,
      memberId,
      model: PARSE_MODEL,
      latencyMs: Date.now() - startedAt,
      success: false,
      errorType: "exception",
    });
    return null;
  }
}


// The question tools the router can call, each answered by index.ts's
// routing from the read-only functions in tools.ts.
export const QUESTION_TOOLS = new Set([
  "get_category_spend",
  "get_net_worth",
  "get_account_balance",
  "get_upcoming_bills",
  "get_budget_status",
  "get_holdings",
  "get_trade_profit",
  "log_goal_contribution",
  "log_transfer",
  "update_account_balances",
]);


// A card account's name follows the "Name •1234" convention (see
// accountOptionLabel in the frontend) -- if a bank SMS names a card ending,
// match it against that suffix. Only trusted when it resolves to exactly
// one open account; otherwise the reviewer picks manually, same as today.
// A broker's uninvested cash (a broker funds account) is the household's
// money but never where an expense was paid from: "paid on Wio" must not land
// in the broker's funds (SHR-367). Everything else can be.
export function isSpendingAccount(a: { type?: string | null }): boolean {
  return a.type !== "broker_funds";
}


export async function matchAccountByCardLast4(householdId: string, cardLast4: string | null): Promise<{ id: string; name: string } | null> {
  if (!cardLast4) return null;
  const { data: accounts } = await supabase.from("accounts").select("id, name, type").eq("household_id", householdId).is("archived_at", null);
  const matches = (accounts ?? []).filter((a: { name: string; type: string }) => isSpendingAccount(a) && a.name.includes(cardLast4));
  return matches.length === 1 ? matches[0] : null;
}


// An account name's own "•1234" card suffix is never what gets said out loud
// ("paid via FAB Z", not "paid via FAB Z bullet nine four one seven") -- strip
// it before comparing so the base name is what actually has to match.
export function accountBaseName(name: string): string {
  return name.replace(/\s*•\s*\d+\s*$/, "").trim().toLowerCase();
}


// A plain account/card name mentioned in free text (e.g. "paid on Wio",
// "via FAB Z") -- with only one card per bank the last-4-digits suffix is
// rarely worth typing, so this matches on name alone. Deliberately
// one-directional (the account's own base name must contain the hint, never
// the reverse): "FAB Islamic" said in a message should match the account
// named "FAB Islamic Etihad" (a shortened mention of the fuller name), but
// "FAB Z" must NOT match a bare account named plain "FAB" just because "FAB"
// is a prefix of "FAB Z" -- the reverse direction would let a short, generic
// account name silently swallow a longer, more specific one. Same safety bar
// as the card-last4 match either way: only trusted when it resolves to
// exactly one open account, so a name two accounts share (the household
// currently has two bare "FAB" and two bare "WIO" accounts alongside the
// named cards) abstains rather than guessing which one.
export async function matchAccountByNameHint(householdId: string, hint: string | null): Promise<{ id: string; name: string } | null> {
  if (!hint?.trim()) return null;
  const { data: accounts } = await supabase.from("accounts").select("id, name, type").eq("household_id", householdId).is("archived_at", null);
  return pickAccountByHint(((accounts ?? []) as Array<{ id: string; name: string; type: string }>).filter(isSpendingAccount), hint);
}


// Words said around a card's name that are not part of it ("my marriott
// card", "via FAB Z credit card").
export const HINT_FILLER = new Set(["card", "cards", "credit", "debit", "account", "a/c", "acc", "bank", "via", "on", "the", "my", "using", "with", "from", "cc"]);


// One typo apart: a letter added, dropped or changed.
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}


// The account a spoken or typed hint names, or null. Exact containment first,
// as before. Failing that, every word of the hint (filler aside) must match a
// word of the account's name: the whole word, the start of it ("marriot" in
// "marriott", at least three letters) or within one typo (five letters or
// more). Still
// one-directional and still only trusted when exactly one open account fits,
// so "FAB Z" never matches a plain "FAB" and a name two accounts share
// abstains.
export function pickAccountByHint<T extends { name: string }>(accounts: T[], hint: string): T | null {
  const norm = hint.trim().toLowerCase();
  if (!norm) return null;
  const exact = accounts.filter((a) => {
    const base = accountBaseName(a.name);
    return base.length > 1 && base.includes(norm);
  });
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const words = norm.split(/[\s•]+/).filter((w) => w && !HINT_FILLER.has(w) && !/^\d+$/.test(w));
  if (!words.length) return null;
  const fuzzy = accounts.filter((a) => {
    const baseWords = accountBaseName(a.name).split(/\s+/).filter(Boolean);
    return words.every((w) => baseWords.some((b) => w === b || (w.length >= 3 && b.startsWith(w)) || (w.length >= 5 && withinOneEdit(w, b))));
  });
  return fuzzy.length === 1 ? fuzzy[0] : null;
}


// Base names of the household's open accounts, for the parser to choose from.
export async function openAccountNames(householdId: string): Promise<string[]> {
  try {
    const { data } = await supabase.from("accounts").select("name").eq("household_id", householdId).is("archived_at", null);
    return [...new Set(((data ?? []) as Array<{ name: string }>).map((a) => a.name.replace(/\s*•\s*\d+\s*$/, "").trim()).filter(Boolean))];
  } catch {
    return [];
  }
}


// The household's own view of a merchant outweighs the model's fresh guess
// (docs/decisions.md, "The bot categorises from the household's own history").
// A rule someone wrote in Settings wins; then the category the household used
// most for the same merchant across all of its history, read through
// merchant_category_counts() so a statement's "EPPCO SITE 1077" and a typed
// "eppco" are one merchant (applib/merchants.js). It used to read only the
// latest 200 transactions, and never the rules. The match is one-directional
// (applib/merchants.js, tested there): a shortened name inherits from a fuller
// one, but a brand never inherits from its own sub-service ("Noon" is not
// "Noon Minutes").

export type CategoryKnowledge = {
  rules: Array<{ pattern: string; match_type: string; category_id: string; archived?: boolean }>;
  history: Array<{ merchant: string; category_id: string; uses: number; last_used: string | null }>;
};


// Read once per message, however many items it holds. A failed read leaves
// that half empty: the model's guess still stands, as it did before.
export async function loadCategoryKnowledge(householdId: string): Promise<CategoryKnowledge> {
  const PAGE = 1000;
  const history: CategoryKnowledge["history"] = [];
  for (let from = 0; from < 20 * PAGE; from += PAGE) {
    const { data, error } = await supabase.rpc("merchant_category_counts", { p_household_id: householdId }).range(from, from + PAGE - 1);
    if (error || !Array.isArray(data)) break;
    history.push(...(data as CategoryKnowledge["history"]));
    if (data.length < PAGE) break;
  }
  const { data: rules } = await supabase
    .from("category_rules")
    .select("pattern, match_type, category_id, archived")
    .eq("household_id", householdId)
    .eq("archived", false)
    .order("created_at");
  return { rules: (rules ?? []) as CategoryKnowledge["rules"], history };
}


export async function matchCategoryFromMerchantHistory(knowledge: CategoryKnowledge, merchant: string | null): Promise<{ id: string; name: string } | null> {
  const pick = pickCategory(merchant, knowledge);
  if (!pick) return null;
  const { data: category } = await supabase.from("categories").select("id, name, archived").eq("id", pick.categoryId).maybeSingle();
  if (!category || (category as { archived?: boolean }).archived) return null;
  return { id: (category as { id: string }).id, name: (category as { name: string }).name };
}


// Same check as src/lib/duplicates.js findDuplicate (merchant + amount +
// account, within 3 days), ported server-side. The Inbox review screen
// already flags this, but the "yes"/reaction fast-confirm path skips the
// Inbox entirely -- without this, a resent message with everything already
// resolved could get confirmed straight into a second real transaction with
// no warning at all. A check that cannot read throws ReadFailed, and every
// caller then leaves the entry in the Inbox.
export async function findDuplicateTransaction(
  householdId: string,
  accountId: string | null,
  merchant: string | null,
  amount: number | string | null,
  occurredAt: string | null
): Promise<{ id: string; amount: number; occurred_at: string } | null> {
  const normMerchant = merchant?.trim().toLowerCase();
  const numAmount = amount != null ? Number(amount) : null;
  if (!accountId || !normMerchant || !numAmount || !occurredAt) return null;
  const occurred = new Date(occurredAt).getTime();
  const DAY_MS = 24 * 60 * 60 * 1000;

  // Only the days that could match, so an account's whole history never has
  // to fit in one response.
  const day = (offset: number) => new Date(occurred + offset * DAY_MS).toISOString().slice(0, 10);
  const { data: rows, error } = await supabase
    .from("transactions")
    .select("id, amount, merchant, occurred_at")
    .eq("household_id", householdId)
    .eq("account_id", accountId)
    .gte("occurred_at", day(-4))
    .lte("occurred_at", day(4));
  if (error) throw new ReadFailed("transactions");

  const match = (rows ?? []).find((t: { amount: number; merchant: string | null; occurred_at: string }) => {
    if ((t.merchant ?? "").trim().toLowerCase() !== normMerchant) return false;
    if (Math.abs(Math.abs(Number(t.amount)) - numAmount) > 0.01) return false;
    const diffDays = Math.abs(new Date(t.occurred_at).getTime() - occurred) / DAY_MS;
    return diffDays <= 3;
  });
  return match ? { id: match.id, amount: Number(match.amount), occurred_at: match.occurred_at } : null;
}
