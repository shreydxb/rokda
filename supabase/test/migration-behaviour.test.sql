-- Behaviour the new migrations are supposed to guarantee, executed against a
-- database built from the repository by scripts/verify-migrations.sh.
--
-- Run as a superuser, so row-level security is bypassed: this proves the
-- constraints and the approval function, not the policies. Real RLS and
-- two-user behaviour still need a hosted environment (docs/environments.md).

\set ON_ERROR_STOP on

begin;

insert into households (id, name) values ('11111111-1111-1111-1111-111111111111', 'Test');
insert into household_members (id, household_id, display_name)
values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Tester');
insert into accounts (id, household_id, name, type, balance, is_shared)
values ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'Test card', 'credit_card', 0, true);
insert into transactions (id, household_id, account_id, amount, occurred_at, is_shared)
values
  ('44444444-4444-4444-4444-444444444441', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', -100, '2026-06-01', true),
  ('44444444-4444-4444-4444-444444444442', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', -50, '2026-07-01', true),
  ('44444444-4444-4444-4444-444444444443', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', -25, '2026-08-01', true);

-- QA-01: the database itself refuses to delete an account that has history.
do $$
begin
  begin
    delete from accounts where id = '33333333-3333-3333-3333-333333333333';
    raise exception 'QA-01 FAILED: deleting an account with transactions was allowed';
  exception
    when foreign_key_violation then
      raise notice 'QA-01 ok: delete refused by transactions_account_id_fkey';
  end;
end $$;

-- QA-01: closing keeps every transaction.
update accounts set archived_at = now() where id = '33333333-3333-3333-3333-333333333333';
do $$
declare n int;
begin
  select count(*) into n from transactions where account_id = '33333333-3333-3333-3333-333333333333';
  if n <> 3 then raise exception 'QA-01 FAILED: % transactions survived closure, expected 3', n; end if;
  raise notice 'QA-01 ok: all 3 transactions survive closure';
end $$;
update accounts set archived_at = null where id = '33333333-3333-3333-3333-333333333333';

-- QA-11: approving the same intake row twice yields exactly one transaction.
insert into intake (id, household_id, source, raw_text, parsed_amount, status)
values ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', 'manual', 'Carrefour 120', 120, 'pending');

do $$
declare
  first jsonb;
  second jsonb;
  n int;
begin
  first := approve_intake(
    '55555555-5555-5555-5555-555555555555', '33333333-3333-3333-3333-333333333333',
    120, date '2026-09-05', 'expense');
  second := approve_intake(
    '55555555-5555-5555-5555-555555555555', '33333333-3333-3333-3333-333333333333',
    120, date '2026-09-05', 'expense');

  if (first ->> 'already_approved')::boolean then
    raise exception 'QA-11 FAILED: the first approval reported itself as a repeat';
  end if;
  if not (second ->> 'already_approved')::boolean then
    raise exception 'QA-11 FAILED: the retry was not recognised as already approved';
  end if;
  if (first ->> 'transaction_id') is distinct from (second ->> 'transaction_id') then
    raise exception 'QA-11 FAILED: the retry returned a different transaction';
  end if;

  select count(*) into n from transactions where id = (first ->> 'transaction_id')::uuid;
  if n <> 1 then raise exception 'QA-11 FAILED: % transactions written, expected 1', n; end if;

  select count(*) into n from transactions where merchant is null and amount = -120;
  if n <> 1 then raise exception 'QA-11 FAILED: % transactions of -120 exist, expected 1', n; end if;

  raise notice 'QA-11 ok: retry yields exactly one transaction';
end $$;

-- QA-11: an expense is signed negative, income positive, from the kind alone.
insert into intake (id, household_id, source, parsed_amount, status)
values ('55555555-5555-5555-5555-555555555556', '11111111-1111-1111-1111-111111111111', 'manual', 500, 'pending');
do $$
declare result jsonb; amount numeric;
begin
  result := approve_intake(
    '55555555-5555-5555-5555-555555555556', '33333333-3333-3333-3333-333333333333',
    500, date '2026-09-05', 'income');
  select t.amount into amount from transactions t where t.id = (result ->> 'transaction_id')::uuid;
  if amount <> 500 then raise exception 'QA-11 FAILED: income recorded as %', amount; end if;
  raise notice 'QA-11 ok: kind decides the sign';
end $$;

-- QA-11: a rejected row cannot be approved.
insert into intake (id, household_id, source, parsed_amount, status)
values ('55555555-5555-5555-5555-555555555557', '11111111-1111-1111-1111-111111111111', 'manual', 10, 'rejected');
do $$
begin
  begin
    perform approve_intake('55555555-5555-5555-5555-555555555557', '33333333-3333-3333-3333-333333333333', 10, date '2026-09-05', 'expense');
    raise exception 'QA-11 FAILED: a rejected row was approved';
  exception
    when raise_exception then
      if position('already rejected' in sqlerrm) = 0 then raise; end if;
      raise notice 'QA-11 ok: a rejected row is refused';
  end;
end $$;

-- QA-11: a source message delivered twice cannot enqueue twice.
insert into intake (household_id, source, source_ref, parsed_amount, status)
values ('11111111-1111-1111-1111-111111111111', 'telegram', 'update-42', 10, 'pending');
do $$
begin
  begin
    insert into intake (household_id, source, source_ref, parsed_amount, status)
    values ('11111111-1111-1111-1111-111111111111', 'telegram', 'update-42', 10, 'pending');
    raise exception 'QA-11 FAILED: the same source message was enqueued twice';
  exception
    when unique_violation then
      raise notice 'QA-11 ok: duplicate source_ref refused';
  end;
end $$;

-- QA-05: closing a month twice is idempotent.
do $$
declare n int;
begin
  insert into net_worth_snapshots (household_id, snapshot_date, assets, liabilities)
  values ('11111111-1111-1111-1111-111111111111', date '2026-08-01', 1000, 400)
  on conflict (household_id, snapshot_date) do update set assets = excluded.assets, liabilities = excluded.liabilities;

  insert into net_worth_snapshots (household_id, snapshot_date, assets, liabilities)
  values ('11111111-1111-1111-1111-111111111111', date '2026-08-01', 1000, 400)
  on conflict (household_id, snapshot_date) do update set assets = excluded.assets, liabilities = excluded.liabilities;

  select count(*) into n from net_worth_snapshots
   where household_id = '11111111-1111-1111-1111-111111111111' and snapshot_date = date '2026-08-01';
  if n <> 1 then raise exception 'QA-05 FAILED: % snapshots for one month, expected 1', n; end if;
  raise notice 'QA-05 ok: closing a month twice leaves one point';
end $$;

-- QA-05 / QA-04: two confirmed valuations give two dated points; the same day
-- twice gives one.
insert into holdings (id, household_id, name, asset_class, value_aed, is_shared)
values ('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', 'VWRA', 'intl_equity', 10000, true);
do $$
declare n int;
begin
  insert into holding_value_history (holding_id, as_of, value_aed)
  values ('66666666-6666-6666-6666-666666666666', date '2026-07-31', 10000)
  on conflict (holding_id, as_of) do update set value_aed = excluded.value_aed;
  insert into holding_value_history (holding_id, as_of, value_aed)
  values ('66666666-6666-6666-6666-666666666666', date '2026-08-31', 11000)
  on conflict (holding_id, as_of) do update set value_aed = excluded.value_aed;
  insert into holding_value_history (holding_id, as_of, value_aed)
  values ('66666666-6666-6666-6666-666666666666', date '2026-08-31', 11500)
  on conflict (holding_id, as_of) do update set value_aed = excluded.value_aed;

  select count(*) into n from holding_value_history where holding_id = '66666666-6666-6666-6666-666666666666';
  if n <> 2 then raise exception 'QA-05 FAILED: % history points, expected 2', n; end if;
  raise notice 'QA-05 ok: two valuations, two dated points; same day twice stays one';
end $$;

-- SHR-252: a refund is signed positive, like income, but its kind is now
-- persisted so the application can tell them apart.
insert into intake (id, household_id, source, parsed_amount, status)
values ('55555555-5555-5555-5555-555555555558', '11111111-1111-1111-1111-111111111111', 'manual', 75, 'pending');
do $$
declare result jsonb; amount numeric; txn_kind text;
begin
  result := approve_intake(
    '55555555-5555-5555-5555-555555555558', '33333333-3333-3333-3333-333333333333',
    75, date '2026-09-05', 'refund');
  select t.amount, t.kind into amount, txn_kind from transactions t where t.id = (result ->> 'transaction_id')::uuid;
  if amount <> 75 then raise exception 'SHR-252 FAILED: refund recorded as %, expected 75', amount; end if;
  if txn_kind <> 'refund' then raise exception 'SHR-252 FAILED: kind recorded as %, expected refund', txn_kind; end if;
  raise notice 'SHR-252 ok: a refund is signed positive and its kind is persisted';
end $$;

-- SHR-252: approval refuses a non-AED currency rather than storing an
-- unconverted amount that every dashboard total would misread as AED.
insert into intake (id, household_id, source, parsed_amount, status)
values ('55555555-5555-5555-5555-555555555559', '11111111-1111-1111-1111-111111111111', 'manual', 40, 'pending');
do $$
begin
  begin
    perform approve_intake(
      '55555555-5555-5555-5555-555555555559', '33333333-3333-3333-3333-333333333333',
      40, date '2026-09-05', 'expense', null, 'USD');
    raise exception 'SHR-252 FAILED: a USD approval was accepted';
  exception
    when raise_exception then
      if position('AED' in sqlerrm) = 0 then raise; end if;
      raise notice 'SHR-252 ok: a non-AED currency is refused';
  end;
end $$;

-- SHR-254 (762a6c4 recheck): the sync is one-directional. A new-client write
-- to priced_at propagates to last_refreshed (a legacy reader's benefit), but
-- a legacy client's write to last_refreshed must NOT move priced_at — that
-- would resurrect SHR-245 (a rename/refresh falsely certifying a stale
-- valuation) via the migration's own compatibility shim.
insert into holdings (id, household_id, name, asset_class, value_aed, is_shared, priced_at)
values ('77777777-7777-7777-7777-777777777777', '11111111-1111-1111-1111-111111111111', 'Old-client holding', 'intl_equity', 5000, true, '2026-06-01T00:00:00Z');
do $$
declare priced timestamptz; refreshed timestamptz;
begin
  -- The legacy client "refreshes" (or renames, or reloads) and writes only
  -- last_refreshed, the same way it always has. priced_at must stay exactly
  -- as it was — a legacy touch is not a confirmed valuation.
  update holdings set last_refreshed = '2026-09-06T00:00:00Z' where id = '77777777-7777-7777-7777-777777777777';
  select priced_at, last_refreshed into priced, refreshed from holdings where id = '77777777-7777-7777-7777-777777777777';
  if priced is distinct from '2026-06-01T00:00:00Z'::timestamptz then
    raise exception 'SHR-254 FAILED: a legacy last_refreshed write moved priced_at to %', priced;
  end if;
  if refreshed is distinct from '2026-09-06T00:00:00Z'::timestamptz then
    raise exception 'SHR-254 FAILED: the legacy client''s own write to last_refreshed did not stick (got %)', refreshed;
  end if;

  -- The new client confirms a real valuation and writes only priced_at.
  -- That DOES propagate — a genuine confirmed valuation is safe to also
  -- offer to a legacy reader via last_refreshed.
  update holdings set priced_at = '2026-09-06T12:00:00Z' where id = '77777777-7777-7777-7777-777777777777';
  select priced_at, last_refreshed into priced, refreshed from holdings where id = '77777777-7777-7777-7777-777777777777';
  if refreshed is distinct from priced then
    raise exception 'SHR-254 FAILED: last_refreshed (%) did not follow a genuine priced_at write (%)', refreshed, priced;
  end if;

  raise notice 'SHR-254 ok: a legacy refresh cannot move priced_at; a genuine reprice still updates last_refreshed for legacy readers';
end $$;

-- QA-04 / QA-02: the new columns exist and default to "not confirmed".
do $$
declare priced timestamptz; confirmed timestamptz;
begin
  select h.priced_at into priced from holdings h where h.id = '66666666-6666-6666-6666-666666666666';
  if priced is not null then raise exception 'QA-04 FAILED: a new holding claims a valuation date'; end if;
  select a.balance_as_of into confirmed from accounts a where a.id = '33333333-3333-3333-3333-333333333333';
  if confirmed is not null then raise exception 'QA-02 FAILED: a new account claims a confirmed balance'; end if;
  raise notice 'QA-04/QA-02 ok: valuations and balances start unconfirmed';
end $$;

-- QA §7: a second household, so the cross-household checks can actually fail.
--
-- Every tenant-integrity check QA ran against production came back clean while
-- production held exactly one household -- which made those checks incapable
-- of failing. These build the second household the real database does not have
-- yet, and then try to commit the corruption on purpose.
insert into households (id, name) values ('99999999-9999-9999-9999-999999999999', 'Other household');
insert into household_members (id, household_id, display_name)
values ('99999999-9999-9999-9999-99999999000a', '99999999-9999-9999-9999-999999999999', 'Other member');
insert into accounts (id, household_id, name, type, balance, is_shared)
values ('99999999-9999-9999-9999-99999999000b', '99999999-9999-9999-9999-999999999999', 'Other card', 'credit_card', 0, true);
insert into categories (id, household_id, name, kind)
values ('99999999-9999-9999-9999-99999999000c', '99999999-9999-9999-9999-999999999999', 'Other food', 'expense');
insert into categories (id, household_id, name, kind)
values ('88888888-8888-8888-8888-88888888000c', '11111111-1111-1111-1111-111111111111', 'Our food', 'expense');

-- QA §7: the database refuses a reference that reaches into another household.
do $$
declare
  attempts text[] := array[
    'insert into transactions (household_id, account_id, amount, occurred_at) values (''11111111-1111-1111-1111-111111111111'', ''99999999-9999-9999-9999-99999999000b'', -10, ''2026-09-01'')',
    'insert into transactions (household_id, account_id, category_id, amount, occurred_at) values (''11111111-1111-1111-1111-111111111111'', ''33333333-3333-3333-3333-333333333333'', ''99999999-9999-9999-9999-99999999000c'', -10, ''2026-09-01'')',
    'insert into transactions (household_id, account_id, owner_member_id, amount, occurred_at) values (''11111111-1111-1111-1111-111111111111'', ''33333333-3333-3333-3333-333333333333'', ''99999999-9999-9999-9999-99999999000a'', -10, ''2026-09-01'')',
    'insert into recurring (household_id, name, amount, cadence, next_due_date, account_id) values (''11111111-1111-1111-1111-111111111111'', ''Rent'', 100, ''monthly'', ''2026-10-01'', ''99999999-9999-9999-9999-99999999000b'')',
    'insert into categories (household_id, name, kind, parent_id) values (''11111111-1111-1111-1111-111111111111'', ''Dining'', ''expense'', ''99999999-9999-9999-9999-99999999000c'')',
    'insert into budgets (household_id, category_id, year, month, amount) values (''11111111-1111-1111-1111-111111111111'', ''99999999-9999-9999-9999-99999999000c'', 2026, 10, 500)',
    'insert into accounts (household_id, name, type, owner_member_id) values (''11111111-1111-1111-1111-111111111111'', ''Joint'', ''savings'', ''99999999-9999-9999-9999-99999999000a'')',
    'insert into intake (household_id, parsed_account_id) values (''11111111-1111-1111-1111-111111111111'', ''99999999-9999-9999-9999-99999999000b'')',
    'insert into intake (household_id, parsed_category_id) values (''11111111-1111-1111-1111-111111111111'', ''99999999-9999-9999-9999-99999999000c'')',
    'insert into category_rules (household_id, category_id, pattern) values (''11111111-1111-1111-1111-111111111111'', ''99999999-9999-9999-9999-99999999000c'', ''x'')'
  ];
  stmt text;
  allowed int := 0;
begin
  foreach stmt in array attempts loop
    begin
      execute stmt;
      allowed := allowed + 1;
      raise warning 'QA-§7 FAILED: cross-household write was allowed: %', stmt;
    exception
      when foreign_key_violation then null;  -- the tenant-qualified key did its job
    end;
  end loop;
  if allowed > 0 then
    raise exception 'QA-§7 FAILED: % cross-household write(s) accepted', allowed;
  end if;
  raise notice 'QA-§7 ok: all % cross-household writes refused', array_length(attempts, 1);
end $$;

-- QA §7: the same references WITHIN one household still work. A constraint
-- that refuses everything would pass the test above and break the product.
do $$
declare txn uuid;
begin
  insert into transactions (household_id, account_id, category_id, owner_member_id, amount, occurred_at)
  values ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
          '88888888-8888-8888-8888-88888888000c', '22222222-2222-2222-2222-222222222222', -42, '2026-09-02')
  returning id into txn;
  if txn is null then raise exception 'QA-§7 FAILED: a legitimate same-household insert was refused'; end if;

  -- MATCH SIMPLE: an unset optional reference is still unset, not a violation.
  insert into transactions (household_id, account_id, amount, occurred_at)
  values ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', -7, '2026-09-02');
  raise notice 'QA-§7 ok: same-household and null-optional references still accepted';
end $$;

-- QA §7: ON DELETE SET NULL must null ONLY the reference, not household_id.
--
-- A bare SET NULL on a composite key nulls every column in it, household_id
-- included, and household_id is NOT NULL -- so this would fail outright rather
-- than clear the owner. The column list in the constraint is what prevents it.
do $$
declare n int;
begin
  insert into household_members (id, household_id, display_name)
  values ('88888888-8888-8888-8888-88888888000a', '11111111-1111-1111-1111-111111111111', 'Leaver');
  insert into transactions (id, household_id, account_id, owner_member_id, amount, occurred_at)
  values ('88888888-8888-8888-8888-88888888000d', '11111111-1111-1111-1111-111111111111',
          '33333333-3333-3333-3333-333333333333', '88888888-8888-8888-8888-88888888000a', -5, '2026-09-03');

  delete from household_members where id = '88888888-8888-8888-8888-88888888000a';

  select count(*) into n from transactions
  where id = '88888888-8888-8888-8888-88888888000d'
    and owner_member_id is null
    and household_id = '11111111-1111-1111-1111-111111111111';
  if n <> 1 then raise exception 'QA-§7 FAILED: removing a member did not cleanly null the owner'; end if;
  raise notice 'QA-§7 ok: removing a member nulls the owner and keeps household_id';
end $$;

-- QA #3: an owner whose login goes away must not stay an owner.
--
-- household_members.user_id is `on delete set null`, so deleting an auth user
-- rewrites the roster row with nobody asking. The row used to keep
-- role = 'owner' while losing the only thing is_household_owner() resolves it
-- through -- a label pointing at no one, which the last-owner trigger happily
-- counts as an owner.
--
-- Deleting one of two owners' accounts demotes that row, because the household
-- can afford to lose it. Deleting the last owner's account is refused outright,
-- because it cannot.
do $$
declare role_now text; owners_with_login int;
begin
  insert into households (id, name) values ('aaaaaaaa-0000-0000-0000-00000000000b', 'Unlink test');
  insert into auth.users (id, email) values
    ('aaaaaaaa-1111-0000-0000-00000000000c', 'first@example.test'),
    ('aaaaaaaa-1111-0000-0000-00000000000d', 'second@example.test');
  insert into household_members (id, household_id, display_name, role, user_id) values
    ('aaaaaaaa-2222-0000-0000-00000000000c', 'aaaaaaaa-0000-0000-0000-00000000000b', 'First', 'owner', 'aaaaaaaa-1111-0000-0000-00000000000c'),
    ('aaaaaaaa-2222-0000-0000-00000000000d', 'aaaaaaaa-0000-0000-0000-00000000000b', 'Second', 'owner', 'aaaaaaaa-1111-0000-0000-00000000000d');

  delete from auth.users where id = 'aaaaaaaa-1111-0000-0000-00000000000d';

  select role into role_now from household_members where id = 'aaaaaaaa-2222-0000-0000-00000000000d';
  if role_now <> 'member' then
    raise exception 'QA-#3 FAILED: an owner whose login was deleted is still role %', role_now;
  end if;

  select count(*) into owners_with_login from household_members
  where household_id = 'aaaaaaaa-0000-0000-0000-00000000000b' and role = 'owner' and user_id is not null;
  if owners_with_login <> 1 then
    raise exception 'QA-#3 FAILED: % owners can sign in, expected 1', owners_with_login;
  end if;

  -- Now the same deletion for the LAST owner. There is nobody to fall back to,
  -- so the account deletion itself must fail -- with the ownership message,
  -- not a constraint nobody deleting an account has heard of.
  begin
    delete from auth.users where id = 'aaaaaaaa-1111-0000-0000-00000000000c';
    raise exception 'QA-#3 FAILED: deleting the last owner''s login left the household ownerless';
  exception
    when check_violation then null;
  end;

  select count(*) into owners_with_login from household_members
  where household_id = 'aaaaaaaa-0000-0000-0000-00000000000b' and role = 'owner' and user_id is not null;
  if owners_with_login <> 1 then
    raise exception 'QA-#3 FAILED: the household ended with % signed-in owners, expected 1', owners_with_login;
  end if;
  raise notice 'QA-#3 ok: losing a login demotes the row; losing the last owner''s login is refused';
end $$;

-- QA #3: the trigger order this depends on, asserted rather than assumed.
--
-- household_members_unlinked_owner_demotes must fire AFTER
-- household_members_guard_role. PostgreSQL fires BEFORE triggers on one event
-- in alphabetical name order, and that is the only thing putting them in the
-- right order -- "u" sorts after "g", and nothing says so anywhere the next
-- person renaming a trigger would look.
--
-- Running the wrong way round does not fail visibly here: the demote sets
-- new.role, the guard then sees a role change it did not authorise, and an
-- ORDINARY ACCOUNT DELETION starts failing with "only an owner can change a
-- member's role" -- an error about roles, raised by deleting a login, nowhere
-- near the trigger that caused it. Cheap to assert, miserable to debug.
do $$
declare demote_name text; guard_name text;
begin
  select tgname into guard_name from pg_trigger
  where tgrelid = 'public.household_members'::regclass
    and not tgisinternal and tgname = 'household_members_guard_role';
  select tgname into demote_name from pg_trigger
  where tgrelid = 'public.household_members'::regclass
    and not tgisinternal and tgname = 'household_members_unlinked_owner_demotes';

  if guard_name is null or demote_name is null then
    raise exception 'QA-#3 FAILED: expected both the role guard and the demote trigger, found guard=% demote=%',
      guard_name, demote_name;
  end if;

  if demote_name <= guard_name then
    raise exception 'QA-#3 FAILED: % must sort AFTER % so it fires second; renaming either one breaks deleting an auth account',
      demote_name, guard_name;
  end if;

  raise notice 'QA-#3 ok: the demote trigger is ordered after the role guard, which is what makes an account deletion work';
end $$;

-- QA #3: the label and the login cannot be separated by hand either.
do $$
begin
  begin
    insert into household_members (household_id, display_name, role, user_id)
    values ('aaaaaaaa-0000-0000-0000-00000000000b', 'Unloggable', 'owner', null);
    raise exception 'QA-#3 FAILED: an owner row with no login was inserted';
  exception
    when check_violation then null;
  end;

  begin
    update household_members set user_id = null
    where id = 'aaaaaaaa-2222-0000-0000-00000000000c';
    raise exception 'QA-#3 FAILED: the last owner unlinked their own login';
  exception
    when check_violation then null;
  end;
  raise notice 'QA-#3 ok: an owner row cannot be created or edited into having no login';
end $$;

-- QA #7: the scheduled jobs the migrations create must at least be well formed.
--
-- The pg_cron/pg_net stubs record a job and never execute its body, so nothing
-- here proves the HTTP call succeeds -- that needs the real project, and a
-- successful pg_cron dispatch is not proof of downstream HTTP success even
-- there. What this does prove is the part that is decidable offline and was
-- checked by nothing: that each job exists, on the schedule intended, calling
-- the endpoint intended, carrying the authentication that endpoint requires.
--
-- Worth having because every one of those can be broken silently. The webhook
-- rejects any request without its shared secret, and the price function is
-- behind JWT verification: drop either header while editing these migrations
-- and cron keeps dispatching happily while the far end 401s every night.
do $$
declare cmd text; sched text;
begin
  select command, schedule into cmd, sched from cron.job where jobname = 'weekday-price-refresh';
  if cmd is null then raise exception 'QA-#7 FAILED: the migrations do not create weekday-price-refresh'; end if;
  if sched <> '0 23 * * 0,1,2,3,4' then
    raise exception 'QA-#7 FAILED: weekday-price-refresh runs on %, expected weekdays at 23:00', sched;
  end if;
  if position('/functions/v1/price-refresh' in cmd) = 0 then
    raise exception 'QA-#7 FAILED: weekday-price-refresh does not call the price-refresh function';
  end if;
  -- price-refresh is deployed with verify_jwt = true (supabase/config.toml),
  -- so the job must present a bearer token, and it must come from the vault
  -- rather than being pasted into the migration.
  if position('Authorization' in cmd) = 0 or position('vault.decrypted_secrets' in cmd) = 0 then
    raise exception 'QA-#7 FAILED: weekday-price-refresh does not authenticate from the vault';
  end if;

  -- QA #1: this one existed only in production. It was scheduled by hand and
  -- was in no migration, so a rebuilt project never accrued fixed-deposit
  -- interest -- silently, because the app keeps working and the numbers just
  -- stop moving.
  select command, schedule into cmd, sched from cron.job where jobname = 'daily-fd-accrual';
  if cmd is null then raise exception 'QA-#1 FAILED: the migrations do not create daily-fd-accrual'; end if;
  if sched <> '0 23 * * *' then
    raise exception 'QA-#1 FAILED: daily-fd-accrual runs on %, expected daily at 23:00', sched;
  end if;
  if position('/functions/v1/fd-accrual' in cmd) = 0 then
    raise exception 'QA-#1 FAILED: daily-fd-accrual does not call the fd-accrual function';
  end if;
  if position('Authorization' in cmd) = 0 or position('vault.decrypted_secrets' in cmd) = 0 then
    raise exception 'QA-#1 FAILED: daily-fd-accrual does not authenticate from the vault';
  end if;

  select command, schedule into cmd, sched from cron.job where jobname = 'daily-recurring-nudge-check';
  if cmd is null then raise exception 'QA-#7 FAILED: the migrations do not create daily-recurring-nudge-check'; end if;
  if sched <> '0 5 * * *' then
    raise exception 'QA-#7 FAILED: daily-recurring-nudge-check runs on %, expected daily at 05:00', sched;
  end if;
  if position('run_recurring_check=1' in cmd) = 0 then
    raise exception 'QA-#7 FAILED: daily-recurring-nudge-check does not call the recurring-check route';
  end if;
  -- The webhook checks this header before parsing anything; without it every
  -- nightly run is rejected and nothing says so.
  if position('X-Telegram-Bot-Api-Secret-Token' in cmd) = 0 then
    raise exception 'QA-#7 FAILED: daily-recurring-nudge-check sends no shared secret';
  end if;

  raise notice 'QA-#7/#1 ok: all three scheduled jobs are created by migrations, well formed and authenticated';
end $$;

-- QA #8: the link token must come from somewhere unguessable.
--
-- It was `lpad(floor(random() * 1000000)::text, 6, '0')` -- one of a million
-- values, from a PRNG that is not meant to be unpredictable, live for fifteen
-- minutes and checked against every unlinked sender who messages the bot.
--
-- generate_telegram_link_code() is SECURITY DEFINER but still checks
-- is_household_member(), which resolves through auth.uid() -- so the claim has
-- to be set even here, where RLS itself is bypassed. Set transaction-locally
-- and cleared at the end of the block so nothing after it inherits an
-- identity.
do $$
declare
  v_member uuid := 'bbbbbbbb-2222-0000-0000-00000000000a';
  v_codes text[] := '{}';
  v_code text;
  v_expires timestamptz;
  i int;
begin
  insert into households (id, name) values ('bbbbbbbb-0000-0000-0000-00000000000a', 'Link token test');
  insert into auth.users (id, email) values ('bbbbbbbb-1111-0000-0000-00000000000a', 'link@example.test');
  insert into household_members (id, household_id, display_name, role, user_id)
  values (v_member, 'bbbbbbbb-0000-0000-0000-00000000000a', 'Linker', 'owner', 'bbbbbbbb-1111-0000-0000-00000000000a');

  perform set_config('request.jwt.claim.sub', 'bbbbbbbb-1111-0000-0000-00000000000a', true);

  for i in 1..25 loop
    v_code := generate_telegram_link_code(v_member);

    -- Six digits was the whole problem. Anything that short is guessable
    -- inside the token's own lifetime whatever the source.
    if length(v_code) <> 32 then
      raise exception 'QA-#8 FAILED: link token is % characters, expected 32', length(v_code);
    end if;
    if v_code !~ '^[0-9a-f]{32}$' then
      raise exception 'QA-#8 FAILED: link token % is not lowercase hex', v_code;
    end if;
    -- A generator that can repeat inside one session is not drawing from what
    -- it claims to be drawing from.
    if v_code = any(v_codes) then
      raise exception 'QA-#8 FAILED: generate_telegram_link_code repeated a token within % calls', i;
    end if;
    v_codes := v_codes || v_code;
  end loop;

  -- The token is stored on the row and expires; both are what the webhook
  -- checks before redeeming.
  select telegram_link_code, telegram_link_code_expires_at into v_code, v_expires
  from household_members where id = v_member;
  if v_code <> v_codes[array_length(v_codes, 1)] then
    raise exception 'QA-#8 FAILED: the latest token was not stored on the member row';
  end if;
  if v_expires is null or v_expires <= now() or v_expires > now() + interval '16 minutes' then
    raise exception 'QA-#8 FAILED: token expiry is %, expected within the next 15 minutes', v_expires;
  end if;

  perform set_config('request.jwt.claim.sub', '', true);
  raise notice 'QA-#8 ok: link tokens are 32 hex characters from a cryptographic source, stored with a 15-minute expiry';
end $$;

-- QA #8: failed attempts have somewhere to be counted, and it is not readable
-- by a household.
do $$
begin
  if to_regclass('public.telegram_link_attempts') is null then
    raise exception 'QA-#8 FAILED: telegram_link_attempts does not exist, so nothing can rate-limit guessing';
  end if;
  if not exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'telegram_link_attempts' and rowsecurity
  ) then
    raise exception 'QA-#8 FAILED: telegram_link_attempts has RLS disabled';
  end if;
  -- No policies is the intent, not an oversight: the sender is by definition
  -- not in a household, so there is no household to scope these rows to.
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'telegram_link_attempts') then
    raise exception 'QA-#8 FAILED: telegram_link_attempts has a policy; it should be service-role only';
  end if;
  raise notice 'QA-#8 ok: failed link attempts are recorded service-role-only, invisible to every client';
end $$;

-- QA §7: approve_intake names the offending parameter instead of leaving the
-- caller to decode a constraint violation, and writes nothing when it refuses.
do $$
declare
  before_count int;
  after_count int;
begin
  select count(*) into before_count from transactions;

  insert into intake (id, household_id, source, raw_text, parsed_amount, status)
  values ('77777777-7777-7777-7777-77777777000a', '11111111-1111-1111-1111-111111111111', 'manual', 'x', 50, 'pending');

  begin
    perform approve_intake('77777777-7777-7777-7777-77777777000a',
                           '99999999-9999-9999-9999-99999999000b', 50, date '2026-09-04');
    raise exception 'QA-§7 FAILED: approve_intake accepted another household''s account';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform approve_intake('77777777-7777-7777-7777-77777777000a',
                           '33333333-3333-3333-3333-333333333333', 50, date '2026-09-04',
                           'expense', '99999999-9999-9999-9999-99999999000c');
    raise exception 'QA-§7 FAILED: approve_intake accepted another household''s category';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform approve_intake('77777777-7777-7777-7777-77777777000a',
                           '33333333-3333-3333-3333-333333333333', 50, date '2026-09-04',
                           'expense', null, 'AED', null, true, '99999999-9999-9999-9999-99999999000a');
    raise exception 'QA-§7 FAILED: approve_intake accepted another household''s member';
  exception
    when insufficient_privilege then null;
  end;

  select count(*) into after_count from transactions;
  if after_count <> before_count then
    raise exception 'QA-§7 FAILED: a refused approval still wrote % transaction(s)', after_count - before_count;
  end if;

  -- And the same call, entirely within one household, still works.
  perform approve_intake('77777777-7777-7777-7777-77777777000a',
                         '33333333-3333-3333-3333-333333333333', 50, date '2026-09-04',
                         'expense', '88888888-8888-8888-8888-88888888000c');
  if (select status from intake where id = '77777777-7777-7777-7777-77777777000a') <> 'approved' then
    raise exception 'QA-§7 FAILED: a legitimate approval did not go through';
  end if;
  raise notice 'QA-§7 ok: approve_intake refuses foreign ids, writes nothing, still approves its own';
end $$;

-- A guessed date (intake.date_guessed): approve_intake refuses it until a
-- person has set or confirmed the day, writes nothing when it refuses, and
-- records the day the caller gave once confirmed. An entry whose message gave
-- its date needs no confirmation, so the bot's fast confirm is unchanged.
do $$
declare
  before_count int;
  result jsonb;
  occurred date;
begin
  -- One approve_intake only: a leftover ten-argument overload would make
  -- PostgREST calls ambiguous and would still approve a guess.
  if (select count(*) from pg_proc where proname = 'approve_intake' and pronamespace = 'public'::regnamespace) <> 1 then
    raise exception 'guessed date FAILED: approve_intake has more than one definition';
  end if;
  -- Granted by name, not left to default privileges: the Inbox calls it as
  -- authenticated and the bot as service_role.
  if (select count(distinct a.grantee)
        from pg_proc p, aclexplode(p.proacl) a
       where p.oid = 'approve_intake(uuid, uuid, numeric, date, text, uuid, text, text, boolean, uuid, boolean)'::regprocedure
         and a.privilege_type = 'EXECUTE'
         and a.grantee in ('authenticated'::regrole, 'service_role'::regrole)) <> 2 then
    raise exception 'guessed date FAILED: approve_intake is not granted to authenticated and service_role';
  end if;

  insert into intake (id, household_id, source, raw_text, parsed_amount, parsed_date, date_guessed, status)
  values ('55555555-5555-5555-5555-55555555d001', '11111111-1111-1111-1111-111111111111', 'telegram', 'AED 40 spent at Cafe', 40, '2026-09-29', true, 'pending');
  select count(*) into before_count from transactions;

  begin
    perform approve_intake('55555555-5555-5555-5555-55555555d001', '33333333-3333-3333-3333-333333333333', 40, date '2026-09-29', 'expense');
    raise exception 'guessed date FAILED: approved as read';
  exception
    when invalid_parameter_value then
      if position('no date' in sqlerrm) = 0 then raise; end if;
  end;
  begin
    perform approve_intake('55555555-5555-5555-5555-55555555d001', '33333333-3333-3333-3333-333333333333', 40, date '2026-09-29', 'expense',
                           p_date_confirmed => false);
    raise exception 'guessed date FAILED: approved with p_date_confirmed false';
  exception
    when invalid_parameter_value then null;
  end;
  if (select count(*) from transactions) <> before_count
     or (select status from intake where id = '55555555-5555-5555-5555-55555555d001') <> 'pending' then
    raise exception 'guessed date FAILED: a refused approval wrote something';
  end if;

  result := approve_intake('55555555-5555-5555-5555-55555555d001', '33333333-3333-3333-3333-333333333333', 40, date '2026-09-21', 'expense',
                           p_date_confirmed => true);
  select t.occurred_at into occurred from transactions t where t.id = (result ->> 'transaction_id')::uuid;
  if occurred is distinct from date '2026-09-21' then
    raise exception 'guessed date FAILED: the confirmed day was not recorded (got %)', occurred;
  end if;
  -- The entry keeps what the bot wrote, as the record of its guess.
  if (select date_guessed and parsed_date = date '2026-09-29' from intake where id = '55555555-5555-5555-5555-55555555d001') is not true then
    raise exception 'guessed date FAILED: the record of the guess was overwritten';
  end if;

  -- A retry of the approved entry still returns its transaction: the
  -- approved check comes before the date check.
  result := approve_intake('55555555-5555-5555-5555-55555555d001', '33333333-3333-3333-3333-333333333333', 40, date '2026-09-21', 'expense');
  if not (result ->> 'already_approved')::boolean then
    raise exception 'guessed date FAILED: a retry of the approved entry was not recognised';
  end if;

  insert into intake (id, household_id, source, raw_text, parsed_amount, parsed_date, status)
  values ('55555555-5555-5555-5555-55555555d002', '11111111-1111-1111-1111-111111111111', 'telegram', 'AED 15 at Cafe on 20 Sep', 15, '2026-09-20', 'pending');
  result := approve_intake('55555555-5555-5555-5555-55555555d002', '33333333-3333-3333-3333-333333333333', 15, date '2026-09-20', 'expense');
  if (result ->> 'already_approved')::boolean then
    raise exception 'guessed date FAILED: a dated entry was not approved';
  end if;

  raise notice 'guessed date ok: refused until confirmed, nothing written on refusal, the confirmed day recorded, dated entries unchanged';
end $$;

-- SHR-303: an update claim records whether processing finished, so a crash
-- before capture is retried instead of being suppressed forever.
do $$
declare r text;
begin
  -- A fresh update is claimed, and a second claim while it is live is not.
  if claim_telegram_update(9000001) <> 'claimed' then
    raise exception 'SHR-303 FAILED: a fresh update was not claimed';
  end if;
  -- A live claim is 'busy', not 'completed': the caller must answer non-200
  -- so Telegram retries, rather than 200, which would end the retries.
  if claim_telegram_update(9000001) <> 'busy' then
    raise exception 'SHR-303 FAILED: a live claim was not reported busy';
  end if;

  -- A handler that caught an error releases the claim; the next redelivery
  -- must reclaim it rather than drop it. This is the silent-loss case.
  update telegram_update_log set status = 'failed' where update_id = 9000001;
  if claim_telegram_update(9000001) <> 'claimed' then
    raise exception 'SHR-303 FAILED: a failed update was not reclaimed on redelivery';
  end if;
  if (select attempts from telegram_update_log where update_id = 9000001) <> 2 then
    raise exception 'SHR-303 FAILED: reclaiming did not count the attempt';
  end if;

  -- A crash that ran no handler at all leaves 'processing' behind. Within the
  -- lease it is still someone else's; past it, it is reclaimable.
  update telegram_update_log set claimed_at = now() - interval '10 minutes' where update_id = 9000001;
  if claim_telegram_update(9000001) <> 'claimed' then
    raise exception 'SHR-303 FAILED: a claim abandoned past its lease was not reclaimable';
  end if;

  -- A completed update is never processed again, however old.
  update telegram_update_log set status = 'completed', claimed_at = now() - interval '10 minutes'
   where update_id = 9000001;
  if claim_telegram_update(9000001) <> 'completed' then
    raise exception 'SHR-303 FAILED: a completed update was not reported completed';
  end if;
  raise notice 'SHR-303 ok: fresh, busy, failed, abandoned and completed claims each behave';
end $$;

-- SHR-303: the ordinary app roles cannot claim updates.
do $$
begin
  if has_function_privilege('authenticated', 'claim_telegram_update(bigint, interval)', 'execute')
     or has_function_privilege('anon', 'claim_telegram_update(bigint, interval)', 'execute') then
    raise exception 'SHR-303 FAILED: claim_telegram_update is executable by an app role';
  end if;
  raise notice 'SHR-303 ok: only service_role can claim updates';
end $$;

-- SHR-303: a redelivered goal contribution is one row, not two.
insert into goals (id, household_id, name, target_amount)
values ('55555555-5555-5555-5555-555555550001', '11111111-1111-1111-1111-111111111111', 'House', 100000),
       ('55555555-5555-5555-5555-555555550002', '11111111-1111-1111-1111-111111111111', 'Car', 50000);
do $$
begin
  insert into goal_contributions (goal_id, amount, occurred_at, source, source_ref)
  values ('55555555-5555-5555-5555-555555550001', 500, date '2026-09-24', 'telegram', '9000002');
  begin
    insert into goal_contributions (goal_id, amount, occurred_at, source, source_ref)
    values ('55555555-5555-5555-5555-555555550001', 500, date '2026-09-24', 'telegram', '9000002');
    raise exception 'SHR-303 FAILED: the same delivery recorded a goal contribution twice';
  exception
    when unique_violation then null;
  end;

  -- Keyed per goal: one message funding two goals is not a redelivery.
  insert into goal_contributions (goal_id, amount, occurred_at, source, source_ref)
  values ('55555555-5555-5555-5555-555555550002', 200, date '2026-09-24', 'telegram', '9000002');

  -- Contributions entered in the app carry no source_ref and are unconstrained.
  insert into goal_contributions (goal_id, amount, occurred_at)
  values ('55555555-5555-5555-5555-555555550001', 500, date '2026-09-24'),
         ('55555555-5555-5555-5555-555555550001', 500, date '2026-09-24');
  raise notice 'SHR-303 ok: a redelivered contribution is refused; two goals and app entries are not';
end $$;

-- Independence income: the shapes that mean nothing are refused at the source.
do $$
begin
  insert into independence_income (household_id, name, kind, amount, starts_after_years, lasts_years)
  values ('11111111-1111-1111-1111-111111111111', 'Rent', 'yearly', 48000, 2, 20);
  insert into independence_income (household_id, name, kind, amount, starts_after_years)
  values ('11111111-1111-1111-1111-111111111111', 'Gratuity', 'lump_sum', 90000, 0);

  begin
    insert into independence_income (household_id, name, kind, amount, lasts_years)
    values ('11111111-1111-1111-1111-111111111111', 'Sale', 'lump_sum', 1000, 5);
    raise exception 'independence_income FAILED: a lump sum accepted a duration';
  exception when check_violation then null;
  end;
  begin
    insert into independence_income (household_id, name, kind, amount)
    values ('11111111-1111-1111-1111-111111111111', 'Nothing', 'yearly', 0);
    raise exception 'independence_income FAILED: a zero amount was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into independence_income (household_id, name, kind, amount)
    values ('11111111-1111-1111-1111-111111111111', '   ', 'yearly', 100);
    raise exception 'independence_income FAILED: a blank name was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into independence_income (household_id, name, kind, amount)
    values ('11111111-1111-1111-1111-111111111111', 'Pension', 'monthly', 100);
    raise exception 'independence_income FAILED: an unknown kind was accepted';
  exception when check_violation then null;
  end;
  raise notice 'independence_income ok: lump sums take no duration; amounts, names and kinds are checked';
end $$;

-- A savings category is an expense category set aside; income cannot be one.
do $$
begin
  insert into categories (household_id, name, kind, is_savings)
  values ('11111111-1111-1111-1111-111111111111', 'Savings & Investments', 'expense', true);
  begin
    insert into categories (household_id, name, kind, is_savings)
    values ('11111111-1111-1111-1111-111111111111', 'Interest', 'income', true);
    raise exception 'is_savings FAILED: an income category was marked as savings';
  exception when check_violation then null;
  end;
  raise notice 'is_savings ok: only expense categories can be savings';
end $$;

-- Life plan: ages belong to a member of the same household, in a sane range;
-- the retirement settings refuse figures that mean nothing.
do $$
declare n int;
begin
  insert into household_members (id, household_id, display_name)
  values ('abababab-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Planner');
  insert into member_life (member_id, household_id, birth_year, life_expectancy)
  values ('abababab-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 1994, 85);

  begin
    -- A member of another household, filed under this one.
    insert into member_life (member_id, household_id, birth_year, life_expectancy)
    values ('99999999-9999-9999-9999-99999999000a', '11111111-1111-1111-1111-111111111111', 1994, 85);
    raise exception 'life plan FAILED: ages were filed against another household''s member';
  exception when foreign_key_violation then null;
  end;
  begin
    update member_life set life_expectancy = 30 where member_id = 'abababab-0000-0000-0000-000000000001';
    raise exception 'life plan FAILED: a life expectancy of 30 was accepted';
  exception when check_violation then null;
  end;
  begin
    update member_life set birth_year = 1850 where member_id = 'abababab-0000-0000-0000-000000000001';
    raise exception 'life plan FAILED: a birth year of 1850 was accepted';
  exception when check_violation then null;
  end;

  insert into planning_assumptions (household_id, retirement_year, retirement_annual_spend, retirement_return_pct, survivor_spend_pct)
  values ('11111111-1111-1111-1111-111111111111', 2054, 61000, 8.5, 50)
  on conflict (household_id) do update set retirement_year = excluded.retirement_year;
  begin
    update planning_assumptions set survivor_spend_pct = 0 where household_id = '11111111-1111-1111-1111-111111111111';
    raise exception 'life plan FAILED: spending of 0%% for one person was accepted';
  exception when check_violation then null;
  end;
  begin
    update planning_assumptions set retirement_annual_spend = -1 where household_id = '11111111-1111-1111-1111-111111111111';
    raise exception 'life plan FAILED: negative retirement spending was accepted';
  exception when check_violation then null;
  end;

  -- A goal counts on the timeline unless the household says otherwise.
  insert into goals (id, household_id, name, target_amount, target_date)
  values ('abababab-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Second car', 45000, date '2027-06-01');
  select count(*) into n from goals where id = 'abababab-0000-0000-0000-000000000002' and counts_in_life_plan;
  if n <> 1 then raise exception 'life plan FAILED: a new goal was left off the timeline'; end if;

  -- Removing the member removes their ages with them.
  delete from household_members where id = 'abababab-0000-0000-0000-000000000001';
  select count(*) into n from member_life where member_id = 'abababab-0000-0000-0000-000000000001';
  if n <> 0 then raise exception 'life plan FAILED: ages outlived the member they belong to'; end if;
  raise notice 'life plan ok: ages stay in their household and range; retirement settings are checked';
end $$;

-- Goal costs: a today's cost may carry its own rate; a rate on an amount-on-
-- the-date means nothing and is refused, as are rates and priorities out of range.
do $$
begin
  insert into goals (household_id, name, target_amount, target_date, cost_today, inflation_pct, priority)
  values ('11111111-1111-1111-1111-111111111111', 'Villa', 5000000, date '2044-09-01', true, 8, 1);
  begin
    insert into goals (household_id, name, target_amount, cost_today, inflation_pct)
    values ('11111111-1111-1111-1111-111111111111', 'Rated', 100, false, 5);
    raise exception 'goal costs FAILED: a rate was accepted on an amount on the date';
  exception when check_violation then null;
  end;
  begin
    insert into goals (household_id, name, target_amount, cost_today, inflation_pct)
    values ('11111111-1111-1111-1111-111111111111', 'Wild', 100, true, 45);
    raise exception 'goal costs FAILED: a 45%% yearly rise was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into goals (household_id, name, target_amount, priority)
    values ('11111111-1111-1111-1111-111111111111', 'Zero', 100, 0);
    raise exception 'goal costs FAILED: a priority of 0 was accepted';
  exception when check_violation then null;
  end;
  raise notice 'goal costs ok: rates only on today''s costs, rates and priorities in range';
end $$;

-- Debt accounts: a debt links to one loan or card account in its own
-- household, never to an asset, and never two debts to one account. Closing
-- the loan's account by deleting it leaves the debt, unlinked.
do $$
declare
  linked uuid;
begin
  insert into accounts (id, household_id, name, type, balance, is_shared)
  values ('cdcdcdcd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Car loan', 'loan', 40000, true);
  insert into debts (id, household_id, name, balance, apr_pct, minimum_payment, account_id)
  values ('cdcdcdcd-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Car loan', 40000, 3.5, 2193, 'cdcdcdcd-0000-0000-0000-000000000001');
  begin
    insert into debts (household_id, name, balance, apr_pct, minimum_payment, account_id)
    values ('11111111-1111-1111-1111-111111111111', 'Twice', 1, 1, 1, 'cdcdcdcd-0000-0000-0000-000000000001');
    raise exception 'debt accounts FAILED: two debts were linked to one account';
  exception when unique_violation then null;
  end;
  begin
    insert into accounts (id, household_id, name, type, balance, is_shared)
    values ('cdcdcdcd-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'Savings', 'savings', 10, true);
    insert into debts (household_id, name, balance, apr_pct, minimum_payment, account_id)
    values ('11111111-1111-1111-1111-111111111111', 'Asset', 1, 1, 1, 'cdcdcdcd-0000-0000-0000-000000000003');
    raise exception 'debt accounts FAILED: a savings account was accepted as a debt';
  exception when check_violation then null;
  end;
  begin
    insert into debts (household_id, name, balance, apr_pct, minimum_payment, account_id)
    values ('11111111-1111-1111-1111-111111111111', 'Theirs', 1, 1, 1, '99999999-9999-9999-9999-99999999000b');
    raise exception 'debt accounts FAILED: another household''s card was accepted';
  exception when foreign_key_violation then null;
  end;
  delete from accounts where id = 'cdcdcdcd-0000-0000-0000-000000000001';
  select account_id into linked from debts where id = 'cdcdcdcd-0000-0000-0000-000000000002';
  if linked is not null then
    raise exception 'debt accounts FAILED: the debt kept a deleted account';
  end if;
  raise notice 'debt accounts ok: one loan or card account per debt, in its own household';
end $$;

-- Policies and plans: a reminder in rupees keeps its rupee figure and an AED
-- amount that follows the household's rate; one in rupees is refused until a
-- rate exists; an end date cannot come before the schedule starts. A dated
-- lump sum is a lump sum. A category can be marked as stopping with work.
do $$
declare
  aed numeric;
begin
  update households set inr_per_aed = null where id = '11111111-1111-1111-1111-111111111111';
  begin
    insert into recurring (household_id, name, amount, currency, native_amount, cadence, next_due_date)
    values ('11111111-1111-1111-1111-111111111111', 'LIC', 0, 'INR', -89554, 'yearly', '2026-11-11');
    raise exception 'policies FAILED: a rupee reminder was accepted with no rate';
  exception when check_violation then null;
  end;
  update households set inr_per_aed = 26 where id = '11111111-1111-1111-1111-111111111111';
  insert into recurring (id, household_id, name, amount, currency, native_amount, cadence, next_due_date, ends_on)
  values ('efefefef-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'LIC', 0, 'INR', -89554, 'yearly', '2026-11-11', '2034-11-11');
  select amount into aed from recurring where id = 'efefefef-0000-0000-0000-000000000001';
  if aed <> -3444.38 then
    raise exception 'policies FAILED: ₹89,554 at 26 became % AED', aed;
  end if;
  update households set inr_per_aed = 25 where id = '11111111-1111-1111-1111-111111111111';
  select amount into aed from recurring where id = 'efefefef-0000-0000-0000-000000000001';
  if aed <> -3582.16 then
    raise exception 'policies FAILED: the AED amount did not follow the new rate (got %)', aed;
  end if;
  update recurring set amount = -1 where id = 'efefefef-0000-0000-0000-000000000001';
  select amount into aed from recurring where id = 'efefefef-0000-0000-0000-000000000001';
  if aed <> -3582.16 then
    raise exception 'policies FAILED: an AED amount written over a rupee reminder stuck (got %)', aed;
  end if;
  begin
    insert into recurring (household_id, name, amount, currency, native_amount, cadence, next_due_date)
    values ('11111111-1111-1111-1111-111111111111', 'Half', -5, 'AED', -5, 'monthly', '2026-10-01');
    raise exception 'policies FAILED: an AED reminder carried a second amount';
  exception when check_violation then null;
  end;
  begin
    insert into recurring (household_id, name, amount, cadence, next_due_date, ends_on)
    values ('11111111-1111-1111-1111-111111111111', 'Backwards', -5, 'monthly', '2026-10-01', '2026-09-01');
    raise exception 'policies FAILED: a schedule ending before it starts was accepted';
  exception when check_violation then null;
  end;
  insert into independence_income (household_id, name, kind, amount, in_year, currency)
  values ('11111111-1111-1111-1111-111111111111', 'LIC A maturity', 'lump_sum', 4350000, 2044, 'INR');
  begin
    insert into independence_income (household_id, name, kind, amount, in_year)
    values ('11111111-1111-1111-1111-111111111111', 'Pension', 'yearly', 1000, 2044);
    raise exception 'policies FAILED: a yearly income was given a calendar year';
  exception when check_violation then null;
  end;
  update categories set stops_after_work = true where household_id = '11111111-1111-1111-1111-111111111111';
  raise notice 'policies ok: rupee reminders follow the rate, schedules end, dated lump sums, stopping categories';
end $$;

-- Balance check-in: one per household per month, and a switch that is on
-- unless turned off.
do $$
declare
  enabled boolean;
begin
  insert into brief_sends (household_id, kind, period_key) values ('11111111-1111-1111-1111-111111111111', 'balance_checkin', '2026-09');
  begin
    insert into brief_sends (household_id, kind, period_key) values ('11111111-1111-1111-1111-111111111111', 'balance_checkin', '2026-09');
    raise exception 'balance check-in FAILED: the same month was recorded twice';
  exception when unique_violation then null;
  end;
  begin
    insert into brief_sends (household_id, kind, period_key) values ('11111111-1111-1111-1111-111111111111', 'daily', '2026-09-01');
    raise exception 'balance check-in FAILED: an unknown kind was accepted';
  exception when check_violation then null;
  end;
  insert into telegram_notification_prefs (household_id) values ('11111111-1111-1111-1111-111111111111')
  on conflict (household_id) do nothing;
  select balance_checkin_enabled into enabled from telegram_notification_prefs where household_id = '11111111-1111-1111-1111-111111111111';
  if enabled is not true then
    raise exception 'balance check-in FAILED: the check-in is not on by default';
  end if;
  raise notice 'balance check-in ok: once a month, on by default';
end $$;

-- Category owner: a member of the same household, or null for shared.
do $$
declare
  cat uuid;
begin
  insert into categories (household_id, name, kind, owner_member_id)
  values ('11111111-1111-1111-1111-111111111111', 'Own car', 'expense', '22222222-2222-2222-2222-222222222222')
  returning id into cat;
  begin
    insert into households (id, name) values ('11111111-1111-1111-1111-11111111aaaa', 'Other');
    insert into household_members (id, household_id, display_name)
    values ('22222222-2222-2222-2222-22222222aaaa', '11111111-1111-1111-1111-11111111aaaa', 'Stranger');
    update categories set owner_member_id = '22222222-2222-2222-2222-22222222aaaa' where id = cat;
    raise exception 'category owner FAILED: a member of another household owned a category';
  exception when foreign_key_violation then null;
  end;
  if (select owner_member_id from categories where id = cat) is distinct from '22222222-2222-2222-2222-222222222222' then
    raise exception 'category owner FAILED: the owner was not kept';
  end if;
  raise notice 'category owner ok: same-household members only';
end $$;

-- Intake dates: a date the message did not give is marked as a guess, and an
-- entry is taken as dated unless the bot says otherwise.
do $$
declare
  guessed boolean;
begin
  insert into intake (household_id, source, raw_text, parsed_date)
  values ('11111111-1111-1111-1111-111111111111', 'telegram', 'AED 20 at Cafe', '2026-09-29')
  returning date_guessed into guessed;
  if guessed is distinct from false then
    raise exception 'intake date FAILED: a new entry was taken as undated (got %)', guessed;
  end if;
  insert into intake (household_id, source, raw_text, parsed_date, date_guessed)
  values ('11111111-1111-1111-1111-111111111111', 'telegram', 'AED 30 at Shop', '2026-09-29', true)
  returning date_guessed into guessed;
  if guessed is not true then
    raise exception 'intake date FAILED: the guess was not kept';
  end if;
  raise notice 'intake date ok: dated unless marked a guess';
end $$;

-- The household's day, and rupee balances that follow the rate.
--
-- household_today() is Dubai's date at any moment. Fixed deposits accrue to
-- it and a transaction saved with no date takes it, whatever zone the session
-- is in. Between them the two zones below disagree with Dubai's date at every
-- hour (UTC-12 before 16:00 Dubai, UTC+14 from 14:00), so a return to
-- current_date fails here whenever this runs. A rupee account follows its own
-- household's rate, has no AED value without one, and is not edited by a new
-- one; a dollar account stays on the peg.
do $$
declare
  hh constant uuid := '11111111-1111-1111-1111-111111111111';
  other_hh constant uuid := 'acacacac-0000-0000-0000-000000000001';
  rupee constant uuid := 'acacacac-0000-0000-0000-000000000002';
  dollar constant uuid := 'acacacac-0000-0000-0000-000000000003';
  theirs constant uuid := 'acacacac-0000-0000-0000-000000000004';
  growing constant uuid := 'acacacac-0000-0000-0000-000000000005';
  maturing constant uuid := 'acacacac-0000-0000-0000-000000000006';
  backdated constant timestamptz := '2026-01-01 00:00:00+00';
  saved_tz text := current_setting('timezone');
  session_zone text;
  aed numeric;
  touched timestamptz;
  bal numeric;
  fd_state text;
  dated date;
begin
  if household_today('2026-09-15 21:30:00+00') <> date '2026-09-16' then
    raise exception 'household day FAILED: 01:30 in Dubai on the 16th was dated %', household_today('2026-09-15 21:30:00+00');
  end if;
  if household_today('2026-09-15 19:30:00+00') <> date '2026-09-15' then
    raise exception 'household day FAILED: 23:30 in Dubai on the 15th was dated %', household_today('2026-09-15 19:30:00+00');
  end if;

  insert into accounts (id, household_id, name, type, balance, principal, interest_rate_pct, compounding, opened_date, maturity_date, is_shared)
  values
    (growing, hh, 'Deposit', 'fd', 0, 10000, 3.65, 'simple', household_today() - 100, household_today() + 265, true),
    (maturing, hh, 'Deposit ending today', 'fd', 0, 10000, 3.65, 'simple', household_today() - 365, household_today(), true);

  foreach session_zone in array array['Etc/GMT+12', 'Pacific/Kiritimati'] loop
    perform set_config('timezone', session_zone, true);
    -- What fd-accrual does every night: a no-op write the trigger re-values.
    update accounts set fd_status = 'active' where id in (growing, maturing);
    select balance into bal from accounts where id = growing;
    if bal <> 10100 then
      raise exception 'household day FAILED: 100 days of 10,000 at 3.65%% came to % with the session in %', bal, session_zone;
    end if;
    select balance, fd_status into bal, fd_state from accounts where id = maturing;
    if fd_state <> 'matured' or bal <> 10365 then
      raise exception 'household day FAILED: a deposit maturing today was % at % with the session in %', fd_state, bal, session_zone;
    end if;
    insert into transactions (household_id, account_id, amount, is_shared)
    values (hh, '33333333-3333-3333-3333-333333333333', -1, true)
    returning occurred_at into dated;
    if dated <> household_today() then
      raise exception 'household day FAILED: a transaction with no date was dated % with the session in %', dated, session_zone;
    end if;
  end loop;
  perform set_config('timezone', saved_tz, true);

  insert into households (id, name, inr_per_aed) values (other_hh, 'Other household', 30);
  insert into accounts (id, household_id, name, type, currency, balance, is_shared)
  values (theirs, other_hh, 'Their rupee account', 'savings', 'INR', 30000, true);

  update households set inr_per_aed = 20 where id = hh;
  insert into accounts (id, household_id, name, type, currency, balance, is_shared)
  values
    (rupee, hh, 'Rupee savings', 'savings', 'INR', 100000, true),
    (dollar, hh, 'Dollar account', 'checking', 'USD', 1000, true);
  select balance_aed into aed from accounts where id = rupee;
  if aed <> 5000 then
    raise exception 'rupee rate FAILED: 100,000 rupees at 20 became % AED', aed;
  end if;

  -- now() is fixed for the whole transaction, so backdate the last edit (with
  -- triggers off) to be able to see whether a later write moves it.
  perform set_config('session_replication_role', 'replica', true);
  update accounts set updated_at = backdated where id = rupee;
  perform set_config('session_replication_role', 'origin', true);

  update households set inr_per_aed = 25 where id = hh;
  select balance_aed, updated_at into aed, touched from accounts where id = rupee;
  if aed <> 4000 then
    raise exception 'rupee rate FAILED: the AED value did not follow the new rate (got %)', aed;
  end if;
  if touched <> backdated then
    raise exception 'rupee rate FAILED: a new rate counted as an edit (updated_at %)', touched;
  end if;
  if (select balance_aed from accounts where id = dollar) <> 3672.50 then
    raise exception 'rupee rate FAILED: a dollar account moved off the peg';
  end if;
  if (select balance_aed from accounts where id = theirs) <> 1000 then
    raise exception 'rupee rate FAILED: another household''s rupee account followed this household''s rate';
  end if;

  update households set inr_per_aed = null where id = hh;
  select balance_aed into aed from accounts where id = rupee;
  if aed is not null then
    raise exception 'rupee rate FAILED: with no rate, a rupee balance was valued at % AED', aed;
  end if;

  update accounts set name = 'Rupee savings, renamed' where id = rupee;
  if (select updated_at from accounts where id = rupee) = backdated then
    raise exception 'rupee rate FAILED: renaming an account no longer counts as an edit';
  end if;

  update households set inr_per_aed = 25 where id = hh;
  raise notice 'household day ok: Dubai''s date for deposits and undated transactions; rupee accounts follow their own household''s rate, are unknown without one, and are not edited by it';
end $$;

-- The membership helpers live in private, out of the API schema, and every
-- policy is still bound to them there. The move relies on PostgreSQL storing
-- the function a policy calls by OID, so this checks the result rather than
-- trusting the mechanism: no policy may call the public names (now
-- invoker-rights wrappers), anon must reach neither, and the two roles
-- policies run as must keep EXECUTE.
do $$
declare
  n int;
  receipts text;
begin
  select count(*) into n
  from pg_proc p join pg_namespace s on s.oid = p.pronamespace
  where s.nspname = 'private'
    and p.proname in ('is_household_member', 'is_household_owner')
    and p.prosecdef
    and p.proconfig @> array['search_path=""'];
  if n <> 2 then
    raise exception 'helpers FAILED: % of 2 membership helpers are SECURITY DEFINER in private with an empty search_path', n;
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname = 'public' and p.proname in ('is_household_member', 'is_household_owner') and p.prosecdef
  ) then
    raise exception 'helpers FAILED: a SECURITY DEFINER membership helper is still in the API schema';
  end if;

  -- pg_policies prints a function's schema only when its bare name would not
  -- resolve to it, and the bare names now resolve to the public wrappers. So
  -- a policy bound to private reads "private.is_household_...(", and one
  -- bound to a wrapper reads the bare name.
  select count(*) into n from pg_policies
  where concat_ws(' ', qual, with_check) ~ '(^|[^.[:alnum:]_])is_household_(member|owner)\(';
  if n <> 0 then
    raise exception 'helpers FAILED: % policies call the public wrappers rather than private.*', n;
  end if;

  select count(*) into n from pg_policies
  where concat_ws(' ', qual, with_check) ~ 'private\.is_household_(member|owner)\(';
  if n < 50 then
    raise exception 'helpers FAILED: only % policies call the private helpers; the move lost some', n;
  end if;

  select qual into receipts from pg_policies
  where schemaname = 'storage' and policyname = 'household members can read their receipt photos';
  if receipts is null or receipts not like '%private.is_household_member(%' then
    raise exception 'helpers FAILED: the receipt bucket policy does not call private.is_household_member() (%)', receipts;
  end if;

  if has_schema_privilege('anon', 'private', 'usage')
     or has_function_privilege('anon', 'private.is_household_member(uuid)', 'execute')
     or has_function_privilege('anon', 'private.is_household_owner(uuid)', 'execute')
     or has_function_privilege('anon', 'public.is_household_member(uuid)', 'execute')
     or has_function_privilege('anon', 'public.is_household_owner(uuid)', 'execute') then
    raise exception 'helpers FAILED: anon can reach a membership helper';
  end if;

  if not (has_schema_privilege('authenticated', 'private', 'usage')
      and has_function_privilege('authenticated', 'private.is_household_member(uuid)', 'execute')
      and has_function_privilege('authenticated', 'private.is_household_owner(uuid)', 'execute')
      and has_function_privilege('service_role', 'private.is_household_member(uuid)', 'execute')
      and has_function_privilege('service_role', 'private.is_household_owner(uuid)', 'execute')) then
    raise exception 'helpers FAILED: authenticated or service_role lost EXECUTE on a helper every policy calls';
  end if;

  raise notice 'helpers ok: membership helpers are private definer functions, every policy calls them there, anon reaches neither';
end $$;

-- One household per Rokda: create_household() keeps the shape the helpers
-- have (definer rights, nothing on its path) and stays out of anon's reach.
do $$
begin
  if not exists (
    select 1 from pg_proc
    where oid = 'public.create_household(text, text)'::regprocedure
      and prosecdef
      and proconfig @> array['search_path=""']
  ) then
    raise exception 'one-household FAILED: create_household() is not SECURITY DEFINER with an empty search_path';
  end if;
  if has_function_privilege('anon', 'public.create_household(text, text)', 'execute')
     or not has_function_privilege('authenticated', 'public.create_household(text, text)', 'execute') then
    raise exception 'one-household FAILED: create_household() grants changed';
  end if;
  raise notice 'one-household ok: create_household() is a definer function with an empty path, for signed-in callers only';
end $$;

rollback;
