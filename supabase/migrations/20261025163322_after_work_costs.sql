-- Costs that start when work stops (Planning audit, 3.13): health cover, which
-- an employer pays until then and which costs more with every year of age,
-- and residence visa fees. The Life plan adds them to spending after work
-- stops; without them a plan was built on today's spending, which leaves out
-- exactly the costs the household does not pay today.
--
-- Amounts are a year, in today's money at today's prices and ages, like every
-- other planning figure, and can be in rupees or dollars like other income.
-- rise_pct is how much faster than inflation a cost grows each year, counted
-- from now: cover priced at today's ages costs more of today's money by the
-- time work stops, and goes on rising. A cost for each person counts once for
-- each person the plan still covers, so cover for two halves when one
-- remains. Timing counts from the year work stops, as other income's does.
create table after_work_costs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  name text not null,
  -- A year, in `currency`.
  amount numeric(14, 2) not null,
  currency text not null default 'AED',
  per_person boolean not null default false,
  rise_pct numeric(5, 2) not null default 0,
  -- 0 means from the year work stops.
  starts_after_years int not null default 0,
  -- How many years it lasts. Null means for good.
  lasts_years int,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint after_work_costs_name_present check (length(btrim(name)) > 0),
  constraint after_work_costs_amount_positive check (amount > 0),
  constraint after_work_costs_currency check (currency in ('AED', 'USD', 'INR')),
  constraint after_work_costs_rise_range check (rise_pct between 0 and 10),
  constraint after_work_costs_starts_range check (starts_after_years between 0 and 60),
  constraint after_work_costs_lasts_range check (lasts_years is null or lasts_years between 1 and 60)
);

create index after_work_costs_household_id_idx on after_work_costs (household_id);

alter table after_work_costs enable row level security;

create policy "members can read after-work costs" on after_work_costs
  for select using (private.is_household_member(household_id));
create policy "members can add after-work costs" on after_work_costs
  for insert with check (private.is_household_member(household_id));
-- No separate WITH CHECK: Postgres applies USING to the new row as well, so a
-- member cannot move a row into another household by rewriting household_id.
create policy "members can update after-work costs" on after_work_costs
  for update using (private.is_household_member(household_id));
create policy "members can delete after-work costs" on after_work_costs
  for delete using (private.is_household_member(household_id));

create trigger after_work_costs_touch_updated_at before update on after_work_costs for each row execute function touch_updated_at();

comment on table after_work_costs is
  'Costs that start when work stops (health cover, visa fees), a year in today''s money. The Life plan adds them to spending after work stops.';
comment on column after_work_costs.per_person is
  'True when the amount is for each person: counted once for each person the plan still covers.';
comment on column after_work_costs.rise_pct is
  'How much faster than inflation the cost grows each year, counted from now (health cover rising with age). 0 keeps it level in today''s money.';
comment on column after_work_costs.starts_after_years is
  'Years after work stops that the cost starts; 0 is the year work stops.';
