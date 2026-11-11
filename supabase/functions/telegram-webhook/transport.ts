// Part of the Telegram webhook (index.ts), split out by responsibility in
// the round 2 cleanup (SHR-383). Moved, not changed.
import { LINK_ATTEMPT_WINDOW_MS, linkAttemptRefusal } from "../_shared/applib/telegramLink.js";
import { supabase, TG_API } from "./env.ts";

// Every Telegram URL carries the bot token in its path, and a failed fetch
// carries its URL. Deno's own message is a bland "fetch failed", but its
// `cause` reads "error sending request for url (https://api.telegram.org/
// bot<TOKEN>/sendMessage)", and the runtime's uncaught-error printer follows
// the cause chain -- so a DNS failure reaching Telegram used to print the full
// token into the function logs (SHR-303, reproduced with a synthetic token).
//
// Any failure is therefore replaced here by an error naming only what was
// being attempted, with no cause attached. What went wrong at the network
// layer is not worth a credential.
export async function telegramFetch(url: string, init: RequestInit | undefined, what: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error(`telegram ${what} failed`);
  }
}


export async function tgCall(method: string, body: Record<string, unknown>) {
  const res = await telegramFetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, method);
  try {
    return await res.json();
  } catch {
    // A non-JSON body (a proxy's HTML error page, say) is a failed call, not
    // something to quote into a log.
    throw new Error(`telegram ${method} returned an unreadable response`);
  }
}


// Returns the message_id Telegram assigned to what we just sent, or null if
// the send failed or the response did not carry one. The fast-confirm prompt
// is the one caller that needs it: that id is what a later "yes" reply or 👍
// reaction points back at, and so is what ties a confirmation to one specific
// intake rather than to whatever happens to be newest (QA #2).
export async function reply(chatId: number, text: string): Promise<number | null> {
  const res = (await tgCall("sendMessage", { chat_id: chatId, text })) as
    | { result?: { message_id?: number } }
    | undefined;
  return res?.result?.message_id ?? null;
}


// What became of a scheduled reminder sent to one chat. Telegram can refuse a
// send (ok:false) without anything throwing, and a reminder recorded as sent
// after that was never sent again (round 2 of the outside review). A refusal
// is for now (a 429, a 5xx, the network) or for good: a member who blocked
// the bot (403), a chat that is gone or a message it will never take (400).
// Only one for now is worth trying again: trying one refused for good sent
// the reminder again to everyone else on every run (the fresh review of
// round 2).
export async function sendReminder(chatId: number, text: string): Promise<"sent" | "retry" | "final"> {
  let res: { ok?: boolean; error_code?: number } | undefined;
  try {
    res = await tgCall("sendMessage", { chat_id: chatId, text });
  } catch {
    return "retry";
  }
  if (res?.ok) return "sent";
  if (res?.error_code === 400 || res?.error_code === 403) {
    console.error(`telegram refused a reminder for good (${res.error_code})`);
    return "final";
  }
  return "retry";
}


// Sends one message to each chat, and says whether none of them needs
// trying again: the reminder is recorded as sent only then. One that reached
// one member and was refused for now to the other goes again to both on the
// next run: a repeat beats a reminder nobody got.
export async function sendToAll(chatIds: number[], text: string): Promise<boolean> {
  let done = true;
  for (const chatId of chatIds) {
    if ((await sendReminder(chatId, text)) === "retry") done = false;
  }
  return done;
}


// QA #2, half two, revised in SHR-303. Telegram redelivers an update whenever
// the webhook does not answer 200 in time, so every update is claimed before
// it is handled and settled after.
//
// The first version inserted into telegram_update_log up front and treated a
// duplicate key as "seen". That could only record receipt, so a crash between
// the log insert and the capture turned the redelivery into a silent drop --
// and a loss mode unique to this table, since intake's own delivery key
// (intake_source_ref_key) already made a second capture harmless. It also
// treated every error that was not a duplicate key as "not seen" and carried
// on, reasoning that dropping messages because a bookkeeping table is down is
// worse than losing dedupe. That was a false choice: there is a third option,
// which is to answer non-200 and let Telegram retry. If the table is down, the
// capture that follows would fail too, so refusing costs nothing.
//
// See claim_telegram_update for why 'completed' and 'busy' are distinct.
export type Claim = "claimed" | "completed" | "busy" | "unknown" | "untracked";


export async function claimUpdate(updateId: unknown): Promise<Claim> {
  // No numeric update_id means nothing to dedupe on. Rare -- Telegram always
  // sends one -- and the per-side-effect keys below still hold.
  if (typeof updateId !== "number") return "untracked";
  try {
    const { data, error } = await supabase.rpc("claim_telegram_update", { p_update_id: updateId });
    if (error) return "unknown";
    if (data === "claimed" || data === "completed" || data === "busy") return data;
    return "unknown";
  } catch {
    return "unknown";
  }
}


