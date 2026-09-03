-- Recurring bills / expected income. next_due_date is the last-known due
-- date; display logic rolls it forward by cadence to the next occurrence
-- rather than requiring the user to bump it after every payment.

create table recurring (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  name text not null,
  account_id uuid references accounts(id) on delete set null,
  category_id uuid references categories(id) on delete set null,
  owner_member_id uuid references household_members(id) on delete set null,
  is_shared boolean not null default true,
  amount numeric(14, 2) not null, -- negative = bill, positive = expected income
  currency text not null default 'AED',
  cadence text not null check (cadence in ('weekly', 'monthly', 'quarterly', 'yearly')),
  next_due_date date not null,
  autopay boolean not null default false,
  is_fixed boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index recurring_household_id_idx on recurring (household_id);

alter table recurring enable row level security;

create policy "members can read recurring" on recurring
  for select using (is_household_member(household_id));
create policy "members can write recurring" on recurring
  for insert with check (is_household_member(household_id));
create policy "members can update recurring" on recurring
  for update using (is_household_member(household_id));
create policy "members can delete recurring" on recurring
  for delete using (is_household_member(household_id));
