-- Household notes (Planning -> Notes): the plan in words. The figures live in
-- goals, budgets and categories; the reasons behind them (why this split, why
-- this order, what is still to decide) had nowhere to go but a chat. Kept in
-- the app, behind the household's login, rather than in the repository.
create table household_notes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  title text not null,
  -- Plain text with light markdown: headings, bullets, **bold**.
  body text not null default '',
  position int not null default 0,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint household_notes_title_present check (btrim(title) <> ''),
  constraint household_notes_body_size check (length(body) <= 50000),
  constraint household_notes_updated_by_fk foreign key (household_id, updated_by)
    references household_members (household_id, id) on delete set null (updated_by)
);

create index household_notes_household_idx on household_notes (household_id, position);

alter table household_notes enable row level security;

create policy "members can read household notes" on household_notes
  for select using (is_household_member(household_id));
create policy "members can write household notes" on household_notes
  for insert with check (is_household_member(household_id));
-- USING applies to the new row too, so a note cannot be moved to another household.
create policy "members can update household notes" on household_notes
  for update using (is_household_member(household_id));
create policy "members can delete household notes" on household_notes
  for delete using (is_household_member(household_id));

comment on table household_notes is
  'The household plan in words: why the goals, budget and split are what they are, and what is still open. Shown in Planning -> Notes.';
