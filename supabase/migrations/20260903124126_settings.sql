-- Settings needs an owner to manage OTHER members' rows too — including a
-- placeholder member with no linked login yet, which no auth.uid() can ever
-- match — so the "self only" policies from the baseline schema are replaced
-- with household-wide ones, same trust model as every other table here.
drop policy "self can update own row" on household_members;
drop policy "self can leave" on household_members;

create policy "members can update household roster" on household_members
  for update using (is_household_member(household_id));
create policy "members can remove household roster" on household_members
  for delete using (is_household_member(household_id));

-- households had no update policy at all — renaming was impossible.
create policy "members can update their household" on households
  for update using (is_household_member(id));

-- Soft-delete via archived: a retired category keeps its name on every past
-- transaction that used it, rather than orphaning them.
alter table categories add column archived boolean not null default false;

-- Auto-categorization: a merchant-pattern rule can be applied on demand to
-- existing uncategorised transactions, and offered as a suggestion while
-- reviewing intake — never applied silently over a category someone chose.
create table category_rules (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  category_id uuid not null references categories(id) on delete cascade,
  pattern text not null,
  match_type text not null default 'contains' check (match_type in ('contains', 'starts_with')),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index category_rules_household_id_idx on category_rules (household_id);

alter table category_rules enable row level security;

create policy "members can read category rules" on category_rules
  for select using (is_household_member(household_id));
create policy "members can write category rules" on category_rules
  for insert with check (is_household_member(household_id));
create policy "members can update category rules" on category_rules
  for update using (is_household_member(household_id));
create policy "members can delete category rules" on category_rules
  for delete using (is_household_member(household_id));
