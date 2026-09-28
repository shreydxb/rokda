-- A monthly balance check-in over Telegram. On the 1st the bot asks each
-- linked member for their accounts' closing balances; a reply sets them.
-- Balances are entered by hand and never derived from transactions, so
-- without a prompt they go stale, and every plan starts from them.

-- One check-in per household per month, the same dedupe the weekly and
-- monthly briefs use: period_key is the month being closed, 'YYYY-MM'.
alter table brief_sends drop constraint brief_sends_kind_check;
alter table brief_sends add constraint brief_sends_kind_check check (kind in ('weekly', 'monthly', 'balance_checkin'));

-- On by default, like every other nudge; switched off in Settings -> Telegram.
alter table telegram_notification_prefs
  add column balance_checkin_enabled boolean not null default true;

comment on column telegram_notification_prefs.balance_checkin_enabled is
  'Whether the bot asks for closing account balances on the 1st of each month.';
