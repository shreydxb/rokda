-- When the household's data was last backed up, and last restored from a
-- backup, in the app (docs/decisions.md, "A backup is recorded, and an old
-- one says so"; SHR-238).
--
-- Exports and restore drills are taken by hand (docs/backup-restore.md), and
-- their record lived in a table in that document, where nobody would notice
-- it going stale. Each one is now recorded here: an export or a drill, the
-- day it was done, whether it passed, and a note. Settings -> Backups shows
-- the latest of each, and Needs attention says so when no export has passed
-- for a while.
--
-- A record is kept, never edited or deleted: a mistaken entry is corrected by
-- recording again. Who recorded it is the signed-in member, worked out here,
-- not taken from the client.

create table backup_records (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  kind text not null check (kind in ('export', 'restore_drill')),
  result text not null check (result in ('passed', 'failed')),
  done_on date not null,
  note text,
  recorded_by uuid,
  created_at timestamptz not null default now(),
  constraint backup_records_note_size check (note is null or length(note) <= 2000),
  constraint backup_records_recorded_by_fk foreign key (household_id, recorded_by)
    references household_members (household_id, id) on delete set null (recorded_by)
);

create index backup_records_household_done_idx on backup_records (household_id, done_on desc);
create index backup_records_household_recorded_by_idx on backup_records (household_id, recorded_by);

create or replace function set_backup_record_author()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  select m.id into new.recorded_by
  from public.household_members m
  where m.household_id = new.household_id and m.user_id = auth.uid()
  limit 1;
  return new;
end;
$$;

revoke execute on function set_backup_record_author() from public, anon, authenticated;

create trigger backup_records_set_author
  before insert on backup_records
  for each row execute function set_backup_record_author();

alter table backup_records enable row level security;

create policy "members can read backup records" on backup_records
  for select using (private.is_household_member(household_id));
create policy "members can record backups" on backup_records
  for insert with check (private.is_household_member(household_id));

comment on table backup_records is
  'Each backup export and restore drill, as a member recorded it: kind, day, result and a note. Never edited or deleted. Shown in Settings -> Backups; an old or failed export shows in Needs attention.';
