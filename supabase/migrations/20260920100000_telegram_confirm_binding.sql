-- QA #2: the fast-confirm path -- a bare "yes", or a 👍/✅ reaction -- never
-- knew WHICH entry it was confirming. Both routes selected the newest pending
-- intake for the member, so sending expense A, then expense B, then replying
-- "yes" to A's prompt approved B. approve_intake's own same-row locking could
-- not help: it prevents approving one intake twice, and the handler was
-- handing it a different id each time.
--
-- Two columns and one small table fix the two halves of that:
--
-- 1. confirm_chat_id/confirm_message_id record the prompt message the bot
--    actually sent for this intake, so a reply or a reaction pointing at that
--    message resolves back to the one entry it was about.
-- 2. telegram_update_log makes an update_id single-use. Telegram redelivers an
--    update whenever the webhook does not answer 200 in time, and the second
--    delivery of a "yes" used to approve whatever was newest by then -- which,
--    the first delivery having already approved B, was A.
alter table intake
  add column confirm_chat_id bigint,
  add column confirm_message_id bigint;

comment on column intake.confirm_message_id is
  'message_id of the bot''s own fast-confirm prompt for this intake. A "yes" reply or 👍 reaction on that message confirms THIS row and no other -- see the telegram-webhook function.';
comment on column intake.confirm_chat_id is
  'Telegram chat the fast-confirm prompt was sent to. Paired with confirm_message_id, which is only unique within a chat.';

-- Partial: only intake rows that were actually offered a fast confirm carry a
-- prompt, and that is the only lookup this index serves.
create index intake_confirm_prompt_idx
  on intake (confirm_chat_id, confirm_message_id)
  where confirm_message_id is not null;

-- One row per Telegram update the webhook has begun processing. The primary
-- key IS the mechanism: the insert fails with 23505 on a redelivery, and the
-- handler stops there, before any side effect.
--
-- This deliberately makes update handling at-most-once rather than
-- at-least-once. A webhook that dies midway now loses that message instead of
-- retrying it, and the member re-sends. That is the right way round here: the
-- side effects on the other side of this gate record money, and an expense
-- silently recorded twice is worse than a message visibly needing to be sent
-- again. The intake table's own unique source_ref already deduped captures;
-- nothing deduped confirmations, which is the half that could double-approve.
create table telegram_update_log (
  update_id bigint primary key,
  received_at timestamptz not null default now()
);

comment on table telegram_update_log is
  'Telegram update_ids already seen by the webhook, so a redelivered update is dropped before it can act twice. Pruned to the last 7 days by the daily run_recurring_check pass -- Telegram gives up retrying long before that.';

-- Serves the daily prune, which is this table's only query besides the
-- primary-key probe.
create index telegram_update_log_received_idx on telegram_update_log (received_at);

alter table telegram_update_log enable row level security;

-- No policies, deliberately. This table has no household_id because an
-- update_id belongs to the bot, not to a household: an unlinked sender probing
-- the bot produces one too. Nothing here is any member's to read, and
-- service_role (which the webhook uses, and which bypasses RLS) is the only
-- thing that ever touches it. RLS on with no policy is therefore the whole
-- intent -- deny every client -- not an oversight.
