-- Money a household expects to come in once it stops working, other than its
-- own savings: rent from a property, part-time or consulting work, or a
-- one-off sum such as an end-of-service gratuity or a planned sale. Drawdown
-- spends it before touching the pot, and Forecast lowers the independence
-- target by any yearly income that starts at independence and lasts for good.
--
-- Amounts are AED in today's money, like every other planning figure: a yearly
-- amount keeps its buying power, a lump sum is what it would buy today.
-- Timing is relative to independence, not a calendar date, because the
-- independence year is itself a projection that moves.
create table independence_income (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  name text not null,
  kind text not null,
  -- Per year for 'yearly'; the whole sum for 'lump_sum'.
  amount numeric(14, 2) not null,
  -- 0 means from the first year of independence.
  starts_after_years int not null default 0,
  -- 'yearly' only: how many years it pays. Null means for good.
  lasts_years int,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint independence_income_household_id_id_key unique (household_id, id),
  constraint independence_income_name_present check (length(btrim(name)) > 0),
  constraint independence_income_kind check (kind in ('yearly', 'lump_sum')),
  constraint independence_income_amount_positive check (amount > 0),
  constraint independence_income_starts_range check (starts_after_years between 0 and 60),
  constraint independence_income_lasts_range check (lasts_years is null or lasts_years between 1 and 60),
  -- A lump sum is paid once; a duration on it would mean nothing.
  constraint independence_income_lump_sum_once check (kind = 'yearly' or lasts_years is null)
);

create index independence_income_household_id_idx on independence_income (household_id);

alter table independence_income enable row level security;

create policy "members can read independence income" on independence_income
  for select using (is_household_member(household_id));
create policy "members can write independence income" on independence_income
  for insert with check (is_household_member(household_id));
-- No separate WITH CHECK: Postgres applies USING to the new row as well, so a
-- member cannot move a row into another household by rewriting household_id.
create policy "members can update independence income" on independence_income
  for update using (is_household_member(household_id));
create policy "members can delete independence income" on independence_income
  for delete using (is_household_member(household_id));
