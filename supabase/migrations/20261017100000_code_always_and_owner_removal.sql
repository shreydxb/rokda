-- Every read and write of the household needs the second step, and only an
-- owner removes a member (docs/decisions.md, "Signing in takes a password and
-- a code" and "A second member signs in as a member"; QA re-review,
-- 17 October).
--
-- 1. A password alone reads nothing, whether or not an authenticator has
--    been added. private.mfa_satisfied() let a member with no verified
--    authenticator through at aal1, so that nobody was locked out before
--    adding one. Nobody needs that: the app has every member add one before
--    it shows anything, and adding one goes through Supabase Auth, which
--    reads no household table. With it, a password guessed or reused for a
--    member who had not added one yet (a second member's new login, or one
--    whose factor was reset) read and wrote the whole ledger through the API.
--
-- 2. A member's own roster row: the update policy's "your own row" branch
--    and the delete policy's "members can leave" branch never called
--    private.mfa_satisfied(), so a password-only session could still edit
--    its own row, and a member could remove themselves. Removing a member
--    takes their name off everything recorded as theirs (owner_member_id is
--    set to null), so it is an owner's act, as Settings and
--    docs/second-member.md already say. A member edits their own row (their
--    name) only after the second step.

create or replace function private.mfa_satisfied()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
$$;

comment on function private.mfa_satisfied() is
  'True when the session has passed its second step (aal2). Part of every membership check, so a password alone reads and writes nothing of the household.';

drop policy "owners manage the roster, members manage themselves" on household_members;
create policy "owners manage the roster, members manage themselves" on household_members
  for update
  using (private.is_household_owner(household_id) or (user_id = (select auth.uid()) and private.mfa_satisfied()))
  with check (private.is_household_owner(household_id) or (user_id = (select auth.uid()) and private.mfa_satisfied()));

drop policy "owners remove members, members can leave" on household_members;
create policy "owners remove members" on household_members
  for delete
  using (private.is_household_owner(household_id));
