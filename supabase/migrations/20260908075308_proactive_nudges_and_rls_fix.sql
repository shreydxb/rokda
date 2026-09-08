-- SHR-259 follow-up, items 5+: proactive reminders for credit-card due
-- dates ("did you mark this paid?") and budget thresholds (80/90/100%
-- used), alongside a security fix the advisor flagged after the previous
-- migration.

-- recurring_nudges (added in 20260908070000) was created without RLS --
-- fully exposed to anon/authenticated via PostgREST even though only the
-- service-role edge function was ever meant to touch it. Service role
-- bypasses RLS, so enabling it here only closes that exposure; it changes
-- nothing about how the bot itself reads/writes the table.
alter table recurring_nudges enable row level security;

create policy "members can read recurring_nudges"
on recurring_nudges for select
using (exists (select 1 from recurring r where r.id = recurring_nudges.recurring_id and is_household_member(r.household_id)));

-- One row per credit-card due-date nudge already sent (upcoming or
-- overdue) -- prevents re-nagging the same due date every day. Two kinds:
-- 'due_soon' (1-2 days before, or the due day itself) and 'overdue' (a few
-- days after, balance still shows owing) -- there is no "marked as paid"
-- concept in this app, so "overdue" really means "balance still positive
-- past the due date", same proxy the existing get_upcoming_bills tool uses.
create table credit_card_nudges (
  account_id uuid not null references accounts(id) on delete cascade,
  due_date date not null,
  kind text not null check (kind in ('due_soon', 'overdue')),
  sent_at timestamptz not null default now(),
  primary key (account_id, due_date, kind)
);

comment on table credit_card_nudges is 'One row per credit-card due-date nudge already sent (due_soon or overdue) -- prevents re-nagging the same due date every day.';

alter table credit_card_nudges enable row level security;

create policy "members can read credit_card_nudges"
on credit_card_nudges for select
using (exists (select 1 from accounts a where a.id = credit_card_nudges.account_id and is_household_member(a.household_id)));

-- One row per budget-threshold alert already sent for a household's
-- category in a given month (80/90/100% of budget used) -- prevents
-- re-alerting the same threshold every day. A later, higher threshold
-- crossed the same month still gets its own alert.
create table budget_alert_nudges (
  household_id uuid not null references households(id) on delete cascade,
  category_id uuid not null references categories(id) on delete cascade,
  year int not null,
  month int not null,
  threshold int not null check (threshold in (80, 90, 100)),
  sent_at timestamptz not null default now(),
  primary key (household_id, category_id, year, month, threshold)
);

comment on table budget_alert_nudges is 'One row per budget-threshold alert already sent for a category/month (80/90/100%) -- prevents re-alerting the same threshold every day; a higher threshold reached later still sends its own alert.';

alter table budget_alert_nudges enable row level security;

create policy "members can read budget_alert_nudges"
on budget_alert_nudges for select
using (is_household_member(household_id));
