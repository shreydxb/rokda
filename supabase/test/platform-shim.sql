-- Enough of the Supabase platform for the repository's migrations to apply to a
-- plain PostgreSQL instance (QA-12, SHR-253).
--
-- The migrations reference two things a hosted Supabase project provides but a
-- bare Postgres does not: the `auth.users` table that household_members points
-- at, and `auth.uid()`, which every RLS policy is written against. This shim
-- creates just those, so `scripts/verify-migrations.sh` can prove a fresh
-- database is buildable from the repository alone.
--
-- It is a TEST harness. It is never applied to a real environment, and it is
-- deliberately not a migration.

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
