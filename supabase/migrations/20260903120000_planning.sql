-- Goals: target + a running log of contributions. Saved-so-far and "last
-- contribution" are always derived from goal_contributions, never stored on
-- the goal itself, so they can't drift out of sync with what was actually
-- logged.

create table goals (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  owner_member_id uuid references household_members(id) on delete set null,
  is_shared boolean not null default true,
  name text not null,
  note text not null default '',
  target_amount numeric(14, 2) not null,
  target_date date,
  funding_source text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index goals_household_id_idx on goals (household_id);

create table goal_contributions (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references goals(id) on delete cascade,
  amount numeric(14, 2) not null,
  occurred_at date not null,
  note text not null default '',
  created_at timestamptz not null default now()
);

create index goal_contributions_goal_id_idx on goal_contributions (goal_id);

alter table goals enable row level security;
alter table goal_contributions enable row level security;

create policy "members can read goals" on goals
  for select using (is_household_member(household_id));
create policy "members can write goals" on goals
  for insert with check (is_household_member(household_id));
create policy "members can update goals" on goals
  for update using (is_household_member(household_id));
create policy "members can delete goals" on goals
  for delete using (is_household_member(household_id));

create policy "members can read goal contributions" on goal_contributions
  for select using (exists (select 1 from goals g where g.id = goal_id and is_household_member(g.household_id)));
create policy "members can write goal contributions" on goal_contributions
  for insert with check (exists (select 1 from goals g where g.id = goal_id and is_household_member(g.household_id)));
create policy "members can update goal contributions" on goal_contributions
  for update using (exists (select 1 from goals g where g.id = goal_id and is_household_member(g.household_id)));
create policy "members can delete goal contributions" on goal_contributions
  for delete using (exists (select 1 from goals g where g.id = goal_id and is_household_member(g.household_id)));

-- Debts: balance is stored positive (amount owed). Payoff order (avalanche /
-- snowball / custom) is a view choice, computed client-side from rate and
-- balance — nothing here is strategy-specific.

create table debts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  owner_member_id uuid references household_members(id) on delete set null,
  is_shared boolean not null default true,
  name text not null,
  note text not null default '',
  balance numeric(14, 2) not null,
  apr_pct numeric(6, 3) not null,
  minimum_payment numeric(14, 2) not null,
  custom_rank int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index debts_household_id_idx on debts (household_id);

alter table debts enable row level security;

create policy "members can read debts" on debts
  for select using (is_household_member(household_id));
create policy "members can write debts" on debts
  for insert with check (is_household_member(household_id));
create policy "members can update debts" on debts
  for update using (is_household_member(household_id));
create policy "members can delete debts" on debts
  for delete using (is_household_member(household_id));

-- One row per household: the extra-payment commitment behind the debt
-- projection, and the forecast assumptions behind the FI projection.
-- baseline_* is snapshotted the first time assumptions are ever saved and
-- never moves after that — it's the "original plan" the current numbers are
-- compared against. Editing assumptions again only moves the current_*
-- columns.

create table planning_assumptions (
  household_id uuid primary key references households(id) on delete cascade,
  nominal_return_pct numeric(6, 3) not null default 6.0,
  inflation_pct numeric(6, 3) not null default 2.5,
  safe_withdrawal_pct numeric(6, 3) not null default 4.0,
  lean_annual_spend numeric(14, 2),
  debt_extra_payment numeric(14, 2),
  debt_assume_no_new_card_spend boolean,
  baseline_set_at timestamptz,
  baseline_nominal_return_pct numeric(6, 3),
  baseline_inflation_pct numeric(6, 3),
  baseline_monthly_saving numeric(14, 2),
  updated_at timestamptz not null default now()
);

alter table planning_assumptions enable row level security;

create policy "members can read planning assumptions" on planning_assumptions
  for select using (is_household_member(household_id));
create policy "members can write planning assumptions" on planning_assumptions
  for insert with check (is_household_member(household_id));
create policy "members can update planning assumptions" on planning_assumptions
  for update using (is_household_member(household_id));
