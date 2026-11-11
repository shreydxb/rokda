// Part of the Telegram webhook (index.ts), split out by responsibility in
// the round 2 cleanup (SHR-383). Moved, not changed.
import { householdToday } from "../../_shared/applib/day.js";
import { decidedProposalMessage, discardUnaskedProposal, PROPOSAL_COLUMNS, type ProposalRow } from "../confirmations.ts";
import { type DividendLine, DIVIDENDS_NOT_YET_REPLY, DIVIDENDS_STALE_LEAD, DIVIDENDS_STALE_NONE, dividendsDropSummary, dividendsQuestion, dividendsRefusal, dividendsSavedMessage } from "../dividends.ts";
import { supabase } from "../env.ts";
import { reply, tgCall } from "../transport.ts";
import { prefEnabled, telegramPrefsMap } from "./recipients.ts";

// ---------------------------------------------------------------------------
// Dividends due in a fund (docs/decisions.md, "Dividends are their own
// records")
// ---------------------------------------------------------------------------
//
// Each morning, a dividend paid into a broker's fund that nobody has recorded
// is asked about once, from its pay date: one message per member per fund,
// to the holding's owner, or to every linked member for a shared holding. A
// "yes" (or 👍) receives every line in it through apply_bot_proposal, which
// saves them only as they were shown. A dividend paid into a bank account is
// not asked about: a bank balance is a snapshot, and one unanswered is
// presumed received after 30 days. When the fund's balance was confirmed on
// or after a pay date, only the member can say whether the dividend was in
// it, so that message asks, and its "yes" and "no" both record.

export type DividendsPayload = {
  fund_id: string;
  fund_name: string;
  currency: string;
  confirmation: string | null;
  ask: "already_included" | null;
  answer: "included" | "not_included" | null;
  lines: Array<DividendLine & { dividend_id: string; version: number }>;
  total: number;
};

export type DividendsResult = { lines: Array<DividendLine & { moved: number }>; total: number };

export type DueDividend = {
  id: string;
  household_id: string;
  holding_id: string;
  version: number;
  pay_date: string;
  units: number;
  per_share: number;
  expected_gross: number;
  expected_tax: number;
  expected_fees: number;
  expected_net: number;
  paid_into_account_id: string | null;
};

export type DividendFund = { id: string; household_id: string; name: string; type: string; currency: string; balance_as_of: string | null; archived_at: string | null };

export type DividendGroup = { householdId: string; memberId: string; chatId: number; fund: DividendFund; ask: boolean; lines: DividendsPayload["lines"] };

export const DUE_DIVIDEND_COLUMNS =
  "id, household_id, holding_id, version, pay_date, units, per_share, expected_gross, expected_tax, expected_fees, expected_net, paid_into_account_id";


export async function runDividendCheck(): Promise<{ checked: number; asked: number }> {
  const todayStr = householdToday(new Date());
  const [{ data: rows, error }, prefs] = await Promise.all([
    supabase
      .from("holding_dividends")
      .select(DUE_DIVIDEND_COLUMNS)
      .eq("status", "earned")
      .is("asked_at", null)
      .lte("pay_date", todayStr)
      .not("paid_into_account_id", "is", null),
    telegramPrefsMap(),
  ]);
  if (error) return { checked: 0, asked: 0 };
  const due = ((rows ?? []) as DueDividend[]).filter((d) => prefEnabled(prefs, d.household_id, "dividends_enabled"));
  const { groups, checked } = await dividendGroups(due);
  let asked = 0;
  for (const g of groups) {
    try {
      if (await askDividends(g, `dividends:${g.memberId}:${g.fund.id}:${todayStr}:${g.ask ? "ask" : "plain"}`, null)) asked++;
    } catch {
      // One member's question failing must never block the rest.
    }
  }
  return { checked, asked };
}


