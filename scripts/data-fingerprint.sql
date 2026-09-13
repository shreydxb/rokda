-- A comparable fingerprint of the DATA, for proving a restore actually
-- restored it (SHR-238).
--
-- Row counts alone do not prove a restore: a dump that loaded every row with a
-- column silently dropped, a numeric truncated, or a timestamp shifted by a
-- timezone still counts the same. This digests the rows themselves, so the two
-- sides either match or they do not.
--
-- Run against the source and the restored database and diff the two outputs:
--
--   psql -At -f scripts/data-fingerprint.sql "$SOURCE_URL"  > /tmp/source.txt
--   psql -At -f scripts/data-fingerprint.sql "$RESTORED_URL" > /tmp/restored.txt
--   diff /tmp/source.txt /tmp/restored.txt && echo "restore verified"
--
-- Rows are aggregated in sorted order, not physical order, because a restore
-- is under no obligation to reproduce heap order and a fingerprint that
-- depended on it would fail every time while proving nothing.
--
-- Caveats, both deliberate:
--   - `t::text` is a row's text rendering, so this compares content AND column
--     order. Restoring into a DIFFERENT major PostgreSQL version, or after a
--     migration that reorders columns, can change the rendering without any
--     data being wrong. Compare like with like; the source's version is
--     recorded in the header below so a mismatch is visible rather than
--     mysterious.
--   - vault.secrets is deliberately absent. Its contents are encrypted with a
--     key that does not travel with a dump, so a digest would differ on every
--     restore whether or not anything was lost. Secrets are re-provisioned,
--     not restored -- see docs/backup-restore.md.

\pset pager off

select 'postgres_version' as scope, version() as detail;

-- The logins. household_members.user_id references auth.users, so a restore
-- that brings the public schema alone leaves every membership pointing at
-- nothing -- and the app resolves a household by exactly that column.
select 'auth.users' as scope,
       count(*)::text || ' ' || coalesce(md5(string_agg(id::text, ',' order by id::text)), '-') as detail
from auth.users;

-- Every application table, counted and digested.
select s.table_name as scope,
       (xpath('/row/c/text()', x))[1]::text || ' ' || (xpath('/row/d/text()', x))[1]::text as detail
from (
  select table_name,
         query_to_xml(format(
           'select count(*) as c, coalesce(md5(string_agg(t::text, E''\n'' order by t::text)), ''-'') as d from public.%I t',
           table_name), false, true, '') as x
  from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE'
) s
order by s.table_name;
