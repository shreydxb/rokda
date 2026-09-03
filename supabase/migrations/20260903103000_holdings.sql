-- Values are stored in AED (the app's reporting currency) directly, not
-- native currency + a live FX rate — there's no FX feed, and asking
-- whoever maintains this to enter the AED-equivalent is both simpler and
-- more honest than a stale conversion. `currency` is informational only
-- (what the underlying asset is denominated in).

create table holdings (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  owner_member_id uuid references household_members(id) on delete set null,
  is_shared boolean not null default true,
  name text not null,
  asset_class text not null check (
    asset_class in ('us_equity', 'intl_equity', 'uae_equity', 'india_equity', 'india_mf', 'crypto', 'sukuk', 'cash')
  ),
  currency text not null default 'AED',
  value_aed numeric(14, 2) not null default 0,
  last_refreshed timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index holdings_household_id_idx on holdings (household_id);

create table holding_value_history (
  id uuid primary key default gen_random_uuid(),
  holding_id uuid not null references holdings(id) on delete cascade,
  as_of date not null,
  value_aed numeric(14, 2) not null,
  unique (holding_id, as_of)
);

create index holding_value_history_holding_id_idx on holding_value_history (holding_id);

alter table holdings enable row level security;
alter table holding_value_history enable row level security;

create policy "members can read holdings" on holdings
  for select using (is_household_member(household_id));
create policy "members can write holdings" on holdings
  for insert with check (is_household_member(household_id));
create policy "members can update holdings" on holdings
  for update using (is_household_member(household_id));
create policy "members can delete holdings" on holdings
  for delete using (is_household_member(household_id));

-- history follows its holding's household membership, checked via a join
create policy "members can read holding history" on holding_value_history
  for select using (exists (select 1 from holdings h where h.id = holding_id and is_household_member(h.household_id)));
create policy "members can write holding history" on holding_value_history
  for insert with check (exists (select 1 from holdings h where h.id = holding_id and is_household_member(h.household_id)));
create policy "members can update holding history" on holding_value_history
  for update using (exists (select 1 from holdings h where h.id = holding_id and is_household_member(h.household_id)));
create policy "members can delete holding history" on holding_value_history
  for delete using (exists (select 1 from holdings h where h.id = holding_id and is_household_member(h.household_id)));
