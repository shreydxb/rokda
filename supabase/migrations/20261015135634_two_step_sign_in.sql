-- Signing in takes a password and a code (docs/decisions.md, "Signing in
-- takes a password and a code"; SHR-312).
--
-- The app now shows nothing of the household until the session has passed a
-- second step: a code from an authenticator app, which Supabase Auth records
-- in the session as aal2. That is the app. This makes the database hold the
-- same rule, so a password alone cannot read the ledger through the API
-- either: a member who has an authenticator gets nothing from an aal1
-- session.
--
-- Every household policy (each table's, and the receipt bucket's) calls
-- private.is_household_member() or private.is_household_owner(). The rule is
-- added to both bodies; CREATE OR REPLACE keeps their OIDs, so every policy
-- picks it up without being recreated.
--
-- A member with no authenticator yet is not refused. The app has them add one
-- before it shows anything, but refusing in the database first would lock out
-- everyone who has not, including through the app's own add-one screen, which
-- has no household data to read anyway. Once both members have one, every
-- read of the household needs a code. Losing the phone: the owner removes the
-- member's factor in the Supabase dashboard (Authentication -> Users), and the
-- member adds a new one at their next sign-in.

create or replace function private.mfa_satisfied()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors f
        where f.user_id = auth.uid() and f.status::text = 'verified'
      );
$$;

revoke execute on function private.mfa_satisfied() from public, anon;
grant execute on function private.mfa_satisfied() to authenticated, service_role;

comment on function private.mfa_satisfied() is
  'True when the session has passed its second step (aal2), or the caller has no verified authenticator yet. SECURITY DEFINER to read auth.mfa_factors. Part of every membership check.';

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
  ) and private.mfa_satisfied();
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
  ) and private.mfa_satisfied();
$$;

comment on function private.is_household_member(uuid) is
  'True when the calling user is a member of the given household and the session has passed its second step if they have an authenticator (private.mfa_satisfied). SECURITY DEFINER because household_members is itself behind RLS. Every RLS policy calls this one.';
comment on function private.is_household_owner(uuid) is
  'True when the calling user is an OWNER of the given household, under the same second-step rule as private.is_household_member().';
