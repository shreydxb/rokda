-- The life plan (Planning -> Life plan): one year-by-year timeline from today
-- to the end of the longest life expectancy. Saving and growth while working,
-- each goal paid in its year, then spending once work stops, and the year the
-- money runs out if it does -- the calculation a financial adviser's "cash
-- adequacy" sheet does, from the household's own figures.

-- Ages come from a birth year per member; the plan runs to the end of the year
-- each reaches their life expectancy. Kept apart from household_members, whose
-- rows carry the roles and ownership guards this has nothing to do with.
create table member_life (
  member_id uuid primary key,
  household_id uuid not null references households(id) on delete cascade,
  birth_year int not null,
  -- The age planned to, not a prediction: the plan covers the whole year the
  -- member reaches it.
  life_expectancy int not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Tenant-qualified: the member must belong to this same household.
  constraint member_life_member_fk foreign key (household_id, member_id)
    references household_members (household_id, id) on delete cascade,
  constraint member_life_birth_year_range check (birth_year between 1900 and 2100),
  constraint member_life_life_expectancy_range check (life_expectancy between 40 and 120)
);

-- Covers both foreign keys: household_id alone, and (household_id, member_id).
create index member_life_household_member_idx on member_life (household_id, member_id);

alter table member_life enable row level security;

create policy "members can read member life" on member_life
  for select using (is_household_member(household_id));
create policy "members can write member life" on member_life
  for insert with check (is_household_member(household_id));
-- No separate WITH CHECK: Postgres applies USING to the new row as well, so a
-- member cannot move a row into another household by rewriting household_id.
create policy "members can update member life" on member_life
  for update using (is_household_member(household_id));
create policy "members can delete member life" on member_life
  for delete using (is_household_member(household_id));

-- When work stops, and what life costs after it. Null means not set: the
-- screen asks for the year, spends at today's rate, earns the same return as
-- before, and spends the same once one person remains.
alter table planning_assumptions
  add column retirement_year int,
  -- AED a year in today's money.
  add column retirement_annual_spend numeric(14, 2),
  -- Nominal, like nominal_return_pct.
  add column retirement_return_pct numeric(6, 3),
  -- Spending once only one person remains, as a share of the couple's.
  add column survivor_spend_pct numeric(5, 2),
  add constraint planning_assumptions_retirement_year_range check (retirement_year is null or retirement_year between 2000 and 2200),
  add constraint planning_assumptions_retirement_spend_nonnegative check (retirement_annual_spend is null or retirement_annual_spend >= 0),
  add constraint planning_assumptions_retirement_return_range check (retirement_return_pct is null or retirement_return_pct between -20 and 50),
  add constraint planning_assumptions_survivor_spend_range check (survivor_spend_pct is null or survivor_spend_pct between 10 and 100);

-- Whether the life plan pays a dated goal out of the pot in its year. A car or
-- a down payment leaves the pot; an emergency fund is money kept, not spent.
alter table goals
  add column counts_in_life_plan boolean not null default true;
