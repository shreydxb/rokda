-- Enough of the Supabase platform for the repository's migrations to apply to a
-- plain PostgreSQL instance (QA-12, SHR-253).
--
-- The migrations reference platform objects a hosted Supabase project
-- provides but a bare Postgres does not: the `auth.users` table that
-- household_members points at, `auth.uid()`, and `auth.role()` -- every RLS
-- policy is written against one or the other. This shim creates just those,
-- so `scripts/verify-migrations.sh` can prove a fresh database is buildable
-- from the repository alone.
--
-- It is a TEST harness. It is never applied to a real environment, and it is
-- deliberately not a migration.

-- Every hosted Supabase project has these three roles built in; migrations
-- grant/revoke against them by name (e.g. `revoke execute ... from anon,
-- authenticated`) without ever creating them, since on Supabase they already
-- exist. `do` + exception guards them against a second run of this shim.
do $$
begin
  create role anon;
exception when duplicate_object then null;
end
$$;

do $$
begin
  create role authenticated;
exception when duplicate_object then null;
end
$$;

do $$
begin
  create role service_role;
exception when duplicate_object then null;
end
$$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);

-- On Supabase this reads the JWT claim. Here it simply returns null unless a
-- test sets request.jwt.claim.sub, which is all the policies need to compile.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- On Supabase this reads the JWT's `role` claim (typically 'authenticated',
-- 'anon', or 'service_role'). Here it falls back to the current Postgres
-- role name unless a test sets request.jwt.claim.role, which is enough for
-- an RLS policy referencing auth.role() to compile and be exercised.
create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), current_user);
$$;

-- Enough of Supabase Storage for one migration's bucket seed + RLS policy:
-- the buckets/objects tables an insert and a `create policy` reference, and
-- storage.foldername(), which splits an object path into its directory
-- segments the same way the real extension does.
create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text
);

create or replace function storage.foldername(name text)
returns text[]
language plpgsql
immutable
as $$
declare
  parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[1:array_length(parts, 1) - 1];
end;
$$;

-- Enough of Supabase Vault for the functions that read secrets by name
-- (get_telegram_webhook_secret and the cron job bodies) to compile against a
-- real relation. Empty on a fresh database -- there is no secret to
-- decrypt here, only the shape a `select ... from vault.decrypted_secrets
-- where name = ...` needs to exist.
create schema if not exists vault;

create table if not exists vault.decrypted_secrets (
  id uuid primary key default gen_random_uuid(),
  name text,
  decrypted_secret text
);
