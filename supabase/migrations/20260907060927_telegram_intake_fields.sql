-- SHR-236: attribute intake rows to the household member who sent them, and
-- give Telegram delivery retries a real dedup key. `source_ref` mirrors the
-- name PR #1 (SHR-252, unmerged, targeting dev) independently added for the
-- same reason -- if that PR merges, whoever reconciles needs to notice this
-- migration already created the column rather than re-adding it.
alter table intake
  add column member_id uuid references household_members(id) on delete set null,
  add column source_ref text,
  add column photo_path text;

create unique index intake_source_ref_key on intake (household_id, source, source_ref) where source_ref is not null;

comment on column intake.member_id is 'Household member who sent this (resolved from their linked Telegram account). Null for source=manual.';
comment on column intake.source_ref is 'Source-system delivery id (Telegram update_id) so a redelivered webhook cannot create a duplicate intake row.';
comment on column intake.photo_path is 'Path within the telegram-receipts storage bucket, when this intake row came with a photo.';

insert into storage.buckets (id, name, public)
values ('telegram-receipts', 'telegram-receipts', false)
on conflict (id) do nothing;

-- Path convention: <household_id>/<uuid>.<ext> -- the first path segment is
-- the household id, checked against the caller's own membership.
create policy "household members can read their receipt photos"
on storage.objects for select
using (
  bucket_id = 'telegram-receipts'
  and is_household_member((storage.foldername(name))[1]::uuid)
);
