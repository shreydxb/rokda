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
--
-- This used to digest the ids ALONE (QA #1). Every id matching proves the
-- memberships still resolve; it proves nothing about whether anyone can sign
-- in. A restore that brought the right user rows with a changed email, a lost
-- password hash or a cleared email_confirmed_at passed with an identical
-- fingerprint and an account nobody could get into. The columns below are the
-- ones a sign-in actually depends on. They are digested, never printed, so the
-- fingerprint file carries no credential material -- an md5 of a bcrypt hash
-- is not a password.
--
-- Built from information_schema so a column this Postgres does not have is
-- skipped rather than failing the whole run -- the local test shim has a
-- cut-down auth.users, and a fingerprint that only runs in one place is not
-- much of a check.
select 'auth.users' as scope,
       (xpath('/row/c/text()', x))[1]::text || ' ' || (xpath('/row/d/text()', x))[1]::text as detail
from (
  select query_to_xml(format(
    'select count(*) as c, coalesce(md5(string_agg(t::text, E''\n'' order by t::text)), ''-'') as d from (select %s from auth.users) t',
    coalesce((select string_agg(quote_ident(column_name), ', ' order by column_name)
                from information_schema.columns
               where table_schema = 'auth' and table_name = 'users'
                 and column_name in ('id', 'email', 'encrypted_password', 'email_confirmed_at',
                                     'banned_until', 'deleted_at', 'role', 'aud')), 'id')
  ), false, true, '') as x
) s;

-- The link between a login and its provider. Absent from the dump in §3 and
-- from this fingerprint until QA #1: auth.users alone may not be enough for
-- GoTrue to complete a sign-in, and "may not be" is the problem -- nothing
-- here can settle it, only an actual login drill can (§5). What this can do is
-- stop the restore from silently losing a table nobody was looking at.
select 'auth.identities' as scope,
       (xpath('/row/c/text()', x))[1]::text || ' ' || (xpath('/row/d/text()', x))[1]::text as detail
from (
  select query_to_xml(format(
    'select count(*) as c, coalesce(md5(string_agg(t::text, E''\n'' order by t::text)), ''-'') as d from (select %s from auth.identities) t',
    coalesce((select string_agg(quote_ident(column_name), ', ' order by column_name)
                from information_schema.columns
               where table_schema = 'auth' and table_name = 'identities'
                 and column_name in ('id', 'user_id', 'provider', 'provider_id', 'email')), 'user_id')
  ), false, true, '') as x
) s
where to_regclass('auth.identities') is not null;

-- Storage. The runbook said "1 bucket, 0 objects -- nothing to lose today",
-- and by the time it was reviewed there was a receipt in there, referenced by
-- intake.photo_path. Nothing noticed, because nothing looked (QA #1).
--
-- Object BYTES are not in any dump either -- see §3, which now exports them
-- separately. This digests the metadata: which objects exist, in which bucket,
-- how large, and the storage layer's own etag per object. That is enough to
-- catch a restore that brought the database and left the files, which is the
-- failure that actually happened to be available.
select 'storage.buckets' as scope,
       (xpath('/row/c/text()', x))[1]::text || ' ' || (xpath('/row/d/text()', x))[1]::text as detail
from (
  select query_to_xml(
    'select count(*) as c, coalesce(md5(string_agg(t::text, E''\n'' order by t::text)), ''-'') as d from (select id, name, public from storage.buckets) t',
    false, true, '') as x
) s
where to_regclass('storage.buckets') is not null;

select 'storage.objects' as scope,
       (xpath('/row/c/text()', x))[1]::text || ' ' || (xpath('/row/d/text()', x))[1]::text as detail
from (
  select query_to_xml(format(
    'select count(*) as c, coalesce(md5(string_agg(t::text, E''\n'' order by t::text)), ''-'') as d from (select %s from storage.objects) t',
    case
      when exists (select 1 from information_schema.columns
                    where table_schema = 'storage' and table_name = 'objects' and column_name = 'metadata')
      then 'bucket_id, name, metadata->>''size'' as size, metadata->>''eTag'' as etag'
      else 'bucket_id, name'
    end
  ), false, true, '') as x
) s
where to_regclass('storage.objects') is not null;

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
