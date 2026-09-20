-- An owner who cannot sign in is not an owner (QA #3).
--
-- "Owner" is an authorization boundary in this schema: is_household_owner()
-- decides who may add, edit or remove roster rows, and since
-- 20260913153028 it is the ONLY way roster rows can be written at all. That
-- function asks whether the caller's own row is an owner -- so it answers for
-- a person, via user_id = auth.uid().
--
-- household_members_keep_an_owner() guards the same boundary and asks a
-- different question: does a row labelled 'owner' still exist. Those two come
-- apart the moment a row is labelled 'owner' with no user_id behind it, and
-- the app offers exactly that: MemberEditor adds placeholder members with
-- user_id null (a partner who has no login yet), and its role chips let one be
-- made an owner.
--
-- Reproduced under authenticated RLS: the real owner promotes the placeholder,
-- then demotes themselves. Both writes succeed. The household now has
-- owner_rows = 1 and zero owners who can sign in. is_household_owner() is
-- false for everybody, so nobody can add a member, change a role or repair the
-- roster -- the same dead end 20260914073306 was written to prevent, reached
-- by a route that trigger cannot see because it counts labels.
--
-- Two writes close it, and both are needed: the first stops an unloggable
-- owner from ever existing, the second stops an ordinary account deletion from
-- creating one behind the app's back.

-- 1. The label and the login travel together.
--
-- A CHECK rather than a trigger: it is a property of the row, it cannot be
-- reasoned around by a caller with more privilege (service_role included --
-- nothing should be minting owners nobody can sign in as), and it is evaluated
-- after BEFORE triggers, so it judges the row as it will actually be stored.
--
-- This takes nothing away from a member without a login. `role` is purely
-- administrative here. Financial ownership is a different column entirely --
-- accounts.owner_member_id, transactions.owner_member_id, is_shared -- and a
-- placeholder member can still hold all of it. The two were only ever
-- conflated in the Settings copy, which this change corrects.
alter table household_members
  add constraint household_members_owner_has_login
  check (role <> 'owner' or user_id is not null);

comment on constraint household_members_owner_has_login on household_members is
  'An owner row must be linked to an auth user. role = owner is an authorization grant, and is_household_owner() resolves it through user_id -- so an owner with no user_id is a household with nobody able to administer it (QA #3).';

-- 2. Losing the login demotes the row rather than blocking the deletion.
--
-- household_members.user_id is `references auth.users(id) on delete set null`,
-- so deleting an auth user rewrites the roster row without anyone asking. With
-- the constraint above and nothing else, that ordinary deletion would fail on
-- a check violation -- correct in outcome for the LAST owner, needlessly
-- obstructive for one of several, and in both cases an error about a
-- constraint nobody deleting an account has heard of.
--
-- Demoting instead is what the row now actually is: a member with no login,
-- which is exactly what MemberEditor's placeholders are. Nothing is lost --
-- the row keeps its name, its history and everything it owns financially.
--
-- If that was the last owner, household_members_keep_an_owner() then fires on
-- the same statement and refuses, so the deletion fails with the message about
-- ownership that actually explains it. The recovery is the same as always:
-- promote someone else first.
--
-- Named to sort AFTER household_members_guard_role, because BEFORE triggers on
-- one event fire in alphabetical order and that guard raises on any role
-- change it did not authorise. Running second means it sees this row's role
-- unchanged and stays out of the way; running first, an account deletion would
-- be rejected as an unauthorised promotion attempt.
create or replace function household_members_unlinked_owner_demotes()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.role = 'owner' and new.user_id is null and old.user_id is not null then
    new.role := 'member';
  end if;
  return new;
end;
$$;

revoke execute on function household_members_unlinked_owner_demotes() from public, anon, authenticated;

create trigger household_members_unlinked_owner_demotes
  before update on household_members
  for each row execute function household_members_unlinked_owner_demotes();

comment on function household_members_unlinked_owner_demotes is
  'Turns an owner row whose auth user has just been deleted or unlinked into an ordinary member, so the roster never holds an owner nobody can sign in as. The last-owner constraint trigger then decides whether the household can afford to lose that owner (QA #3).';

comment on column household_members.role is
  'owner or member, and administrative only -- financial ownership is owner_member_id/is_shared on the rows themselves. Owners manage the roster; members may edit only their own row and may not change their own role (guard_household_member_role). An owner is always linked to an auth user (household_members_owner_has_login), and a household always retains at least one owner (household_members_keep_an_owner) -- together, always at least one owner who can actually sign in.';