// Best effort by design. If marking 'completed' fails, the update was handled
// and Telegram has its 200; the row lapses harmlessly. If marking 'failed'
// fails, the row stays 'processing', and claimUpdate answers 'busy' -- a
// non-200 -- to every retry until the lease lapses and the update is
// reclaimed. Either way nothing here is allowed to throw.
export async function settleUpdate(updateId: unknown, status: "completed" | "failed"): Promise<void> {
  if (typeof updateId !== "number") return;
  try {
    await supabase.from("telegram_update_log").update({ status }).eq("update_id", updateId);
  } catch {
    // See above.
  }
}


// What a bare "yes" or "no" resolved to, recorded with the update before it
// acts (outside review D-02). A bare answer names nothing, so it is resolved
// against whatever is waiting; if the reply after acting fails and Telegram
// delivers the answer again, a question asked or an entry captured in the
// meantime would otherwise be what it resolves to, and be saved without the
// member ever answering it. A reply or a reaction names its message, so only
// bare answers need this.
export type AnswerTarget = { kind: "proposal" | "intake"; id: string };


export async function recordedAnswerTarget(updateId: unknown): Promise<AnswerTarget | null> {
  if (typeof updateId !== "number") return null;
  const { data, error } = await supabase.from("telegram_update_log").select("answer_target").eq("update_id", updateId).maybeSingle();
  // Not knowing what the first delivery answered is not the same as it
  // having answered nothing: thrown back, so Telegram tries again.
  if (error) throw new Error(`reading what an answer was about failed (${error.code ?? "no code"})`);
  const target = (data as { answer_target?: AnswerTarget | null } | null)?.answer_target ?? null;
  return target && (target.kind === "proposal" || target.kind === "intake") && typeof target.id === "string" ? target : null;
}


export async function recordAnswerTarget(updateId: unknown, target: AnswerTarget): Promise<void> {
  if (typeof updateId !== "number") return;
  const { error } = await supabase.from("telegram_update_log").update({ answer_target: target }).eq("update_id", updateId).is("answer_target", null);
  if (error) throw new Error(`recording what an answer was about failed (${error.code ?? "no code"})`);
}


// The handler's only log line. Operational metadata only: where it failed,
// which update, and the error's class name. Never the message -- a message
// can quote a URL, a row, or the text a member sent -- and never the stack.
export function logFailure(where: string, updateId: unknown, err: unknown): void {
  console.error(
    JSON.stringify({
      event: "telegram_webhook_failure",
      where,
      update_id: typeof updateId === "number" ? updateId : null,
      error: err instanceof Error ? err.name : typeof err,
    })
  );
}


// Counts the rows; _shared/applib/telegramLink.js decides what they mean. See
// there for why an unlinked sender gets a bounded number of guesses at all.
export async function linkAttemptBlocked(fromId: number): Promise<string | null> {
  const since = new Date(Date.now() - LINK_ATTEMPT_WINDOW_MS).toISOString();
  const [{ count: sender }, { count: global }] = await Promise.all([
    supabase
      .from("telegram_link_attempts")
      .select("id", { count: "exact", head: true })
      .eq("telegram_user_id", fromId)
      .gt("attempted_at", since),
    supabase.from("telegram_link_attempts").select("id", { count: "exact", head: true }).gt("attempted_at", since),
  ]);
  return linkAttemptRefusal({ sender, global });
}


export async function recordLinkFailure(fromId: number): Promise<void> {
  try {
    await supabase.from("telegram_link_attempts").insert({ telegram_user_id: fromId });
  } catch {
    // Best-effort. A counter that failed to increment must not also refuse the
    // person a chance to type their code correctly.
  }
}


// A successful link ends the sender's history, so an ordinary member who
// mistypes once and then succeeds is not one failure closer to a lockout the
// next time they relink a device.
export async function clearLinkFailures(fromId: number): Promise<void> {
  try {
    await supabase.from("telegram_link_attempts").delete().eq("telegram_user_id", fromId);
  } catch {
    // Best-effort.
  }
}


// telegram_update_log only has to outlive Telegram's own retry window, which
// is minutes. A week is generous and keeps the table from growing without
// bound. Runs with the other daily passes; a failure here is invisible and
// harmless, so it is swallowed rather than allowed to fail that request.
export async function pruneTelegramUpdateLog(): Promise<void> {
  try {
    await supabase
      .from("telegram_update_log")
      .delete()
      .lt("received_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
  } catch {
    // Best-effort housekeeping.
  }
  try {
    // Link attempts only matter inside their 15-minute window; a day is kept
    // so a burst is still legible afterwards rather than having erased itself.
    await supabase
      .from("telegram_link_attempts")
      .delete()
      .lt("attempted_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  } catch {
    // Best-effort housekeeping.
  }
}


// The shared secret every request to this function must present (see the
// check at the top of Deno.serve). Lives in Supabase Vault, not an
// environment variable -- read via a narrowly-scoped RPC only the
// service-role client this function already uses can call. A lookup
// failure (RPC error, or the secret genuinely unset) returns null, which
// the caller treats as "reject everything" rather than "skip the check".
export async function getTelegramWebhookSecret(): Promise<string | null> {
  try {
    const { data, error } = await supabase.rpc("get_telegram_webhook_secret");
    if (error || typeof data !== "string" || !data) return null;
    return data;
  } catch {
    return null;
  }
}


export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
