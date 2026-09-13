-- Make "owner" a real authorization boundary, not a UI convention (QA re-run §8).
--
-- household_members.role has been 'owner' | 'member' since the baseline schema,
-- and the Settings screen treats the distinction as meaningful: it labels
-- owners, and it refuses to remove the last one. The database did neither. Both
-- roster policies gated on is_household_member(), so ANY member could update or
-- delete ANY roster row -- including promoting themselves to owner, demoting
-- the real owner, or removing them outright. The "always keep an owner" rule
-- lived only in React, which means it held exactly as long as every write went
-- through that screen.
--
-- Three things are needed for the role to mean something, and all three have to
-- land together or the gap just moves:
--
--   1. Owner-gated policies, so a member cannot manage other people's rows.
--   2. A guard on self-service, because the policies below deliberately still
--      let a member edit their OWN row (their display name) -- and without a
--      guard, "edit your own row" is a route to setting your own role to
--      'owner', or moving yourself into a household you were never in. RLS
--      cannot express this: WITH CHECK sees only the new row, never the old
--      one, so "did this change the role?" is a question only a trigger can
--      ask.
--   3. The last-owner invariant in the database, so a household cannot be left
--      with nobody able to administer it.
--
-- Deliberately unchanged: the INSERT policy. A household's first member is
-- created before anyone can be its owner, so requiring an owner to add rows
-- would make a new household unbootstrappable. Inserts cannot reduce the owner
-- count, so they are not a route to the invariant this protects.
--
-- Also unchanged: "members can update their household" (renaming). Making that
-- owner-only is a product decision about who names the household, not a
-- tenancy or authorization hole, so it is left as it is rather than swept in.

-- 1. The owner counterpart to is_household_member().
--
-- SECURITY DEFINER for the same reason is_household_member() is: it reads
-- household_members, which is itself behind RLS, so an invoker-rights version
-- would recurse through the very policies it is being used to evaluate.
--
-- Unlike is_household_member() -- which the security advisor flags as
-- anon-executable, a separate finding (§12) -- this one is granted to
-- authenticated only from the start. An anonymous caller has no auth.uid(), so
-- it could only ever return false for them anyway.
create or replace function is_household_owner(hh_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from household_members
    where household_id = hh_id
      and user_id = auth.uid()
      and role = 'owner'
  );
$$;

revoke execute on function is_household_owner(uuid) from public, anon;
grant execute on function is_household_owner(uuid) to authenticated;

comment on function is_household_owner is
  'True when the calling user is an OWNER of the given household. The owner-gated half of is_household_member(); both are SECURITY DEFINER because they read a table that is itself behind RLS.';

-- 2. Roster policies: owners manage everyone, members manage themselves.
--
-- The self clause is what keeps a plain member able to correct their own
-- display name, which the previous household-wide policy allowed and which
-- removing entirely would be a regression. It is safe only because of the
-- guard trigger below -- on its own, "you may update the row where user_id =
-- auth.uid()" also permits that row's role and household_id to change.
--
-- user_id is null for a placeholder member (someone tracked in the ledger who
-- has no login yet), so `user_id = auth.uid()` is null-safe by construction:
-- it never matches, and such a row is manageable by an owner only. That is the
-- intended behaviour, not an oversight.
drop policy "members can update household roster" on household_members;
drop policy "members can remove household roster" on household_members;

create policy "owners manage the roster, members manage themselves" on household_members
  for update
  using (is_household_owner(household_id) or user_id = auth.uid())
  with check (is_household_owner(household_id) or user_id = auth.uid());

create policy "owners remove members, members can leave" on household_members
  for delete
  using (is_household_owner(household_id) or user_id = auth.uid());

-- 3. What a self-service update may NOT do.
--
-- Follows the same shape as guard_telegram_link_columns() on this table,
-- including the service_role exemption: the Edge Functions write roster columns
-- with the service key and have no auth.uid() to be an owner with. The threat
-- this closes is a signed-in member escalating themselves, and that caller is
-- never service_role.
create or replace function guard_household_member_role()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Moving a member between households would let someone with a self-update
  -- grant walk into a household they were never in: the WITH CHECK above still
  -- passes afterwards, because user_id = auth.uid() is as true in the new
  -- household as it was in the old one.
  if new.household_id is distinct from old.household_id
     and auth.role() <> 'service_role' then
    raise exception 'a member cannot be moved between households' using errcode = '42501';
  end if;

  if new.role is distinct from old.role
     and auth.role() <> 'service_role'
     and not is_household_owner(old.household_id) then
    raise exception 'only an owner can change a member''s role' using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger household_members_guard_role
  before update on household_members
  for each row execute function guard_household_member_role();

-- 4. A household always keeps at least one owner.
--
-- A CONSTRAINT TRIGGER rather than a plain one, so it is evaluated at the end
-- of the statement rather than per row mid-flight: `update household_members
-- set role = 'member' where household_id = ...` demotes several rows in one
-- statement, and a per-row BEFORE trigger would judge each against a roster
-- that is still half-changed.
--
-- SECURITY DEFINER is load-bearing, not boilerplate. Both tables this reads are
-- behind RLS, and an invoker-rights version sees only what the CALLER may see.
-- That silently inverts the check in the exact case it exists for: when the
-- last owner deletes their own row they stop being a member, so
-- is_household_member() turns false, `households` and the rest of the roster
-- both vanish from their view, the cascade escape hatch below matches, and the
-- delete sails through leaving a household with no owner. Verified: without
-- SECURITY DEFINER this trigger passes every superuser test (RLS bypassed) and
-- still lets a signed-in last owner delete themselves.
create or replace function household_members_keep_an_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only a row that WAS an owner can have reduced the owner count. Without
  -- this the trigger asks "does this household have an owner?" rather than
  -- "did this operation remove the last one?", and then refuses ordinary edits
  -- to a household that never had an owner to begin with -- which an INSERT
  -- can legitimately produce, since a household's first member is created
  -- before anyone can be promoted.
  if old.role <> 'owner' then
    return null;
  end if;

  -- A household being deleted takes its whole roster with it by cascade. That
  -- is the household going away, not a household left ownerless, so there is
  -- nothing to protect and the check must not block the delete.
  if not exists (select 1 from households where id = old.household_id) then
    return null;
  end if;

  if not exists (
    select 1 from household_members
    where household_id = old.household_id and role = 'owner'
  ) then
    raise exception 'a household must always have at least one owner'
      using errcode = '23514',
            hint = 'Promote another member to owner before removing or demoting the last one.';
  end if;

  return null;
end;
$$;

create constraint trigger household_members_keep_an_owner
  after update or delete on household_members
  deferrable initially immediate
  for each row execute function household_members_keep_an_owner();

comment on column household_members.role is
  'owner or member. Owners manage the roster; members may edit only their own row and may not change their own role (guard_household_member_role). A household always retains at least one owner (household_members_keep_an_owner).';
