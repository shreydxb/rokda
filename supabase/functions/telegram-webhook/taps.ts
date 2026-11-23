// Every tap on one of the bot's buttons comes here first (index.ts), and goes
// to what the button is about: a pasted list (batchReview.ts), a proposal
// (confirmations.ts) or an expense (choices.ts). The button's data is never
// trusted: each handler checks the tap against the database.
import { decodeListTap } from "./batch.ts";
import { handleListTap } from "./batchReview.ts";
import { decodeChoice, handleChoiceTap } from "./choices.ts";
import { handleProposalTap } from "./confirmations.ts";

export async function handleTap(callback: Record<string, unknown>, updateId: unknown): Promise<Response> {
  const list = decodeListTap(String(callback.data ?? ""));
  if (list) return await handleListTap(callback, list.op, list.mask);
  const choice = decodeChoice(String(callback.data ?? ""));
  if (choice?.kind === "P" || choice?.kind === "X") return await handleProposalTap(callback, choice.kind === "P" ? "apply" : "cancel", choice.intakeId, updateId);
  return await handleChoiceTap(callback);
}
