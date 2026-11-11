// Part of the Telegram webhook (index.ts), split out by responsibility in
// the round 2 cleanup (SHR-383). Moved, not changed.
import { householdToday } from "../_shared/applib/day.js";
import { PENDING_WINDOW_MS, sendProposal } from "./confirmations.ts";
import { supabase } from "./env.ts";
import { allRowsOf, ReadFailed } from "./tools.ts";
import { applyAnswer, draftFromArgs, HoldingLite, matchHoldings, newHoldingFor, nextQuestion, normaliseSymbol, tradeConfirmation, TradeDraft, tradeRefusal, undoConfirmation } from "./trades.ts";
import { reply, tgCall } from "./transport.ts";

// ---------------------------------------------------------------------------
// Share trades (SHR-370; docs/decisions.md, "The bot records trades"). The
// router reads a trade message (log_trade); trades.ts matches it to the
// member's holding and asks for anything missing; the database previews it;
// and it is proposed with the preview's own figures. Nothing is saved until
// the sender says yes.
// ---------------------------------------------------------------------------

export const TRADE_HOLDING_COLUMNS =
  "id, name, currency, asset_class, price_symbol, price_provider, owner_member_id, funds_account_id, trades_version, quantity, current_price";


// Every holding in the household, as the trade helpers match them. Read in
// pages, so a failed or partial read is never matched against.
export async function tradeHoldings(householdId: string): Promise<HoldingLite[]> {
  const rows = await allRowsOf<HoldingLite>("holdings", () =>
    supabase.from("holdings").select(TRADE_HOLDING_COLUMNS).eq("household_id", householdId).order("id")
  );
  return rows.map((h) => ({
    ...h,
    trades_version: Number(h.trades_version ?? 0),
    quantity: h.quantity === null || h.quantity === undefined ? null : Number(h.quantity),
    current_price: h.current_price === null || h.current_price === undefined ? null : Number(h.current_price),
  }));
}


export async function householdMembers(householdId: string): Promise<Array<{ id: string; display_name: string }>> {
  return await allRowsOf("household_members", () =>
    supabase.from("household_members").select("id, display_name").eq("household_id", householdId).order("id")
  );
}


export const TRADE_READ_FAILED = "I couldn't read your holdings just now, so nothing was saved. Please send it again in a minute.";


// Telegram lets a bot download files up to 20 MB; a bigger one cannot be
// fetched however often the update is retried.
export const FILE_TOO_BIG = "That file is too big for me to fetch: Telegram lets bots download files up to 20 MB. Send a smaller photo or a screenshot, or type it.";

export const FILE_TOO_BIG_CAPTION_KEPT = "That file is too big for me to fetch: Telegram lets bots download files up to 20 MB. I've kept its caption; send a smaller photo or a screenshot to add the receipt.";


// Why a trade message could not even be drafted.
export function tradeDraftError(error: string, args: Record<string, unknown>): string {
  switch (error) {
    case "future_date":
      return "That date hasn't happened yet, so nothing was saved. Send it again with the day of the trade.";
    case "unknown_member":
      return `I don't know a member called ${String(args.member ?? "").trim()}, so nothing was saved.`;
    case "no_side":
      return "Was that a buy, a sale or a split? Nothing was saved; send it again saying which.";
    default:
      return "Which share was that? Nothing was saved; send it again with its name or symbol.";
  }
}


// A trade message: drafted from the router's arguments, matched to the
// owner's holding, and then asked about (the first thing missing) or
// previewed and proposed. A sale or split of a share not held stops here.
export async function handleTradeMessage(
  chatId: number,
  member: { id: string; household_id: string },
  args: Record<string, unknown>,
  updateId: unknown,
): Promise<void> {
  let members: Array<{ id: string; display_name: string }>;
  let holdings: HoldingLite[];
  try {
    members = await householdMembers(member.household_id);
    holdings = await tradeHoldings(member.household_id);
  } catch (err) {
    if (!(err instanceof ReadFailed)) throw err;
    await reply(chatId, TRADE_READ_FAILED);
    return;
  }
  const draft = draftFromArgs(args, { senderId: member.id, members, today: householdToday() });
  if ("error" in draft) {
    await reply(chatId, tradeDraftError(draft.error, args));
    return;
  }
  const matches = matchHoldings(holdings, draft.ownerMemberId, draft.stock);
  if (matches.length === 1) draft.holdingId = matches[0].id;
  else if (matches.length > 1) draft.candidates = matches.map((h) => h.id);
  else if (draft.side !== "buy") {
    await reply(chatId, tradeRefusal("not_held", { holdingName: normaliseSymbol(draft.stock) || draft.stock }));
    return;
  }
  const question = nextQuestion(draft, holdings);
  if (question) {
    await askTradeQuestion(chatId, member, draft, question, updateId);
    return;
  }
  await proposeTrade(chatId, member, draft, updateId);
}


