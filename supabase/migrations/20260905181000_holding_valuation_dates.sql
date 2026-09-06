-- QA-04 (SHR-245) / SHR-254 recheck: Refresh falsely certified stale prices.
--
-- `last_refreshed` conflated two different facts: when the holding was last
-- priced, and when its record was last touched. The Investments "Refresh"
-- button wrote it without retrieving a single price, and renaming a holding
-- advanced it too — so the staleness warning could be dismissed without
-- anything being repriced.
--
-- The correct name for what this actually has to mean is `priced_at`. The
-- first version of this migration did `rename column last_refreshed to
-- priced_at`, which is not deployable: a currently-live client still writes
-- `last_refreshed` (the pre-9bd6a59 holdings editor), and this repository's
-- new editor writes `priced_at`. Whichever of the migration or the client
-- deploy lands first, the other would immediately start failing writes
-- against a column that no longer exists.
--
-- Deployment order (see docs/holdings-priced-at-migration.md for the full
-- writeup and rollback plan):
--   1. Apply this migration. It is purely additive — no column is renamed
--      or dropped — so it is safe against both the old and the new client
--      being deployed, in either order, at the same time.
--   2. Deploy the new client (this repository). It reads/writes priced_at;
--      the old client, if still running anywhere, keeps reading/writing
--      last_refreshed. The trigger below keeps both columns in lockstep
--      regardless of which one a given write touches.
--   3. Once no client still writes last_refreshed, a follow-up migration
--      can drop it (and this trigger). Not included here — that step is a
--      deliberate, separate decision, not something to bundle into the
--      migration that makes the rename possible in the first place.

alter table holdings add column priced_at timestamptz;

comment on column holdings.priced_at is
  'When the stored value/price was last confirmed as of. Advances only when a valuation is entered and confirmed — never by reloading the screen or editing a name. Kept in sync with last_refreshed by holdings_sync_priced_at() until every client writes priced_at directly and last_refreshed can be dropped.';
comment on column holdings.last_refreshed is
  'Deprecated in favour of priced_at (SHR-245/SHR-254) — kept only for a client that still writes it. Do not read from this column in new code.';
comment on column holdings.updated_at is
  'When the record was last edited. Unrelated to how fresh the valuation is.';

-- Existing rows: last_refreshed is the only history there is, so it seeds
-- priced_at. A holding nobody has priced under either name stays null under
-- both — "never confirmed" is not the same as "confirmed at epoch".
update holdings set priced_at = last_refreshed where last_refreshed is not null;

-- Whichever column a write actually touches, the other is kept equal to it,
-- so a reader of either sees the same value regardless of which client (old
-- or new) produced the row.
create or replace function holdings_sync_priced_at()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.priced_at is null then
      new.priced_at := new.last_refreshed;
    elsif new.last_refreshed is null then
      new.last_refreshed := new.priced_at;
    end if;
    return new;
  end if;

  -- UPDATE: whichever of the two the caller actually changed wins and is
  -- copied onto the other. A caller that touches neither leaves both as they
  -- were; a caller that (unusually) sets both explicitly to different
  -- values has priced_at win, since that is the column new code is meant to
  -- write.
  if new.priced_at is distinct from old.priced_at then
    new.last_refreshed := new.priced_at;
  elsif new.last_refreshed is distinct from old.last_refreshed then
    new.priced_at := new.last_refreshed;
  end if;
  return new;
end;
$$;

create trigger holdings_sync_priced_at_trigger
  before insert or update on holdings
  for each row
  execute function holdings_sync_priced_at();

comment on function holdings_sync_priced_at is
  'Keeps holdings.priced_at and holdings.last_refreshed equal during the transition between the two (SHR-254): whichever column an old or new client writes, the other is kept in sync so neither client silently reads a stale value written by the other.';
