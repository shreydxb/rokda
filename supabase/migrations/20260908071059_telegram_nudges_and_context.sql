-- SHR-259 follow-up: two small pieces of state the Telegram bot needs that
-- don't belong on an existing table.
--
-- 1. recurring_nudges: "a recurring bill looks overdue -- no matching
--    transaction near its due date" is checked once a day (see the
--    telegram-webhook ?run_recurring_check=1 endpoint, run by pg_cron). This
--    records that a nudge was already sent for a given (recurring row, due
--    date) pair so the same missed bill doesn't get re-nagged every day --
--    only the first check after it goes overdue sends anything.
create table recurring_nudges (
  recurring_id uuid not null references recurring(id) on delete cascade,
  due_date date not null,
  sent_at timestamptz not null default now(),
  primary key (recurring_id, due_date)
);

comment on table recurring_nudges is 'One row per recurring bill occurrence already nudged about (no matching transaction found near its due date) -- prevents re-nagging the same missed bill on every daily check.';

-- 2. A short-lived memory of the member's last question and its real
-- answer, so a follow-up like "compare that to last month" or "what about
-- groceries instead" can be resolved without repeating the whole question.
-- Deliberately just the last exchange, not a running history -- this is
-- context for the model's next tool call, not a transcript.
alter table household_members
  add column telegram_last_question text,
  add column telegram_last_answer text,
  add column telegram_last_context_at timestamptz;

comment on column household_members.telegram_last_question is 'The member''s most recent finance question asked via Telegram, kept briefly so a short follow-up message can be understood in context. Not a full transcript -- only the single most recent exchange.';
comment on column household_members.telegram_last_answer is 'The real, tool-computed answer phrased for the question in telegram_last_question -- given back to the model as context for a follow-up, never as a number to make up new figures from.';
comment on column household_members.telegram_last_context_at is 'When the last question/answer pair was recorded -- context older than a few minutes is not offered to the model, since a much later message is unlikely to be a follow-up to it.';