// "undo last trade": proposes deleting the sender's most recent trade (not a
// fresh start's opening entry), previewed by the database: the holding and
// the fund as they would be after it. Anything older is fixed in the app.
export async function handleUndoTrade(chatId: number, member: { id: string; household_id: string }, updateId: unknown): Promise<void> {
  const { data: trades, error } = await supabase.from("holding_trades")
    .select("id, holding_id, kind, units, price, trade_date, funds_account_id, created_at")
    .eq("household_id", member.household_id).eq("created_by", member.id).neq("kind", "opening")
    .order("created_at", { ascending: false }).limit(1);
  if (error) {
    await reply(chatId, TRADE_READ_FAILED);
    return;
  }
  const trade = (trades ?? [])[0] as
    | { id: string; holding_id: string; kind: string; units: number; price: number | null; trade_date: string; funds_account_id: string | null }
    | undefined;
  if (!trade) {
    await reply(chatId, "You have no trades to undo.");
    return;
  }
  let holdings: HoldingLite[];
  let funds: Array<{ id: string; name: string }>;
  try {
    holdings = await tradeHoldings(member.household_id);
    funds = await allRowsOf("accounts", () =>
      supabase.from("accounts").select("id, name").eq("household_id", member.household_id).eq("type", "broker_funds").order("id")
    );
  } catch (err) {
    if (!(err instanceof ReadFailed)) throw err;
    await reply(chatId, TRADE_READ_FAILED);
    return;
  }
  const holding = holdings.find((h) => h.id === trade.holding_id);
  const name = holding?.name ?? "that holding";
  const { data: effect, error: previewError } = await supabase.rpc("preview_delete_trade", { p_trade_id: trade.id, p_member_id: member.id });
  if (previewError || !effect) {
    await reply(chatId, "I couldn't check that undo just now, so nothing was undone. Please ask again in a minute.");
    return;
  }
  if (!effect.ok) {
    // Undoing a buy a later sale depended on would leave that sale selling
    // more than was held.
    await reply(chatId, effect.error === "exceeds_units"
      ? `Undoing that would leave a later sale of ${name} selling more than was held, so nothing was undone. Fix it in the app.`
      : tradeRefusal(String(effect.error), { holdingName: name }).replace("nothing was saved", "nothing was undone"));
    return;
  }
  const fundName = trade.funds_account_id ? funds.find((f) => f.id === trade.funds_account_id)?.name ?? null : null;
  const currency = holding?.currency ?? "USD";
  const undone = {
    kind: trade.kind,
    units: Number(trade.units),
    price: trade.price === null ? null : Number(trade.price),
    trade_date: trade.trade_date,
    currency,
    holding_name: name,
  };
  await sendProposal(
    chatId,
    member.household_id,
    member.id,
    "trade_undo",
    { trade_id: trade.id, expected_version: holding?.trades_version ?? null, ...undone, fund_name: fundName },
    undoConfirmation(undone, effect, fundName),
    updateId,
  );
}


// What to say when a reply to a trade question does not answer it.
export const NOT_AN_ANSWER: Record<string, string> = {
  units: "I need a number, like 10 or 2.5.",
  price: "I need a price per share, like 150 or 150.5.",
  holding: "Reply with the holding's number from the list.",
  currency: "Reply dollars or rupees.",
};


