// Every tap on one of the bot's buttons comes here first (index.ts), and goes
// to what the button is about: a pasted list (batchReview.ts), a proposal or
// an autopay bill (confirmations.ts), a card statement (checks/statements.ts)
// or an expense (choices.ts). The button's data is never
// trusted: each handler checks the tap against the database.
import { decodeListTap } from "./batch.ts";
import { handleListTap } from "./batchReview.ts";
import { decodeChoice, handleChoiceTap } from "./choices.ts";
import { handleStatementTap } from "./checks/statements.ts";
import { handleProposalTap } from "./confirmations.ts";

export async function handleTap(callback: Record<string, unknown>, updateId: unknown): Promise<Response> {
  const list = decodeListTap(String(callback.data ?? ""));
  if (list) return await handleListTap(callback, list.op, list.mask);
  const choice = decodeChoice(String(callback.data ?? ""));
  const proposal = { P: "apply", X: "cancel", N: "not_yet", O: "other_amount" } as const;
  if (choice && choice.kind in proposal) return await handleProposalTap(callback, proposal[choice.kind as keyof typeof proposal], choice.intakeId, updateId);
  if (choice?.kind === "S") return await handleStatementTap(callback, choice.intakeId);
  return await handleChoiceTap(callback);
}
