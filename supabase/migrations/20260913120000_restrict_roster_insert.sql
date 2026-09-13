-- Close the INSERT route around the owner boundary (QA pass 3, P1).
--
-- 20260913100000_owner_role_authorization.sql made "owner" a real boundary for
-- UPDATE and DELETE, and left the INSERT policy alone on the reasoning that an
-- insert "cannot reduce the owner count, so it is not a route to the invariant
-- this protects". That is true of the last-owner invariant and beside the point
-- for the tenancy boundary. The INSERT policy still read
--
--     user_id = auth.uid() or is_household_member(household_id)
--
-- and the first clause is the whole hole: it authorises a row by who the row
-- CLAIMS to be, never by who may write into that household. Two consequences,
-- both reproduced against production inside a rolled-back transaction as a real
-- `authenticated` role with real JWT claims:
--
--   1. A member deletes their own row ("members can leave", legitimately) and
--      inserts it again with role = 'owner'. The guard trigger never sees it:
--      it is a BEFORE UPDATE trigger, and this is not an update. Self-promotion
--      refused through the front door, granted through the back.
--
--   2. Any signed-in user who knows a household's UUID inserts THEMSELVES into
--      it, as owner, with no invitation and no prior membership. In the
--      reproduction that immediately exposed the other household's accounts.
--      This is a cross-tenant read, not merely a role mistake.
--
-- Tenant-qualified foreign keys cannot catch either one, because the row that
-- establishes the tenancy relationship IS the row being inserted.
--
-- The fix is to authorise the writer rather than the row's own claim.

-- 1. Bootstrap first, so that closing the policy does not close the only door.
--
-- The self-join clause was written as the bootstrap escape hatch: a household's
-- first member exists before anyone can be its owner, so an owner-gated insert
-- would make a new household uncreatable. That reasoning is sound, and the
-- answer is not to leave the hatch open for every row -- it is to make the one
-- legitimate bootstrap atomic and self-contained.
--
-- create_household() is the only writer that may mint a first owner. It cannot
-- be aimed at an existing household, because it generates the household id
-- itself and inserts both rows in one statement -- there is no parameter an
-- attacker could point at someone else's tenancy. That is the property the old
-- policy lacked.
create or replace function create_household(p_name text, p_display_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in before creating a household' using errcode = '42501';
  end if;

  if coalesce(btrim(p_name), '') = '' then
    raise exception 'a household needs a name' using errcode = '23514';
  end if;

  if coalesce(btrim(p_display_name), '') = '' then
    raise exception 'your own member row needs a display name' using errcode = '23514';
  end if;

  -- useHousehold() resolves the caller's household with .eq('user_id', ...)
  -- .limit(1): a second membership would not give the app a second household,
  -- it would give it an arbitrary one. Refuse rather than silently pick.
  if exists (select 1 from household_members where user_id = auth.uid()) then
    raise exception 'you already belong to a household'
      using errcode = '23505',
            hint = 'Leave the current household before creating another one.';
  end if;

  insert into households (name) values (btrim(p_name)) returning id into new_id;

  insert into household_members (household_id, user_id, display_name, role)
  values (new_id, auth.uid(), btrim(p_display_name), 'owner');

  return new_id;
end;
$$;

revoke execute on function create_household(text, text) from public, anon;
grant execute on function create_household(text, text) to authenticated;

comment on function create_household is
  'Creates a household and its first owner atomically. The only path that may mint an owner without an existing one; it generates the household id itself, so it cannot be aimed at an existing household.';

-- Raw household INSERT now has no purpose: with the roster closed below, a
-- directly-created household is one nobody can ever join. Removing the policy
-- keeps creation on the single audited path. create_household() is SECURITY
-- DEFINER and so is unaffected by this.
drop policy "authenticated users can create a household" on households;

-- 2. The roster INSERT is now authorised by the writer, not by the row.
--
-- This still covers the one insert the app actually performs: MemberEditor
-- adding a placeholder member (user_id null) to the household it is already
-- showing, which only an owner may now do. It also still covers a genuine
-- invitation -- an owner inserting a row with someone else's user_id -- which
-- is the direction an invite should travel.
drop policy "self-join or existing member can add" on household_members;

create policy "owners add household members" on household_members
  for insert to authenticated
  with check (is_household_owner(household_id));

-- 3. Internal helpers stop being callable over /rest/v1/rpc (QA §10).
--
-- Every function below returns `trigger`, so none of them is a legitimate RPC;
-- household_members_keep_an_owner() is additionally SECURITY DEFINER, which is
-- what the security advisor flags. Revoking EXECUTE does not affect the
-- triggers: PostgreSQL checks EXECUTE on a trigger function when the trigger is
-- CREATEd, not each time it fires. The roster tests re-prove every one of these
-- invariants after the revoke rather than taking that on trust.
revoke execute on function household_members_keep_an_owner() from public, anon, authenticated;
revoke execute on function guard_household_member_role() from public, anon, authenticated;
revoke execute on function guard_telegram_link_columns() from public, anon, authenticated;
revoke execute on function guard_goal_allocation() from public, anon, authenticated;
revoke execute on function holdings_sync_priced_at() from public, anon, authenticated;
revoke execute on function compute_account_derived_fields() from public, anon, authenticated;

-- is_household_member() stays callable by signed-in users -- the RLS policies
-- that use it are evaluated as the caller, so authenticated genuinely needs
-- EXECUTE -- but anon never did: with no auth.uid() it can only ever return
-- false. is_household_owner() was already granted this way; this brings its
-- older sibling into line.
revoke execute on function is_household_member(uuid) from public, anon;
grant execute on function is_household_member(uuid) to authenticated;
