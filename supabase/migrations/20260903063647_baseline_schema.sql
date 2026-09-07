-- Baseline schema: households, membership, categories, accounts, transactions.
-- RLS is scoped per-household via household_members, not per-row owner, since
-- most data (shared accounts, joint transactions) is legitimately visible to
-- both household members.

create extension if not exists pgcrypto;

create table households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table household_members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  display_name text not null,
  role text not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  unique (household_id, user_id)
);

create index household_members_household_id_idx on household_members (household_id);
create index household_members_user_id_idx on household_members (user_id);

-- security definer so policies on other tables can check membership without
-- being blocked by household_members' own RLS (which would recurse).
create or replace function is_household_member(hh_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from household_members
    where household_id = hh_id and user_id = auth.uid()
  );
$$;

create table categories (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('income', 'expense')),
  parent_id uuid references categories(id) on delete set null,
  created_at timestamptz not null default now()
);

create index categories_household_id_idx on categories (household_id);

create table accounts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  owner_member_id uuid references household_members(id) on delete set null, -- null = shared/joint
  name text not null,
  type text not null check (type in ('checking', 'savings', 'credit_card', 'investment', 'loan', 'cash', 'other')),
  currency text not null default 'AED',
  balance numeric(14, 2) not null default 0,
  is_shared boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index accounts_household_id_idx on accounts (household_id);

create table transactions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  account_id uuid not null references accounts(id) on delete cascade,
  owner_member_id uuid references household_members(id) on delete set null,
  category_id uuid references categories(id) on delete set null,
  amount numeric(14, 2) not null, -- negative = spend, positive = income, in account currency
  currency text not null default 'AED',
  merchant text,
  note text,
  occurred_at date not null default current_date,
  is_shared boolean not null default false,
  needs_review boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index transactions_household_id_idx on transactions (household_id);
create index transactions_account_id_idx on transactions (account_id);
create index transactions_occurred_at_idx on transactions (occurred_at);

alter table households enable row level security;
alter table household_members enable row level security;
alter table categories enable row level security;
alter table accounts enable row level security;
alter table transactions enable row level security;

-- households: any signed-in user may create one (they self-join as the first
-- member in the same transaction); membership then gates everything else.
create policy "members can read their household" on households
  for select using (is_household_member(id));
create policy "authenticated users can create a household" on households
  for insert with check (auth.uid() is not null);

-- household_members: self-join covers bootstrap (no existing member row yet);
-- an existing member can add/manage others (invites).
create policy "members can read household roster" on household_members
  for select using (is_household_member(household_id));
create policy "self-join or existing member can add" on household_members
  for insert with check (user_id = auth.uid() or is_household_member(household_id));
create policy "self can update own row" on household_members
  for update using (user_id = auth.uid());
create policy "self can leave" on household_members
  for delete using (user_id = auth.uid());

create policy "members can read categories" on categories
  for select using (is_household_member(household_id));
create policy "members can write categories" on categories
  for insert with check (is_household_member(household_id));
create policy "members can update categories" on categories
  for update using (is_household_member(household_id));
create policy "members can delete categories" on categories
  for delete using (is_household_member(household_id));

create policy "members can read accounts" on accounts
  for select using (is_household_member(household_id));
create policy "members can write accounts" on accounts
  for insert with check (is_household_member(household_id));
create policy "members can update accounts" on accounts
  for update using (is_household_member(household_id));
create policy "members can delete accounts" on accounts
  for delete using (is_household_member(household_id));

create policy "members can read transactions" on transactions
  for select using (is_household_member(household_id));
create policy "members can write transactions" on transactions
  for insert with check (is_household_member(household_id));
create policy "members can update transactions" on transactions
  for update using (is_household_member(household_id));
create policy "members can delete transactions" on transactions
  for delete using (is_household_member(household_id));
