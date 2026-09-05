-- One row per category per calendar month. The Month/Year toggle in the UI
-- is a display concern, not a storage concern: "set a yearly budget" just
-- upserts the same amount across all 12 rows for that year.

create table budgets (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  category_id uuid not null references categories(id) on delete cascade,
  year int not null,
  month int not null check (month between 1 and 12),
  amount numeric(14, 2) not null check (amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, category_id, year, month)
);

create index budgets_household_id_idx on budgets (household_id);
create index budgets_household_year_idx on budgets (household_id, year);

alter table budgets enable row level security;

create policy "members can read budgets" on budgets
  for select using (is_household_member(household_id));
create policy "members can write budgets" on budgets
  for insert with check (is_household_member(household_id));
create policy "members can update budgets" on budgets
  for update using (is_household_member(household_id));
create policy "members can delete budgets" on budgets
  for delete using (is_household_member(household_id));
