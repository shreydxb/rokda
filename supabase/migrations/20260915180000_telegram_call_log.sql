-- SHR-288: nothing about the Telegram bot's own LLM calls (classifyAndRoute,
-- parseIntakeWithAI, phraseAnswer) has ever survived the request that made
-- them -- no record of volume, latency, tokens, model, or success/failure.
-- This table is metadata-only by design: household_id/member_id, which call,
-- which model, token counts, latency and outcome. It deliberately never
-- stores the raw prompt or response text -- that's the household's actual
-- financial messages a second time, in a table with the same sensitivity as
-- the ledger itself, and is left for a separate, later decision (see the
-- ticket's own "why now" for the reasoning).
create table telegram_call_log (
  id bigint generated always as identity primary key,
  household_id uuid references households(id) on delete cascade,
  member_id uuid references household_members(id) on delete set null,
  occurred_at timestamptz not null default now(),
  call_kind text not null check (call_kind in ('classify_and_route', 'parse_intake', 'phrase_answer')),
  model text,
  prompt_tokens int,
  completion_tokens int,
  total_tokens int,
  latency_ms int not null,
  success boolean not null,
  error_type text
);

comment on table telegram_call_log is 'One row per Telegram-triggered LLM call (classify_and_route/parse_intake/phrase_answer): model, token counts, latency, success/failure. Deliberately no prompt/response content -- see SHR-288.';

-- household_id is nullable (a message can arrive before it resolves to a
-- linked household -- an unlinked sender probing the bot, for instance);
-- is_household_member(null) already evaluates false, same as every other
-- nullable-household-id table in this schema, so those rows are simply
-- invisible via this policy rather than needing a separate guard -- only
-- service_role (which bypasses RLS) can see them.
create index telegram_call_log_household_occurred_idx on telegram_call_log (household_id, occurred_at desc);

alter table telegram_call_log enable row level security;

create policy "members can read telegram_call_log"
on telegram_call_log for select
using (is_household_member(household_id));
