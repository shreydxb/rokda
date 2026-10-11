-- Membership helpers move out of the API schema (security advisor, lint 0029).
--
-- is_household_member() and is_household_owner() are SECURITY DEFINER -- they
-- have to be, because they read household_members, which is itself behind
-- RLS -- and they lived in public, the schema the REST API serves. So every
-- signed-in user could call them over /rest/v1/rpc. That leaked nothing (each
-- answers only "am I in / do I own this household", about the caller), but a
-- definer function in the API schema is one edit away from leaking something,
-- and the advisor is right to keep saying so.
--
-- What moves, and what does not:
--
--   * The functions themselves move to `private`, which the API does not
--     serve. ALTER ... SET SCHEMA keeps each function's OID, owner and grants,
--     and a policy stores the OID of the function it calls, not its name. So
--     every policy that uses them -- each table's, and the receipt bucket's on
--     storage.objects -- now calls private.* without being recreated.
--     Rewriting some ninety policies by hand would have been the risky
--     version of this change.
--
--   * Two function bodies call them BY NAME, resolved at run time with
--     search_path = public: generate_telegram_link_code() and
--     guard_household_member_role(). Thin public wrappers with the old names
--     keep both working untouched. The wrappers run with the caller's rights,
--     so the advisor has nothing to flag, and they answer exactly what the old
--     functions answered.
--
--   * search_path becomes empty and every name is qualified, so nothing a
--     caller puts on its path can change what the definer functions read.
--
-- New policies call private.is_household_member(...) directly. The behaviour
-- tests refuse a policy that calls the public wrappers.

create schema if not exists private;

-- The API does not serve this schema (it is not among the project's exposed
-- schemas), so USAGE here exposes nothing over HTTP. Signed-in callers need
-- it all the same: every policy runs as its caller, and so do the wrappers
-- below, which look the private functions up by name. anon is named as well
-- as public in case the schema already existed with a grant of its own.
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

alter function public.is_household_member(uuid) set schema private;
alter function public.is_household_owner(uuid) set schema private;

-- The same bodies, with qualified names. CREATE OR REPLACE keeps the OID (so
-- the policies stay bound) and the grants; every other property is restated.
create or replace function private.is_household_member(hh_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.household_members
    where household_id = hh_id and user_id = auth.uid()
  );
$$;

create or replace function private.is_household_owner(hh_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.household_members
    where household_id = hh_id
      and user_id = auth.uid()
      and role = 'owner'
  );
$$;

-- The grants travel with the functions, but are stated here: on the hosted
-- project service_role holds EXECUTE through Supabase's default privileges and
-- a bare PostgreSQL (CI) does not, and anon must hold neither.
revoke execute on function private.is_household_member(uuid) from public, anon;
revoke execute on function private.is_household_owner(uuid) from public, anon;
grant execute on function private.is_household_member(uuid) to authenticated, service_role;
grant execute on function private.is_household_owner(uuid) to authenticated, service_role;

comment on function private.is_household_member(uuid) is
  'True when the calling user is a member of the given household. SECURITY DEFINER because household_members is itself behind RLS, and outside the API schema for that reason. Every RLS policy calls this one.';
comment on function private.is_household_owner(uuid) is
  'True when the calling user is an OWNER of the given household. The owner-gated half of private.is_household_member().';

-- The wrappers: invoker rights, pass the question on.
create function public.is_household_member(hh_id uuid)
returns boolean
language sql
security invoker
set search_path = ''
stable
as $$
  select private.is_household_member(hh_id);
$$;

create function public.is_household_owner(hh_id uuid)
returns boolean
language sql
security invoker
set search_path = ''
stable
as $$
  select private.is_household_owner(hh_id);
$$;

-- Supabase's default privileges grant EXECUTE on every new public function to
-- anon by name (20260906171215), so revoking from public alone is not enough.
revoke execute on function public.is_household_member(uuid) from public, anon;
revoke execute on function public.is_household_owner(uuid) from public, anon;
grant execute on function public.is_household_member(uuid) to authenticated, service_role;
grant execute on function public.is_household_owner(uuid) to authenticated, service_role;

comment on function public.is_household_member(uuid) is
  'Invoker-rights wrapper around private.is_household_member(), kept for generate_telegram_link_code(), which calls it by name. Policies call the private function directly.';
comment on function public.is_household_owner(uuid) is
  'Invoker-rights wrapper around private.is_household_owner(), kept for guard_household_member_role(), which calls it by name. Policies call the private function directly.';
