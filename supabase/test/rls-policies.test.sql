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
  ('0b000000-0000-0000-0000-00000000000b', 'member@example.test');

insert into households (id, name) values
  ('d1000000-0000-0000-0000-000000000001', 'Ours'),
  ('d2000000-0000-0000-0000-000000000002', 'Theirs');

insert into household_members (id, household_id, display_name, role, user_id) values
  ('e1000000-0000-0000-0000-00000000000a', 'd1000000-0000-0000-0000-000000000001', 'Owner', 'owner', '0a000000-0000-0000-0000-00000000000a'),
  ('e1000000-0000-0000-0000-00000000000b', 'd1000000-0000-0000-0000-000000000001', 'Member', 'member', '0b000000-0000-0000-0000-00000000000b'),
  ('e1000000-0000-0000-0000-00000000000c', 'd1000000-0000-0000-0000-000000000001', 'Placeholder', 'member', null),
  ('e2000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-000000000002', 'Their owner', 'owner', null);

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

-- ------------------------------------------------------------------- owner
set request.jwt.claim.sub = '0a000000-0000-0000-0000-00000000000a';

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
