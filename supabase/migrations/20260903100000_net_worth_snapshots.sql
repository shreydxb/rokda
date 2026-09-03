-- One row per completed calendar month (always stored as the 1st of that
-- month). The current, still-open month is never snapshotted here — it's
-- computed live from real account balances, same as everywhere else in the
-- app, so history and "now" can never disagree.

create table net_worth_snapshots (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  snapshot_date date not null,
  assets numeric(14, 2) not null,
  liabilities numeric(14, 2) not null,
  created_at timestamptz not null default now(),
  unique (household_id, snapshot_date)
);

create index net_worth_snapshots_household_id_idx on net_worth_snapshots (household_id);

alter table net_worth_snapshots enable row level security;

create policy "members can read net worth snapshots" on net_worth_snapshots
  for select using (is_household_member(household_id));
create policy "members can write net worth snapshots" on net_worth_snapshots
  for insert with check (is_household_member(household_id));
create policy "members can update net worth snapshots" on net_worth_snapshots
  for update using (is_household_member(household_id));
create policy "members can delete net worth snapshots" on net_worth_snapshots
  for delete using (is_household_member(household_id));
