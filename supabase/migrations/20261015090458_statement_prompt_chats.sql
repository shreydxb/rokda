-- A statement question is answered in the chat it was asked in
-- (docs/decisions.md, "A statement answer belongs to the chat it was asked in").
--
-- The bot kept the message ids of its statement questions in
-- asked_message_ids, and took a reply or a reaction to any message with one
-- of those ids as an answer. Telegram numbers messages per chat, so each
-- member's chat with the bot has its own message 42: a "yes" to an expense
-- question that happened to share an id with a statement question asked in
-- the other member's chat settled that statement instead.
--
-- Each question is now kept with the chat it was sent to and the member it
-- was sent to, and an answer must come from that chat. asked_message_ids is
-- no longer written or read; it is left in place rather than dropped, so
-- this migration only adds. Questions asked before it are not matched to a
-- chat, so a reply to one of those is not taken as an answer; the next
-- morning's question is.

alter table statement_reconciliations
  add column asked_prompts jsonb not null default '[]'::jsonb,
  add constraint statement_reconciliations_asked_prompts_array check (jsonb_typeof(asked_prompts) = 'array');

comment on column statement_reconciliations.asked_prompts is
  'The bot''s questions about this statement, one {chat_id, message_id, member_id} each. A reply or a reaction is an answer only when its chat and message match one of these.';

comment on column statement_reconciliations.asked_message_ids is
  'Superseded by asked_prompts, which keeps each question''s chat. No longer written or read.';
