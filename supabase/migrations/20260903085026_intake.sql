-- Receipt/voice-note intake queue. Rows land here from an external source
-- (Telegram bot, not built yet) or are seeded by hand; the app's job is
-- only to review/correct/approve into a real transaction, or reject.

create table intake (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  source text not null default 'manual' check (source in ('telegram', 'manual')),
  raw_text text,
  parsed_amount numeric(14, 2),
  parsed_merchant text,
  parsed_category_id uuid references categories(id) on delete set null,
  parsed_date date,
  confidence numeric(3, 2) check (confidence between 0 and 1),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);

create index intake_household_id_idx on intake (household_id);
create index intake_household_status_idx on intake (household_id, status);

alter table intake enable row level security;

create policy "members can read intake" on intake
  for select using (is_household_member(household_id));
create policy "members can write intake" on intake
  for insert with check (is_household_member(household_id));
create policy "members can update intake" on intake
  for update using (is_household_member(household_id));
create policy "members can delete intake" on intake
  for delete using (is_household_member(household_id));