// Asks the one thing a trade is missing, keeping the trade as the member's
// 'asking' row until it is answered. A new trade message replaces a draft
// still asking: one trade is asked about at a time. The question's message id
// is recorded, so a reply to it names the draft.
export async function askTradeQuestion(
  chatId: number,
  member: { id: string; household_id: string },
  draft: TradeDraft,
  question: { field: string; text: string },
  updateId: unknown,
  askingId: string | null = null,
  askedBefore: number[] = [],
): Promise<void> {
  // This update counts as having used the draft, as an answer does: if the
  // question below never reaches the member and Telegram delivers the
  // message again, it is read as a redelivery and the question is asked
  // afresh, not taken for an answer to a question nobody saw. This update,
  // not an earlier one the draft remembers: a stale "yes" asks again about
  // an older draft (the fresh review of the second group, R1).
  const lastUpdateId = typeof updateId === "number" ? updateId : draft.lastUpdateId ?? null;
  const payload = { draft: { ...draft, awaiting: question.field, lastUpdateId }, asked_at: new Date().toISOString(), asked_message_ids: askedBefore };
  let id = askingId;
  if (id) {
    const updated = await supabase.from("bot_proposals").update({ payload }).eq("id", id).eq("status", "asking").select("id");
    if (updated.error) throw new Error(`updating a trade question failed (${updated.error.code ?? "no code"})`);
  } else {
    const dropped = await supabase.from("bot_proposals").delete()
      .eq("household_id", member.household_id).eq("member_id", member.id).eq("status", "asking");
    if (dropped.error) throw new Error(`replacing a trade question failed (${dropped.error.code ?? "no code"})`);
    const inserted = await supabase.from("bot_proposals").insert({
      household_id: member.household_id,
      member_id: member.id,
      kind: "trade",
      status: "asking",
      payload,
      chat_id: chatId,
      source_ref: typeof updateId === "number" ? String(updateId) : null,
    }).select("id").single();
    if (inserted.error || !inserted.data) throw new Error(`saving a trade question failed (${inserted.error?.code ?? "no row"})`);
    id = (inserted.data as { id: string }).id;
  }
  // A question Telegram refused, or whose id could not be recorded, is not
  // an asked question: the update is thrown back so Telegram delivers the
  // message again, and the redelivery asks it afresh (see lastUpdateId
  // above). Without its id, a reply to the question would reach nothing.
  // Every question of the draft is kept, so a reply to an earlier one still
  // reaches it once the next has been asked.
  const messageId = await reply(chatId, question.text);
  if (messageId == null) throw new Error("the trade question was not delivered");
  const bound = { prompt_message_id: messageId, payload: { ...payload, asked_message_ids: [...askedBefore, messageId] } };
  let recorded = await supabase.from("bot_proposals").update(bound).eq("id", id);
  if (recorded.error) recorded = await supabase.from("bot_proposals").update(bound).eq("id", id);
  if (recorded.error) {
    // Withdrawn, so the member does not answer a question nothing can match.
    await tgCall("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => {});
    throw new Error(`recording the trade question failed (${recorded.error.code ?? "no code"})`);
  }
}


// Reads a message as the answer to the member's trade question, if it is one:
// a reply to the question, or their next message soon after it that reads as
// an answer. True when the message was taken as the answer (or a reply to the
// question that did not answer it, which is told what is needed). Anything
// else is left to be handled as a message of its own, and the draft waits.
export async function answerTradeQuestion(
  chatId: number,
  member: { id: string; household_id: string },
  text: string,
  repliedTo: number | null,
  updateId: unknown,
): Promise<boolean> {
  // Telegram delivering again an answer that already completed a trade: the
  // proposal it made is this update's, and it is not proposed twice, nor
  // taken for a message of its own.
  if (typeof updateId === "number") {
    const made = await supabase.from("bot_proposals").select("id, status, payload, prompt_message_id")
      .eq("household_id", member.household_id).eq("member_id", member.id).eq("kind", "trade")
      .eq("source_ref", String(updateId)).neq("status", "asking").maybeSingle();
    if (made.data) {
      const row = made.data as { status: string; payload: { draft?: TradeDraft }; prompt_message_id: number | null };
      if (row.status === "proposed" && row.prompt_message_id == null && row.payload.draft) {
        await proposeTrade(chatId, member, row.payload.draft, updateId);
      }
      return true;
    }
  }
  // A reply names its draft by any of the draft's questions; otherwise the
  // member's latest draft is the one an answer could be for.
  let query = supabase.from("bot_proposals").select("id, payload, prompt_message_id")
    .eq("household_id", member.household_id).eq("member_id", member.id).eq("chat_id", chatId)
    .eq("kind", "trade").eq("status", "asking").gt("expires_at", new Date().toISOString());
  query = repliedTo != null
    ? query.contains("payload", { asked_message_ids: [repliedTo] })
    : query.order("created_at", { ascending: false });
  const { data, error } = await query.limit(1);
  if (error || !data?.length) return false;
  const row = data[0] as { id: string; payload: { draft?: TradeDraft; asked_at?: string; asked_message_ids?: number[] } };
  const draft = row.payload.draft;
  if (!draft?.awaiting) return false;
  const asked = row.payload.asked_message_ids ?? [];
  // The same answer delivered again, however late and in whatever form: it
  // was used once already, so the question it led to is asked again, and the
  // answer is not used for it. Checked before anything else can turn it away.
  const redelivered = draft.lastUpdateId != null && draft.lastUpdateId === updateId;
  // A message that is not a reply counts only soon after the question.
  if (!redelivered && repliedTo == null && !(Date.parse(row.payload.asked_at ?? "") > Date.now() - PENDING_WINDOW_MS)) return false;
  let holdings: HoldingLite[];
  try {
    holdings = await tradeHoldings(member.household_id);
  } catch (err) {
    if (!(err instanceof ReadFailed)) throw err;
    await reply(chatId, TRADE_READ_FAILED);
    return true;
  }
  if (redelivered) {
    const again = nextQuestion(draft, holdings);
    if (again) await askTradeQuestion(chatId, member, draft, again, updateId, row.id, asked);
    return true;
  }
  const answered = applyAnswer(draft, text, holdings);
  if (!answered) {
    if (repliedTo == null) return false;
    await reply(chatId, NOT_AN_ANSWER[draft.awaiting] ?? NOT_AN_ANSWER.units);
    return true;
  }
  answered.lastUpdateId = typeof updateId === "number" ? updateId : null;
  const question = nextQuestion(answered, holdings);
  if (question) {
    await askTradeQuestion(chatId, member, answered, question, updateId, row.id, asked);
    return true;
  }
  await proposeTrade(chatId, member, answered, updateId);
  // The draft gives way to the proposal (or to the refusal proposeTrade sent).
  await supabase.from("bot_proposals").delete().eq("id", row.id).eq("status", "asking");
  return true;
}


// Previews a complete draft in the database and proposes it with the
// preview's figures, or says why the database refused it. The proposal
// carries the version the member was shown, so a yes after the holding has
// changed is refused as stale rather than saving figures they never saw. It
// also carries the draft, so a stale or lapsed one can be previewed again,
// and the names the messages about it use.
export async function proposeTrade(
  chatId: number,
  member: { id: string; household_id: string },
  draft: TradeDraft,
  updateId: unknown,
): Promise<void> {
  let holdings: HoldingLite[];
  let members: Array<{ id: string; display_name: string }>;
  let funds: Array<{ id: string; name: string; currency: string; owner_member_id: string | null; archived_at: string | null }>;
  try {
    holdings = await tradeHoldings(member.household_id);
    members = await householdMembers(member.household_id);
    funds = await allRowsOf("accounts", () =>
      supabase.from("accounts").select("id, name, currency, owner_member_id, archived_at")
        .eq("household_id", member.household_id).eq("type", "broker_funds").order("id")
    );
  } catch (err) {
    if (!(err instanceof ReadFailed)) throw err;
    await reply(chatId, TRADE_READ_FAILED);
    return;
  }
  let holding = draft.holdingId ? holdings.find((h) => h.id === draft.holdingId) ?? null : null;
  if (!holding) {
    // Matched again: a first buy of a stock the member holds by now (another
    // first buy confirmed in between) goes into that holding, not a second.
    const matches = matchHoldings(holdings, draft.ownerMemberId, draft.stock);
    if (matches.length > 1) {
      const which = { ...draft, holdingId: null, candidates: matches.map((h) => h.id), newHolding: null };
      const question = nextQuestion(which, holdings);
      if (question) {
        await askTradeQuestion(chatId, member, which, question, updateId);
        return;
      }
    }
    if (matches.length === 1) {
      holding = matches[0];
      draft = { ...draft, holdingId: holding.id, newHolding: null };
    }
  }
  const ownerId = holding?.owner_member_id ?? draft.ownerMemberId;
  const ownerName = ownerId && ownerId !== member.id ? members.find((m) => m.id === ownerId)?.display_name ?? null : null;
  const fundNamed = (id: unknown) => funds.find((f) => f.id === id)?.name ?? "the broker funds account";

  if (!holding) {
    if (draft.side !== "buy") {
      await reply(chatId, tradeRefusal("not_held", { holdingName: normaliseSymbol(draft.stock) || draft.stock }));
      return;
    }
    // A first buy of a stock: previewed on the holding it would make, with
    // its feed symbol, class and fund shown for the member to confirm.
    const currency = draft.newHolding?.currency ?? (draft.priceCurrency === "USD" || draft.priceCurrency === "INR" ? draft.priceCurrency : null);
    if (!currency) {
      const question = nextQuestion(draft, holdings);
      if (question) await askTradeQuestion(chatId, member, draft, question, updateId);
      return;
    }
    const newHolding = draft.newHolding ?? newHoldingFor(draft.stock, currency, draft.ownerMemberId, funds);
    const first = { ...draft, newHolding };
    const { data: effect, error } = await supabase.rpc("preview_new_holding_trade", {
      p_new_holding: newHolding,
      p_trade_date: draft.tradeDate,
      p_units: draft.units,
      p_price: draft.price,
      p_fees: draft.fees,
      p_traded_at: draft.tradedAt,
      p_member_id: member.id,
    });
    if (error || !effect) {
      await reply(chatId, "I couldn't check that trade just now, so nothing was saved. Please send it again in a minute.");
      return;
    }
    if (!effect.ok) {
      await reply(chatId, tradeRefusal(String(effect.error), { holdingName: newHolding.name, units: draft.units ?? undefined }));
      return;
    }
    const fundName = fundNamed(effect.funds_account_id);
    await sendProposal(
      chatId,
      member.household_id,
      member.id,
      "trade",
      {
        new_holding: newHolding,
        kind: "buy",
        trade_date: draft.tradeDate,
        traded_at: draft.tradedAt,
        units: draft.units,
        price: draft.price,
        fees: draft.fees,
        funds_account_id: null,
        draft: first,
        holding_name: newHolding.name,
        currency: newHolding.currency,
        fund_name: fundName,
      },
      tradeConfirmation(first, effect, {
        holdingName: newHolding.name,
        ownerName,
        fundName,
        currency: newHolding.currency,
        newHolding,
        today: householdToday(),
      }),
      updateId,
    );
    return;
  }

  const split = draft.side === "split";
  const { data: effect, error } = await supabase.rpc("preview_trade", {
    p_holding_id: holding.id,
    p_kind: draft.side,
    p_trade_date: draft.tradeDate,
    p_units: split ? draft.ratio : draft.units,
    p_price: split ? null : draft.price,
    p_fees: draft.fees,
    p_tax_withheld: draft.tax ?? 0,
    p_traded_at: draft.tradedAt,
    p_member_id: member.id,
  });
  if (error || !effect) {
    await reply(chatId, "I couldn't check that trade just now, so nothing was saved. Please send it again in a minute.");
    return;
  }
  if (!effect.ok) {
    await reply(chatId, tradeRefusal(String(effect.error), { holdingName: holding.name, units: draft.units ?? undefined }));
    return;
  }
  const fundName = fundNamed(effect.funds_account_id);
  // An Indian sale's tax is deducted by the broker and read later from its
  // statement, unless the message gave it.
  const taxToConfirm = draft.side === "sell" && holding.currency === "INR" && draft.tax === null;
  await sendProposal(
    chatId,
    member.household_id,
    member.id,
    "trade",
    {
      holding_id: holding.id,
      kind: draft.side,
      trade_date: draft.tradeDate,
      traded_at: draft.tradedAt,
      units: split ? draft.ratio : draft.units,
      price: split ? null : draft.price,
      fees: draft.fees,
      tax_withheld: draft.tax ?? 0,
      tax_to_confirm: taxToConfirm,
      funds_account_id: effect.funds_account_id ?? null,
      expected_version: effect.trades_version,
      draft,
      holding_name: holding.name,
      currency: holding.currency,
      fund_name: split ? null : fundName,
    },
    tradeConfirmation(draft, effect, {
      holdingName: holding.name,
      ownerName,
      fundName,
      currency: holding.currency,
      newHolding: null,
      lastPrice: holding.current_price,
      today: householdToday(),
    }),
    updateId,
  );
}