// The questions these dividends make: by member, fund, and whether the fund
// was confirmed on or after the pay date. Only dividends due in an open
// broker's fund count.
export async function dividendGroups(due: DueDividend[]): Promise<{ groups: DividendGroup[]; checked: number }> {
  if (!due.length) return { groups: [], checked: 0 };
  const unique = (xs: string[]) => [...new Set(xs)];
  const [{ data: holdings }, { data: funds }, { data: members }] = await Promise.all([
    supabase.from("holdings").select("id, name, owner_member_id").in("id", unique(due.map((d) => d.holding_id))),
    supabase.from("accounts").select("id, household_id, name, type, currency, balance_as_of, archived_at").in("id", unique(due.map((d) => String(d.paid_into_account_id)))),
    supabase.from("household_members").select("id, household_id, telegram_user_id").in("household_id", unique(due.map((d) => d.household_id))),
  ]);
  const holdingById = new Map(((holdings ?? []) as Array<{ id: string; name: string; owner_member_id: string | null }>).map((h) => [h.id, h]));
  const fundById = new Map(((funds ?? []) as DividendFund[]).map((f) => [f.id, f]));
  const groups = new Map<string, DividendGroup>();
  let checked = 0;
  for (const d of due) {
    const fund = fundById.get(String(d.paid_into_account_id));
    const holding = holdingById.get(d.holding_id);
    if (!fund || fund.type !== "broker_funds" || fund.archived_at != null || !holding) continue;
    checked++;
    const ask = fund.balance_as_of != null && householdToday(new Date(fund.balance_as_of)) >= d.pay_date;
    const recipients = ((members ?? []) as Array<{ id: string; household_id: string; telegram_user_id: number | null }>)
      .filter((m) => m.household_id === d.household_id && m.telegram_user_id != null && (holding.owner_member_id == null || m.id === holding.owner_member_id));
    for (const m of recipients) {
      const key = `${m.id}|${fund.id}|${ask}`;
      const group = groups.get(key) ?? { householdId: d.household_id, memberId: m.id, chatId: Number(m.telegram_user_id), fund, ask, lines: [] };
      group.lines.push({
        dividend_id: d.id, version: Number(d.version), holding_name: holding.name, units: Number(d.units), per_share: Number(d.per_share),
        gross: Number(d.expected_gross), tax: Number(d.expected_tax), fees: Number(d.expected_fees), net: Number(d.expected_net), pay_date: d.pay_date,
      });
      groups.set(key, group);
    }
  }
  for (const g of groups.values()) g.lines.sort((a, b) => a.holding_name.localeCompare(b.holding_name) || a.dividend_id.localeCompare(b.dividend_id));
  return { groups: [...groups.values()], checked };
}


// Asks one member about one fund's dividends, and marks them asked once the
// message is out. True when it went out. A message that never went out, or
// whose id could not be kept, leaves nothing asked, so tomorrow asks again.
export async function askDividends(g: DividendGroup, sourceRef: string, lead: string | null): Promise<boolean> {
  const total = Math.round(g.lines.reduce((t, l) => t + l.net, 0) * 10000) / 10000;
  const payload: DividendsPayload = {
    fund_id: g.fund.id, fund_name: g.fund.name, currency: g.fund.currency, confirmation: g.fund.balance_as_of,
    ask: g.ask ? "already_included" : null, answer: null, lines: g.lines, total,
  };
  const inserted = await supabase
    .from("bot_proposals")
    .insert({ household_id: g.householdId, member_id: g.memberId, kind: "dividends_received", payload, chat_id: g.chatId, source_ref: sourceRef })
    .select("id")
    .single();
  // 23505: asked already today.
  if (inserted.error || !inserted.data) return false;
  const id = String(inserted.data.id);
  const question = dividendsQuestion(g.fund.name, g.fund.currency, g.lines, g.ask ? { confirmedOn: householdToday(new Date(String(g.fund.balance_as_of))) } : null);
  let messageId: number | null = null;
  try {
    messageId = await reply(g.chatId, lead ? `${lead}\n${question}` : question);
  } catch {
    messageId = null;
  }
  if (messageId == null) {
    await discardUnaskedProposal(id);
    return false;
  }
  let recorded = await supabase.from("bot_proposals").update({ prompt_message_id: messageId }).eq("id", id);
  if (recorded.error) recorded = await supabase.from("bot_proposals").update({ prompt_message_id: messageId }).eq("id", id);
  if (recorded.error) {
    // Unanswerable without its id: withdrawn, and asked again tomorrow.
    await tgCall("deleteMessage", { chat_id: g.chatId, message_id: messageId }).catch(() => {});
    await discardUnaskedProposal(id);
    return false;
  }
  await supabase.rpc("mark_dividends_asked", { p_ids: g.lines.map((l) => l.dividend_id) });
  return true;
}


