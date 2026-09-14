-- Dedupe state for two new proactive Telegram features (see
-- telegram-webhook's runWeeklyBriefCheck / runMonthlyBriefCheck /
-- runCashCoverCheck, all under the existing ?run_recurring_check=1 pg_cron
-- call). Both tables are created with RLS from the start -- recurring_nudges
-- shipped without it and had to be patched afterward (see
-- proactive_nudges_and_rls_fix); no reason to repeat that here.

-- One row per weekly or monthly digest already sent, so a retry the same
-- period (a cron re-run, a slow first attempt) is a no-op. period_key is the
-- Monday's date for 'weekly', or the summarised month's 'YYYY-MM' for
-- 'monthly' -- two different key shapes sharing one table since both are
-- just "have we sent this household this recurring message yet".
create table brief_sends (
  household_id uuid not null references households(id) on delete cascade,
  kind text not null check (kind in ('weekly', 'monthly')),
  period_key text not null,
  sent_at timestamptz not null default now(),
  primary key (household_id, kind, period_key)
);

comment on table brief_sends is 'One row per weekly/monthly Telegram digest already sent for a household/period -- prevents re-sending the same digest on a retry.';

alter table brief_sends enable row level security;

create policy "members can read brief_sends"
on brief_sends for select
using (is_household_member(household_id));

-- One row per week a cash-cover shortfall was already nudged about, so a
-- household short all week hears about it once rather than every morning;
-- if it clears and reopens later the same week, it stays quiet until the
-- next Monday -- the same tradeoff budget_alert_nudges makes for a
-- threshold that stays crossed.
create table cash_cover_nudges (
  household_id uuid not null references households(id) on delete cascade,
  period_key text not null,
  sent_at timestamptz not null default now(),
  primary key (household_id, period_key)
);

comment on table cash_cover_nudges is 'One row per week a cash-cover shortfall was already nudged about for a household -- prevents re-nagging the same shortfall every day.';

alter table cash_cover_nudges enable row level security;

create policy "members can read cash_cover_nudges"
on cash_cover_nudges for select
using (is_household_member(household_id));
