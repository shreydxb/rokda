-- QA-04 (SHR-245) / SHR-254 recheck: Refresh falsely certified stale prices.
--
-- `last_refreshed` conflated two different facts: when the holding was last
-- priced, and when its record was last touched. The Investments "Refresh"
-- button wrote it without retrieving a single price, and renaming a holding
-- advanced it too — so the staleness warning could be dismissed without
-- anything being repriced.
--
-- The correct name for what this actually has to mean is `priced_at`. An
-- earlier version of this migration did `rename column last_refreshed to
-- priced_at`, which is not deployable at all: a currently-live client still
-- writes `last_refreshed` (the pre-9bd6a59 holdings editor). A later version
-- made this additive instead, but claimed the migration and the client
-- deploy could then land "in either order" — that is false. This
-- repository's client (from this migration's own commit onward) sends
-- `priced_at` in every holdings insert/update unconditionally; deploying it
-- before this migration runs means every one of those writes fails outright
-- (the column doesn't exist yet). The migration MUST be applied first. It
-- is additive and only takes a fraction of a second, so there is no
-- meaningful window where deploying it "early" costs anything — there is
-- only a real failure mode for deploying the client early.
--
-- Deployment order (see docs/holdings-priced-at-migration.md for the full
-- writeup, rollback plan, and why this applies to every one of the five
-- migrations pending at this commit, not only this one):
--   1. Apply this migration FIRST, before deploying this repository's
--      client build. It is additive — no column is renamed or dropped — so
--      it does not break the client that is live right now (the old
--      holdings editor, which only knows about last_refreshed).
--   2. Deploy the new client. It writes priced_at, which now exists; the
--      old client, if still running anywhere, keeps reading/writing
--      last_refreshed exactly as before — untouched by this migration.
--   3. Once no client still writes last_refreshed, a follow-up migration
--      can drop it (and the trigger below). Not included here — that step
--      is a deliberate, separate decision, not something to bundle into
--      the migration that makes the transition possible in the first place.

alter table holdings add column priced_at timestamptz;

comment on column holdings.priced_at is
  'When the stored value/price was last confirmed as of. Advances only when a valuation is entered and confirmed through the new editor — never by reloading the screen, editing a name, or a legacy client touching last_refreshed. See holdings_sync_priced_at().';
comment on column holdings.last_refreshed is
  'Deprecated in favour of priced_at (SHR-245/SHR-254) — kept only for a client that still writes it. Do not read from this column in new code. A write to this column never advances priced_at (see holdings_sync_priced_at()): a legacy client can still touch it without that being mistaken for a confirmed valuation.';
comment on column holdings.updated_at is
  'When the record was last edited. Unrelated to how fresh the valuation is.';

-- Existing rows: last_refreshed is the only history there is, so it seeds
-- priced_at as a ONE-TIME backfill. This is unverified legacy provenance,
-- not a newly confirmed valuation — the old client wrote last_refreshed on
-- every save, repricing or not (that conflation is exactly what SHR-245
-- fixed), so a backfilled priced_at may be no more trustworthy than the
-- column it came from. It is still better than leaving every existing
-- holding looking never-priced. A holding nobody has valued under either
-- name stays null under both.
update holdings set priced_at = last_refreshed where last_refreshed is not null;

-- One-directional on purpose (SHR-254 recheck): the new client's priced_at
-- is a genuine, confirmed valuation, so it is safe to also copy onto
-- last_refreshed for a legacy reader's benefit. The reverse is NOT safe — a
-- legacy client writes last_refreshed on every save, including a bare
-- rename or its own non-repricing "Refresh" action, so mirroring THAT onto
-- priced_at would resurrect the exact bug SHR-245 fixed (a rename or a
-- refresh falsely certifying a stale valuation as current), just moved from
-- one column to the other during the migration window. Preserving the old
-- client's compatibility means its reads and writes of last_refreshed keep
-- working unmodified — not that every one of its writes gets to move the
-- new freshness signal.
create or replace function holdings_sync_priced_at()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.priced_at is not null and new.last_refreshed is null then
      new.last_refreshed := new.priced_at;
    end if;
    return new;
  end if;

  -- UPDATE: only a change to priced_at propagates, and only onto
  -- last_refreshed. A caller that changes last_refreshed alone (the legacy
  -- client, on any save) leaves priced_at exactly as it was.
  if new.priced_at is distinct from old.priced_at then
    new.last_refreshed := new.priced_at;
  end if;
  return new;
end;
$$;

create trigger holdings_sync_priced_at_trigger
  before insert or update on holdings
  for each row
  execute function holdings_sync_priced_at();

comment on function holdings_sync_priced_at is
  'One-directional compatibility shim (SHR-254): a priced_at write (the new client, a genuine confirmed valuation) is also copied onto last_refreshed for any remaining legacy reader. A last_refreshed write (the legacy client, which cannot distinguish a rename/refresh from a real reprice) never moves priced_at — mirroring it would falsely certify a stale valuation as current again, undoing SHR-245.';
