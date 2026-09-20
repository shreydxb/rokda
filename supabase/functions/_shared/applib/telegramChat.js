// Where the bot is allowed to say anything (QA, conditional privacy finding).
//
// Everything this bot says is household financial data -- balances, what was
// spent where, what is due. Identity comes from `from.id` (which member sent
// it), but every reply goes to `chat.id` (where it was sent), and nothing
// checked that those two describe the same private conversation. A linked
// member typing /brief in any group the bot had been added to therefore
// published the household's figures to that group; an ordinary message there
// was captured as an expense; and a link code sent there could be read by
// everyone present.
//
// Fails closed. An update whose chat type is missing or unrecognised is not
// private. Telegram always sends `type` on a Chat, so the only way to reach
// that branch is a malformed update, and refusing to answer one costs nothing.
//
// This deliberately does not depend on the bot's BotFather group-join setting.
// That setting is invisible from here, changeable later by anyone holding the
// token, and was the thing the review could not verify -- so the guard is in
// the code, and ?setup=1 reports what the setting currently is
// (getMe.can_join_groups) so the assumption is checkable rather than believed.
//
// Like its neighbours telegramConfirm.js, this has no counterpart under src/:
// it is bot-only, and it lives here so it can be unit-tested.
export function isPrivateChat(chat) {
  return chat?.type === 'private';
}
