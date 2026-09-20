-- Row-level security, exercised as real API roles rather than as a superuser.
--
-- migration-behaviour.test.sql deliberately runs as a superuser, which bypasses
-- RLS: it proves constraints and functions, and explicitly cannot prove a
-- policy. This file is the other half. It does `set role authenticated` and
-- sets the JWT claims the way PostgREST does, so every statement below goes
-- through the same policy evaluation a signed-in user gets.
--
-- That distinction is not academic. The last-owner trigger passed every
-- superuser test while still letting a signed-in last owner delete themselves:
-- once they removed their own row they stopped being a member, RLS hid the
-- household from them, and the trigger's "the household is being cascaded away"
-- escape hatch matched. Only a test that runs as the user could see it.
--
-- Run against a database built by scripts/verify-migrations.sh.

\set ON_ERROR_STOP on

begin;

-- Two logins and one placeholder member with no login at all, which is what a
-- household looks like in practice: one person administers it, the other is
-- tracked in the ledger before they ever sign in.
insert into auth.users (id, email) values
  ('0a000000-0000-0000-0000-00000000000a', 'owner@example.test'),
  ('0b000000-0000-0000-0000-00000000000b', 'member@example.test'),
  -- The other household's owner needs a login of its own now: an owner row
  -- with no user_id is refused outright (household_members_owner_has_login,
  -- QA #3). Nothing below ever signs in as them -- they exist to be reached
  -- for, and failed to be reached.
  ('0d000000-0000-0000-0000-00000000000d', 'their-owner@example.test');

insert into households (id, name) values
  ('d1000000-0000-0000-0000-000000000001', 'Ours'),
  ('d2000000-0000-0000-0000-000000000002', 'Theirs');

insert into household_members (id, household_id, display_name, role, user_id) values
  ('e1000000-0000-0000-0000-00000000000a', 'd1000000-0000-0000-0000-000000000001', 'Owner', 'owner', '0a000000-0000-0000-0000-00000000000a'),
  ('e1000000-0000-0000-0000-00000000000b', 'd1000000-0000-0000-0000-000000000001', 'Member', 'member', '0b000000-0000-0000-0000-00000000000b'),
  ('e1000000-0000-0000-0000-00000000000c', 'd1000000-0000-0000-0000-000000000001', 'Placeholder', 'member', null),
  ('e2000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-000000000002', 'Their owner', 'owner', '0d000000-0000-0000-0000-00000000000d');

set role authenticated;
set request.jwt.claim.role = 'authenticated';

-- ---------------------------------------------------------------- non-owner
set request.jwt.claim.sub = '0b000000-0000-0000-0000-00000000000b';

-- QA §8: a member cannot promote themselves.
do $$
begin
  begin
    update household_members set role = 'owner' where id = 'e1000000-0000-0000-0000-00000000000b';
    raise exception 'QA-§8 FAILED: a member promoted themselves to owner';
  exception
    when insufficient_privilege then
      raise notice 'QA-§8 ok: self-promotion refused';
  end;
end $$;

-- QA §8: a member cannot move themselves into another household. The UPDATE
-- policy alone would allow this -- `user_id = auth.uid()` is just as true in
-- the destination -- so only the guard trigger stops it.
do $$
begin
  begin
    update household_members set household_id = 'd2000000-0000-0000-0000-000000000002'
    where id = 'e1000000-0000-0000-0000-00000000000b';
    raise exception 'QA-§8 FAILED: a member moved themselves into another household';
  exception
    when insufficient_privilege then
      raise notice 'QA-§8 ok: self-transfer into another household refused';
  end;
end $$;

-- QA §8: a member cannot touch anyone else's row. These are not errors --
-- RLS makes the rows invisible to the write, so the statements simply affect
-- nothing, which is why they have to be asserted by row count.
do $$
declare n int;
begin
  with x as (update household_members set role = 'member'
             where id = 'e1000000-0000-0000-0000-00000000000a' returning 1)
  select count(*) into n from x;
  if n <> 0 then raise exception 'QA-§8 FAILED: a member demoted the owner'; end if;

  with x as (delete from household_members
             where id = 'e1000000-0000-0000-0000-00000000000a' returning 1)
  select count(*) into n from x;
  if n <> 0 then raise exception 'QA-§8 FAILED: a member deleted the owner'; end if;

  with x as (update household_members set display_name = 'hijacked'
             where id = 'e1000000-0000-0000-0000-00000000000c' returning 1)
  select count(*) into n from x;
  if n <> 0 then raise exception 'QA-§8 FAILED: a member edited a placeholder member'; end if;

  raise notice 'QA-§8 ok: a member cannot demote, delete or edit anyone else';
end $$;

-- QA §8: but a member can still correct their own name. A policy that refused
-- this would pass every test above and be a regression.
do $$
declare n int;
begin
  update household_members set display_name = 'Renamed by self'
  where id = 'e1000000-0000-0000-0000-00000000000b';
  select count(*) into n from household_members
  where id = 'e1000000-0000-0000-0000-00000000000b' and display_name = 'Renamed by self';
  if n <> 1 then raise exception 'QA-§8 FAILED: a member could not rename themselves'; end if;
  raise notice 'QA-§8 ok: a member can still edit their own row';
end $$;

-- QA pass 3 P1: the same escalation, taken through INSERT instead of UPDATE.
-- Every one of these was ALLOWED before 20260913153028, and the first two were
-- reproduced against production as a real `authenticated` role.
do $$
declare n int;
begin
  -- Leave, then come back as an owner. guard_household_member_role() is a
  -- BEFORE UPDATE trigger and never sees this; only the INSERT policy can
  -- refuse it. The delete is real, so this runs in its own subtransaction --
  -- catching the exception below rolls the delete back along with it.
  begin
    delete from household_members where id = 'e1000000-0000-0000-0000-00000000000b';
    insert into household_members (id, household_id, display_name, role, user_id)
    values ('e1000000-0000-0000-0000-00000000000b', 'd1000000-0000-0000-0000-000000000001',
            'Escalated', 'owner', '0b000000-0000-0000-0000-00000000000b');
    raise exception 'QA-P1 FAILED: a member left and rejoined as an owner';
  exception
    when insufficient_privilege then null;
  end;

  select count(*) into n from household_members
  where id = 'e1000000-0000-0000-0000-00000000000b' and role = 'member';
  if n <> 1 then raise exception 'QA-P1 FAILED: the delete/re-insert attempt did not roll back cleanly'; end if;

  -- Walk into a household they were never in, as its owner. This one is a
  -- cross-tenant read, not merely a wrong role: the roster row is what makes
  -- every other table's policy return that household's rows.
  begin
    insert into household_members (household_id, display_name, role, user_id)
    values ('d2000000-0000-0000-0000-000000000002', 'Intruder', 'owner',
            '0b000000-0000-0000-0000-00000000000b');
    raise exception 'QA-P1 FAILED: a signed-in user self-joined another household';
  exception
    when insufficient_privilege then null;
  end;

  -- And a member may not add anyone at all, placeholder included.
  begin
    insert into household_members (household_id, display_name, role, user_id)
    values ('d1000000-0000-0000-0000-000000000001', 'Added by a member', 'member', null);
    raise exception 'QA-P1 FAILED: a member added a roster row';
  exception
    when insufficient_privilege then null;
  end;

  if exists (select 1 from household_members
             where household_id = 'd2000000-0000-0000-0000-000000000002'
               and user_id = '0b000000-0000-0000-0000-00000000000b') then
    raise exception 'QA-P1 FAILED: an intruder row survived';
  end if;
  raise notice 'QA-P1 ok: INSERT cannot mint an owner, join a household, or add a member';
end $$;

-- ------------------------------------------------------------------- owner
set request.jwt.claim.sub = '0a000000-0000-0000-0000-00000000000a';

-- QA pass 3 P1: the owner-gated policy must still allow the only roster insert
-- the app actually performs -- Settings adding a placeholder member -- and must
-- not let an owner of one household reach into another.
do $$
declare n int;
begin
  insert into household_members (id, household_id, display_name, role, user_id)
  values ('e1000000-0000-0000-0000-00000000000d', 'd1000000-0000-0000-0000-000000000001',
          'Added by owner', 'member', null);
  select count(*) into n from household_members where id = 'e1000000-0000-0000-0000-00000000000d';
  if n <> 1 then raise exception 'QA-P1 FAILED: an owner could not add a placeholder member'; end if;

  begin
    insert into household_members (household_id, display_name, role, user_id)
    values ('d2000000-0000-0000-0000-000000000002', 'Reaching across', 'owner', null);
    raise exception 'QA-P1 FAILED: an owner added a member to a household they do not own';
  exception
    when insufficient_privilege then null;
  end;
  raise notice 'QA-P1 ok: an owner adds members to their own household only';
end $$;

do $$
declare n int;
begin
  update household_members set display_name = 'Renamed by owner'
  where id = 'e1000000-0000-0000-0000-00000000000c';
  select count(*) into n from household_members
  where id = 'e1000000-0000-0000-0000-00000000000c' and display_name = 'Renamed by owner';
  if n <> 1 then raise exception 'QA-§8 FAILED: an owner could not edit a placeholder member'; end if;

  update household_members set role = 'owner' where id = 'e1000000-0000-0000-0000-00000000000b';
  select count(*) into n from household_members
  where household_id = 'd1000000-0000-0000-0000-000000000001' and role = 'owner';
  if n <> 2 then raise exception 'QA-§8 FAILED: an owner could not promote a member'; end if;

  -- Stepping down is allowed while somebody else still has the keys.
  update household_members set role = 'member' where id = 'e1000000-0000-0000-0000-00000000000a';
  raise notice 'QA-§8 ok: an owner manages the roster and may step down while another owner remains';
end $$;

-- --------------------------------------------------- the last-owner invariant
set request.jwt.claim.sub = '0b000000-0000-0000-0000-00000000000b';

do $$
declare n int;
begin
  begin
    update household_members set role = 'member' where id = 'e1000000-0000-0000-0000-00000000000b';
    raise exception 'QA-§8 FAILED: the last owner demoted themselves';
  exception
    when check_violation then null;
  end;

  begin
    delete from household_members where id = 'e1000000-0000-0000-0000-00000000000b';
    raise exception 'QA-§8 FAILED: the last owner deleted themselves';
  exception
    when check_violation then null;
  end;

  -- One statement demoting every row at once: a per-row BEFORE trigger would
  -- judge each against a half-changed roster and let this through.
  begin
    update household_members set role = 'member'
    where household_id = 'd1000000-0000-0000-0000-000000000001';
    raise exception 'QA-§8 FAILED: every owner was demoted in a single statement';
  exception
    when check_violation then null;
  end;

  select count(*) into n from household_members
  where household_id = 'd1000000-0000-0000-0000-000000000001' and role = 'owner';
  if n <> 1 then raise exception 'QA-§8 FAILED: the household ended with % owners, expected 1', n; end if;
  raise notice 'QA-§8 ok: the last owner cannot be demoted, deleted, or demoted en masse';
end $$;

-- ------------------------------------------- an owner who can actually sign in
--
-- QA #3, reproduced exactly as reported: the real owner promotes the
-- placeholder member (user_id null), then demotes themselves. Both writes used
-- to succeed, leaving owner_rows = 1 and zero owners able to sign in --
-- is_household_owner() false for everybody, and a roster nobody can ever
-- repair. The last-owner trigger could not see it, because it counts the label
-- and the label was still there.
--
-- Signed in as the household's only owner. e1...000b was demoted in the block
-- above, so 000b is the owner now.
do $$
declare n int;
begin
  begin
    update household_members set role = 'owner'
    where id = 'e1000000-0000-0000-0000-00000000000c';
    raise exception 'QA-#3 FAILED: a placeholder with no login was made an owner';
  exception
    when check_violation then null;
  end;

  -- The step the promotion was for. It must still be refused, and for the
  -- original reason: there is still only one owner.
  begin
    update household_members set role = 'member'
    where id = 'e1000000-0000-0000-0000-00000000000b';
    raise exception 'QA-#3 FAILED: the last owner stepped down after a failed promotion';
  exception
    when check_violation then null;
  end;

  select count(*) into n from household_members
  where household_id = 'd1000000-0000-0000-0000-000000000001'
    and role = 'owner' and user_id is not null;
  if n <> 1 then
    raise exception 'QA-#3 FAILED: the household has % owners who can sign in, expected 1', n;
  end if;

  -- And the thing this must not have broken: promoting someone who DOES have a
  -- login still works, and only then can the current owner step down.
  update household_members set role = 'owner'
  where id = 'e1000000-0000-0000-0000-00000000000a';
  update household_members set role = 'member'
  where id = 'e1000000-0000-0000-0000-00000000000b';

  select count(*) into n from household_members
  where household_id = 'd1000000-0000-0000-0000-000000000001'
    and role = 'owner' and user_id is not null;
  if n <> 1 then
    raise exception 'QA-#3 FAILED: handing over ownership left % signed-in owners, expected 1', n;
  end if;
  raise notice 'QA-#3 ok: a placeholder cannot be made owner, and handover between logins still works';
end $$;

-- QA §7 seen from the API side: the tenant-qualified keys hold for a signed-in
-- user too, not only for the superuser the constraint tests use.
do $$
declare their_account uuid;
begin
  reset role;
  insert into accounts (id, household_id, name, type)
  values ('f2000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-000000000002', 'Their account', 'checking')
  returning id into their_account;
  set local role authenticated;

  begin
    insert into transactions (household_id, account_id, amount, occurred_at)
    values ('d1000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-00000000000a', -10, '2026-09-01');
    raise exception 'QA-§7 FAILED: a signed-in user referenced another household''s account';
  exception
    when foreign_key_violation then
      raise notice 'QA-§7 ok: tenant-qualified keys hold for a signed-in user as well';
  end;
end $$;

-- QA pass 3 P1: bootstrap. Closing the self-join clause removes the only route
-- by which a household could ever be created, so create_household() replaces it
-- -- and it has to be the only route, for somebody in no household at all.
reset role;
insert into auth.users (id, email) values
  ('0c000000-0000-0000-0000-00000000000c', 'newcomer@example.test');

set role authenticated;
set request.jwt.claim.sub = '0c000000-0000-0000-0000-00000000000c';

do $$
declare new_household uuid; n int;
begin
  -- A stranger still cannot let themselves into an existing household. This is
  -- the property the old bootstrap clause traded away to get bootstrap.
  begin
    insert into household_members (household_id, display_name, role, user_id)
    values ('d1000000-0000-0000-0000-000000000001', 'Stranger', 'owner',
            '0c000000-0000-0000-0000-00000000000c');
    raise exception 'QA-P1 FAILED: a stranger self-joined an existing household';
  exception
    when insufficient_privilege then null;
  end;

  -- Nor build a tenancy by hand out of a raw household row.
  begin
    insert into households (id, name)
    values ('d3000000-0000-0000-0000-000000000003', 'Handmade');
    raise exception 'QA-P1 FAILED: a household was created outside create_household()';
  exception
    when insufficient_privilege then null;
  end;

  -- The supported path works, and makes them an owner of their OWN household.
  new_household := create_household('Newcomer household', 'Newcomer');
  if not is_household_owner(new_household) then
    raise exception 'QA-P1 FAILED: create_household() did not make the caller an owner';
  end if;
  if is_household_member('d1000000-0000-0000-0000-000000000001') then
    raise exception 'QA-P1 FAILED: create_household() leaked membership of an existing household';
  end if;
  select count(*) into n from household_members where household_id = new_household;
  if n <> 1 then raise exception 'QA-P1 FAILED: a new household started with % members, expected 1', n; end if;

  -- ...once. useHousehold() resolves one membership per user; a second would
  -- make which household you see arbitrary.
  begin
    perform create_household('Second household', 'Newcomer again');
    raise exception 'QA-P1 FAILED: a user created a second household';
  exception
    when unique_violation then null;
  end;

  raise notice 'QA-P1 ok: create_household() is the only bootstrap, and a one-off';
end $$;

-- QA §10: the internal helpers are no longer reachable as RPCs. The point of
-- doing this here, after every invariant above has already been proven against
-- the same database, is that the invariants are proven WITH the grants revoked
-- -- a trigger keeps firing without EXECUTE, and these tests are the evidence.
do $$
begin
  begin
    perform household_members_keep_an_owner();
    raise exception 'QA-§10 FAILED: a SECURITY DEFINER trigger helper was callable directly';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform guard_household_member_role();
    raise exception 'QA-§10 FAILED: the role guard was callable directly';
  exception
    when insufficient_privilege then null;
  end;

  -- The membership helper must stay callable: the RLS policies that use it are
  -- evaluated as the caller, so revoking this from authenticated would take
  -- every policy down with it.
  perform is_household_member('d1000000-0000-0000-0000-000000000001');
  raise notice 'QA-§10 ok: trigger helpers are not RPCs; the membership helper still is';
end $$;

reset role;
set role anon;
do $$
begin
  begin
    perform is_household_member('d1000000-0000-0000-0000-000000000001');
    raise exception 'QA-§10 FAILED: anon could still execute is_household_member()';
  exception
    when insufficient_privilege then null;
  end;
  raise notice 'QA-§10 ok: anon cannot execute the membership helper';
end $$;
reset role;

-- A household can still be deleted outright: the cascade takes the roster with
-- it, and that is not "a household left without an owner".
reset role;
do $$
declare n int;
begin
  delete from households where id = 'd1000000-0000-0000-0000-000000000001';
  select count(*) into n from household_members where household_id = 'd1000000-0000-0000-0000-000000000001';
  if n <> 0 then raise exception 'QA-§8 FAILED: deleting a household left % roster rows', n; end if;
  raise notice 'QA-§8 ok: deleting a household still cascades its roster away';
end $$;

rollback;
