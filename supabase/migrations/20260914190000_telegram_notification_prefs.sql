-- One row per household controlling which proactive Telegram nudges it
-- gets. Budget-threshold alerts stay out of this table on purpose: they're
-- already controlled per-category via budgets.alerts_enabled (Money ->
-- Budget), which is the right granularity for "some categories I care
-- about, some I don't" -- a household-wide toggle here would fight with
-- that, not complement it.
--
-- No row for a household means every signal defaults to on -- that's the
-- behaviour every household already has today, so this is additive: nobody
-- needs a backfilled row for nothing to change under them.
create table telegram_notification_prefs (
  household_id uuid primary key references households(id) on delete cascade,
  recurring_enabled boolean not null default true,
  credit_card_enabled boolean not null default true,
  cash_cover_enabled boolean not null default true,
  brief_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

comment on table telegram_notification_prefs is 'Household-level on/off switches for proactive Telegram nudges (recurring/credit-card/cash-cover/brief). Missing row = all on. Budget-threshold alerts are separate (per-category, see budgets.alerts_enabled).';

alter table telegram_notification_prefs enable row level security;

create policy "members can read telegram_notification_prefs"
on telegram_notification_prefs for select
using (is_household_member(household_id));

create policy "members can insert telegram_notification_prefs"
on telegram_notification_prefs for insert
with check (is_household_member(household_id));

create policy "members can update telegram_notification_prefs"
on telegram_notification_prefs for update
using (is_household_member(household_id))
with check (is_household_member(household_id));