// A member's answer to a dividend question. On a plain question "yes"
// records them and "no" leaves them for the app. On a question about a
// confirmed balance both record: "yes" as already in it, "no" as arriving
// after it.
export async function decideDividends(chatId: number, memberId: string, proposal: ProposalRow, decision: "apply" | "cancel"): Promise<void> {
  const payload = proposal.payload as DividendsPayload;
  if (payload.ask == null && decision === "cancel") {
    const { data, error } = await supabase
      .from("bot_proposals")
      .update({ status: "cancelled", decided_at: new Date().toISOString() })
      .eq("id", proposal.id)
      .eq("member_id", memberId)
      .eq("status", "proposed")
      .select(PROPOSAL_COLUMNS);
    if (error) {
      await reply(chatId, "I couldn't drop that just now. Nothing has been changed; try again in a moment.");
      return;
    }
    if (data?.length) {
      await reply(chatId, `Left for the app: ${dividendsDropSummary(payload)}. Nothing was recorded.`);
      return;
    }
    const { data: fresh } = await supabase.from("bot_proposals").select(PROPOSAL_COLUMNS).eq("id", proposal.id).maybeSingle();
    await reply(chatId, decidedProposalMessage((fresh as ProposalRow | null) ?? proposal));
    return;
  }
  if (payload.ask != null) {
    // Only while it waits: one already decided keeps the answer it had.
    const answer = decision === "apply" ? "included" : "not_included";
    const { error } = await supabase
      .from("bot_proposals")
      .update({ payload: { ...payload, answer } })
      .eq("id", proposal.id)
      .eq("member_id", memberId)
      .eq("status", "proposed");
    if (error) {
      await reply(chatId, "I couldn't record that just now. Answer my message again in a moment; it will only be recorded once.");
      return;
    }
  }
  const { data, error } = await supabase.rpc("apply_bot_proposal", { p_proposal_id: proposal.id, p_member_id: memberId });
  if (error || !data || typeof data !== "object") {
    await reply(chatId, "I couldn't record that just now. Answer my message again in a moment; it will only be recorded once.");
    return;
  }
  const outcome = String((data as Record<string, unknown>).outcome ?? "");
  if (outcome === "applied") {
    const repeat = (data as Record<string, unknown>).result != null;
    const result = (repeat ? (data as Record<string, unknown>).result : data) as DividendsResult;
    await reply(chatId, dividendsSavedMessage(payload.fund_name, payload.currency, result, repeat));
    return;
  }
  if (outcome === "stale") {
    await reaskDividends(chatId, memberId, payload, proposal.id);
    return;
  }
  if (outcome === "refused") {
    await reply(chatId, dividendsRefusal(String((data as Record<string, unknown>).error ?? "")));
    return;
  }
  await reply(chatId, decidedProposalMessage({
    ...proposal,
    status: outcome === "cancelled" ? "cancelled" : "expired",
    result: ((data as Record<string, unknown>).result ?? proposal.result) as ProposalRow["result"],
  }));
}


// "Not yet" (or 👎): it has not arrived. Nothing is recorded, and the
// dividends are asked about again the next morning.
export async function dividendsNotYet(chatId: number, memberId: string, proposal: ProposalRow): Promise<void> {
  // One call puts off the question and clears its dividends' asked marks, or
  // neither: the promise to ask tomorrow is only made once both are done.
  const { data, error } = await supabase.rpc("postpone_dividends_proposal", { p_proposal_id: proposal.id, p_member_id: memberId });
  const result = data as { ok?: boolean } | null;
  if (error || !result) {
    await reply(chatId, "I couldn't put that off just now. Nothing has been changed; try again in a moment.");
    return;
  }
  if (!result.ok) {
    const { data: fresh } = await supabase.from("bot_proposals").select(PROPOSAL_COLUMNS).eq("id", proposal.id).maybeSingle();
    await reply(chatId, decidedProposalMessage((fresh as ProposalRow | null) ?? proposal));
    return;
  }
  await reply(chatId, DIVIDENDS_NOT_YET_REPLY);
}


// Something changed since the question (a line fixed or recorded in the app,
// the fund confirmed again): nothing was recorded, so what still waits is
// asked about again, as it is now.
export async function reaskDividends(chatId: number, memberId: string, payload: DividendsPayload, proposalId: string): Promise<void> {
  const ids = payload.lines.map((l) => l.dividend_id);
  await supabase.rpc("mark_dividends_asked", { p_ids: ids, p_asked: false });
  const { data: rows } = await supabase.from("holding_dividends").select(DUE_DIVIDEND_COLUMNS).in("id", ids).eq("status", "earned");
  const { groups } = await dividendGroups((rows ?? []) as DueDividend[]);
  const mine = groups.filter((g) => g.memberId === memberId);
  if (!mine.length) {
    await reply(chatId, DIVIDENDS_STALE_NONE);
    return;
  }
  const todayStr = householdToday(new Date());
  let lead: string | null = DIVIDENDS_STALE_LEAD;
  for (const g of mine) {
    if (await askDividends(g, `dividends:${g.memberId}:${g.fund.id}:${todayStr}:${g.ask ? "ask" : "plain"}:${proposalId}`, lead)) lead = null;
  }
  if (lead) await reply(chatId, "Something changed since I asked, so nothing was recorded. I'll ask about them again tomorrow morning.");
}
