-- SHR-283: proactively nudge Telegram when a category's spend this month is
-- well past its own trailing average, alongside the existing recurring/
-- credit-card/budget/cash-cover checks. Reuses the same trailing-average
-- math the web Insights screen already shows informationally (src/lib/
-- insights.js's notableMoves), but the check that fires this table's rows
-- calls it with a far more conservative bar than that screen's own
-- defaults -- a push notification that cries wolf trains the household to
-- ignore it, which defeats the point. See runUnusualSpendCheck in
-- telegram-webhook/index.ts for the actual threshold.

alter table telegram_notification_prefs
  add column unusual_spend_enabled boolean not null default true;

-- One row per household/category/month already nudged about unusual spend
-- -- prevents re-nagging the same hot category every day for the rest of
-- the month even if it keeps climbing further past the bar.
create table unusual_spend_nudges (
  household_id uuid not null references households(id) on delete cascade,
  category_id uuid not null references categories(id) on delete cascade,
  year int not null,
  month int not null,
  sent_at timestamptz not null default now(),
  primary key (household_id, category_id, year, month)
);

comment on table unusual_spend_nudges is 'One row per household/category/month already nudged about unusual spend (well above trailing average) -- prevents re-nagging the same category every day for the rest of the month.';

alter table unusual_spend_nudges enable row level security;

create policy "members can read unusual_spend_nudges"
on unusual_spend_nudges for select
using (is_household_member(household_id));
