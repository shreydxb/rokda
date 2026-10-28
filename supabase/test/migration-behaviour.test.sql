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

-- SHR-252, SHR-321: approval never stores an unconverted amount that every
-- dashboard total would misread as AED. A payment in another currency is
-- approved only with both figures: the AED that counts, and the amount in its
-- own currency.
insert into intake (id, household_id, source, parsed_amount, status)
values ('55555555-5555-5555-5555-555555555559', '11111111-1111-1111-1111-111111111111', 'manual', 40, 'pending');
do $$
declare result jsonb;
begin
  begin
    perform approve_intake(
      '55555555-5555-5555-5555-555555555559', '33333333-3333-3333-3333-333333333333',
      40, date '2026-09-05', 'expense', null, 'USD');
    raise exception 'SHR-252 FAILED: a USD approval without its USD amount was accepted';
  exception
    when invalid_parameter_value then null;
  end;
  begin
    perform approve_intake(
      '55555555-5555-5555-5555-555555555559', '33333333-3333-3333-3333-333333333333',
      40, date '2026-09-05', 'expense', p_native_amount => 10);
    raise exception 'SHR-321 FAILED: an AED approval carried another amount';
  exception
    when invalid_parameter_value then null;
  end;
  result := approve_intake(
    '55555555-5555-5555-5555-555555555559', '33333333-3333-3333-3333-333333333333',
    146.9, date '2026-09-05', 'expense', null, 'USD', p_native_amount => 40, p_aed_estimated => true);
  if not exists (select 1 from transactions where id = (result ->> 'transaction_id')::uuid
                 and amount = -146.9 and currency = 'USD' and native_amount = -40 and aed_estimated) then
    raise exception 'SHR-321 FAILED: a USD approval did not keep the AED, the USD amount and the estimate flag';
  end if;
  raise notice 'SHR-252 ok: a payment in another currency is approved only with both its amounts';
end $$;

-- SHR-321: a payment's own-currency amount and the AED that counts agree.
do $$
declare
  hh constant uuid := '11111111-1111-1111-1111-111111111111';
  card constant uuid := '33333333-3333-3333-3333-333333333333';
  tx constant uuid := '44444444-4444-4444-4444-4444444444e1';
begin
  insert into transactions (id, household_id, account_id, amount, currency, native_amount, aed_estimated, occurred_at, is_shared)
  values (tx, hh, card, -1000, 'INR', -23000, true, '2026-09-10', true);
  begin
    update transactions set native_amount = null where id = tx;
    raise exception 'SHR-321 FAILED: a rupee payment lost its rupee amount';
  exception when check_violation then null;
  end;
  begin
    update transactions set native_amount = 23000 where id = tx;
    raise exception 'SHR-321 FAILED: the two amounts went in different directions';
  exception when check_violation then null;
  end;
  begin
    insert into transactions (household_id, account_id, amount, currency, native_amount, occurred_at, is_shared)
    values (hh, card, -5, 'AED', -5, '2026-09-10', true);
    raise exception 'SHR-321 FAILED: an AED payment carried another amount';
  exception when check_violation then null;
  end;
  begin
    insert into transactions (household_id, account_id, amount, aed_estimated, occurred_at, is_shared)
    values (hh, card, -5, true, '2026-09-10', true);
    raise exception 'SHR-321 FAILED: an AED payment was marked as estimated';
  exception when check_violation then null;
  end;
  -- The AED actually debited replaces the estimate.
  update transactions set amount = -1004.5, aed_estimated = false where id = tx;
  delete from transactions where id = tx;
  raise notice 'SHR-321 ok: the rupee amount and the AED agree, and only a foreign payment carries an estimate';
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
-- rejects any request without its shared secret, and price-refresh and
-- fd-accrual reject any without the scheduler secret: drop either header while
-- editing these migrations and cron keeps dispatching happily while the far
-- end refuses every night.
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
  -- price-refresh accepts the job only with the vault's scheduler secret,
  -- read when the job runs rather than pasted into the migration. The legacy
  -- service-role JWT is gone: Supabase is deleting legacy keys.
  if position('X-Rokda-Scheduler-Secret' in cmd) = 0 or position('get_scheduler_secret()' in cmd) = 0 then
    raise exception 'scheduler secret FAILED: weekday-price-refresh does not send the scheduler secret from the vault';
  end if;
  if position('service_role_key' in cmd) > 0 or position('Authorization' in cmd) > 0 then
    raise exception 'scheduler secret FAILED: weekday-price-refresh still sends the legacy service-role key';
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
  if position('X-Rokda-Scheduler-Secret' in cmd) = 0 or position('get_scheduler_secret()' in cmd) = 0 then
    raise exception 'scheduler secret FAILED: daily-fd-accrual does not send the scheduler secret from the vault';
  end if;
  if position('service_role_key' in cmd) > 0 or position('Authorization' in cmd) > 0 then
    raise exception 'scheduler secret FAILED: daily-fd-accrual still sends the legacy service-role key';
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

-- The scheduler secret: one reader, for the jobs and the two functions, and
-- nobody signed in. A login that could read it could run either job.
do $$
declare v text;
begin
  if not exists (
    select 1 from pg_proc
    where oid = 'public.get_scheduler_secret()'::regprocedure
      and prosecdef
      and proconfig @> array['search_path=""']
  ) then
    raise exception 'scheduler secret FAILED: get_scheduler_secret() is not SECURITY DEFINER with an empty search_path';
  end if;
  if has_function_privilege('anon', 'public.get_scheduler_secret()', 'execute')
     or has_function_privilege('authenticated', 'public.get_scheduler_secret()', 'execute')
     or not has_function_privilege('service_role', 'public.get_scheduler_secret()', 'execute') then
    raise exception 'scheduler secret FAILED: get_scheduler_secret() is callable by someone other than the service role';
  end if;

  -- Unset reads as null, which the functions refuse and the jobs send as an
  -- empty header.
  if get_scheduler_secret() is not null then
    raise exception 'scheduler secret FAILED: an unset secret read as %', get_scheduler_secret();
  end if;

  -- It reads this secret and no other: not the service-role key beside it.
  insert into vault.decrypted_secrets (name, decrypted_secret) values
    ('service_role_key', 'legacy-jwt'),
    ('scheduler_secret', repeat('ab', 32));
  v := get_scheduler_secret();
  if v is distinct from repeat('ab', 32) then
    raise exception 'scheduler secret FAILED: read % instead of the vault''s scheduler_secret', v;
  end if;
  delete from vault.decrypted_secrets where name in ('service_role_key', 'scheduler_secret');

  raise notice 'scheduler secret ok: only the service role reads it, and it reads the vault''s scheduler_secret';
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
  perform set_config('request.jwt.claim.aal', 'aal2', true);

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
       where p.oid = 'approve_intake(uuid, uuid, numeric, date, text, uuid, text, text, boolean, uuid, boolean, numeric, boolean)'::regprocedure
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

-- A holding's cost is its units at their average price, in its own currency,
-- converted the way its value is: AED as is, USD at the peg, INR at the
-- household's current rate. No rate, no AED cost. Without units, the cost is
-- what a person entered. A rate change moves rupee holdings' cost and value,
-- and is not a reprice.
do $$
declare
  h1 constant uuid := 'c0570000-0000-0000-0000-000000000001';
  h2 constant uuid := 'c0570000-0000-0000-0000-000000000002';
  h3 constant uuid := 'c0570000-0000-0000-0000-000000000003';
  h4 constant uuid := 'c0570000-0000-0000-0000-000000000004';
  hh constant uuid := '11111111-1111-1111-1111-111111111111';
  inv numeric;
  val numeric;
  priced timestamptz;
begin
  update households set inr_per_aed = 25 where id = hh;
  insert into holdings (id, household_id, name, asset_class, currency, quantity, avg_price, current_price, value_aed, invested_value_aed, priced_at) values
    (h1, hh, 'Rupee share', 'india_equity', 'INR', 10, 1000, 1100, 440, 999, '2026-10-01T10:00:00Z'),
    (h2, hh, 'Dollar share', 'us_equity', 'USD', 2, 100, 110, 807.95, 1, null),
    (h3, hh, 'Dirham fund', 'uae_equity', 'AED', 3, 50, null, 150, 1, null),
    (h4, hh, 'Manual fund', 'india_mf', 'INR', null, null, null, 500, 450, null);

  -- A typed-in cost is replaced where units and an average price exist.
  select invested_value_aed into inv from holdings where id = h1;
  if inv <> 400.00 then raise exception 'holding cost FAILED: rupee cost is %, expected 400.00 (10 x 1000 / 25)', inv; end if;
  select invested_value_aed into inv from holdings where id = h2;
  if inv <> 734.50 then raise exception 'holding cost FAILED: dollar cost is %, expected 734.50 (2 x 100 x 3.6725)', inv; end if;
  select invested_value_aed into inv from holdings where id = h3;
  if inv <> 150.00 then raise exception 'holding cost FAILED: dirham cost is %, expected 150.00', inv; end if;
  select invested_value_aed into inv from holdings where id = h4;
  if inv <> 450 then raise exception 'holding cost FAILED: a cost entered without units was overwritten (got %)', inv; end if;

  -- Buying more moves the cost with the units.
  update holdings set quantity = 12, avg_price = 1050 where id = h1;
  select invested_value_aed into inv from holdings where id = h1;
  if inv <> 504.00 then raise exception 'holding cost FAILED: after a purchase the cost is %, expected 504.00', inv; end if;

  -- The rate moves: cost and value follow it; priced_at does not.
  update households set inr_per_aed = 28 where id = hh;
  select invested_value_aed, value_aed, priced_at into inv, val, priced from holdings where id = h1;
  if inv <> 450.00 then raise exception 'holding cost FAILED: cost did not follow the rate (got %, expected 450.00)', inv; end if;
  if val <> 471.43 then raise exception 'holding cost FAILED: value did not follow the rate (got %, expected 471.43 = 12 x 1100 / 28)', val; end if;
  if priced is distinct from '2026-10-01T10:00:00Z'::timestamptz then
    raise exception 'holding cost FAILED: a rate change moved priced_at to %', priced;
  end if;
  select invested_value_aed into inv from holdings where id = h4;
  if inv <> 450 then raise exception 'holding cost FAILED: a rate change rewrote an entered cost (got %)', inv; end if;
  select invested_value_aed into inv from holdings where id = h2;
  if inv <> 734.50 then raise exception 'holding cost FAILED: a rupee rate change touched a dollar holding (got %)', inv; end if;

  -- No rate: the rupee cost is unknown, never 1:1, and the value is kept.
  update households set inr_per_aed = null where id = hh;
  select invested_value_aed, value_aed into inv, val from holdings where id = h1;
  if inv is not null then raise exception 'holding cost FAILED: with no rate the rupee cost is % instead of unknown', inv; end if;
  if val <> 471.43 then raise exception 'holding cost FAILED: clearing the rate changed the value to %', val; end if;

  update households set inr_per_aed = 26 where id = hh;
  delete from holdings where id in (h1, h2, h3, h4);
  raise notice 'holding cost ok: units x average price, at the peg or the current rate, unknown without one';
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

-- Balance history: every change to an entered balance is kept, with the
-- figure it replaced and where it came from. Fixed deposits, whose balance is
-- recomputed daily, are not.
insert into accounts (id, household_id, name, type, balance, is_shared)
values ('abcd0000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'History bank', 'checking', 1000, true),
       ('abcd0000-0000-4000-8000-000000000002', '11111111-1111-1111-1111-111111111111', 'History card', 'credit_card', 200, true);
insert into accounts (id, household_id, name, type, balance, is_shared, principal, interest_rate_pct, compounding, opened_date, maturity_date)
values ('abcd0000-0000-4000-8000-000000000003', '11111111-1111-1111-1111-111111111111', 'History deposit', 'fd', 0, true, 10000, 5, 'simple', date '2026-01-01', date '2027-01-01');
do $$
declare n int; e record;
begin
  select * into e from account_balance_events where account_id = 'abcd0000-0000-4000-8000-000000000001';
  if e.old_balance is not null or e.new_balance <> 1000 or e.source <> 'system' or e.member_id is not null then
    raise exception 'balance history FAILED: opening an account recorded %', row_to_json(e);
  end if;

  update accounts set balance = 1250.50, balance_as_of = '2026-10-01T08:00:00Z' where id = 'abcd0000-0000-4000-8000-000000000001';
  -- Not a balance change: nothing recorded.
  update accounts set name = 'History bank (renamed)' where id = 'abcd0000-0000-4000-8000-000000000001';
  update accounts set balance = 1250.50 where id = 'abcd0000-0000-4000-8000-000000000001';
  select count(*) into n from account_balance_events where account_id = 'abcd0000-0000-4000-8000-000000000001';
  if n <> 2 then raise exception 'balance history FAILED: % events for one opening and one change, expected 2', n; end if;
  select * into e from account_balance_events where account_id = 'abcd0000-0000-4000-8000-000000000001' order by id desc limit 1;
  if e.old_balance <> 1000 or e.new_balance <> 1250.50 or e.old_balance_as_of is not null
     or e.new_balance_as_of <> '2026-10-01T08:00:00Z'::timestamptz or e.source <> 'system' then
    raise exception 'balance history FAILED: a change was recorded as %', row_to_json(e);
  end if;

  update accounts set fd_status = 'active' where id = 'abcd0000-0000-4000-8000-000000000003';
  select count(*) into n from account_balance_events where account_id = 'abcd0000-0000-4000-8000-000000000003';
  if n <> 0 then raise exception 'balance history FAILED: a fixed deposit''s computed balance was recorded % times', n; end if;

  -- A signed-in member is the app, and is named.
  perform set_config('request.jwt.claim.sub', '0c000000-0000-4000-8000-00000000000c', true);
  insert into auth.users (id, email) values ('0c000000-0000-4000-8000-00000000000c', 'history@example.test');
  update household_members set user_id = '0c000000-0000-4000-8000-00000000000c' where id = '22222222-2222-2222-2222-222222222222';
  update accounts set balance = 1300 where id = 'abcd0000-0000-4000-8000-000000000001';
  select * into e from account_balance_events where account_id = 'abcd0000-0000-4000-8000-000000000001' order by id desc limit 1;
  if e.source <> 'app' or e.member_id is distinct from '22222222-2222-2222-2222-222222222222' then
    raise exception 'balance history FAILED: a member''s change was recorded as %', row_to_json(e);
  end if;
  update household_members set user_id = null where id = '22222222-2222-2222-2222-222222222222';
  perform set_config('request.jwt.claim.sub', '', true);

  -- Deleting an account takes its history with it: an account opened and
  -- changed once has two events, and none outlive it.
  delete from accounts where id = 'abcd0000-0000-4000-8000-000000000003';
  insert into accounts (id, household_id, name, type, balance, is_shared)
  values ('abcd0000-0000-4000-8000-000000000004', '11111111-1111-1111-1111-111111111111', 'Short-lived', 'checking', 10, true);
  update accounts set balance = 20 where id = 'abcd0000-0000-4000-8000-000000000004';
  select count(*) into n from account_balance_events where account_id = 'abcd0000-0000-4000-8000-000000000004';
  if n <> 2 then raise exception 'balance history FAILED: % events before the delete, expected 2', n; end if;
  delete from accounts where id = 'abcd0000-0000-4000-8000-000000000004';
  select count(*) into n from account_balance_events where account_id = 'abcd0000-0000-4000-8000-000000000004';
  if n <> 0 then raise exception 'balance history FAILED: % events outlived their account', n; end if;
  raise notice 'balance history ok: openings and changes recorded with their source, renames and deposits not';
end $$;

-- A proposal from the bot is applied once, only for its own member, only to
-- balances still at the figure the member was shown, and within its expiry.
insert into goals (id, household_id, name, target_amount)
values ('99999999-9999-9999-9999-99999999000d', '99999999-9999-9999-9999-999999999999', 'Their goal', 1000);
insert into bot_proposals (id, household_id, member_id, kind, payload, chat_id, source_ref)
values
  ('abcd0000-0000-4000-8000-0000000000a1', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'account_balances',
   jsonb_build_object('items', jsonb_build_array(
     jsonb_build_object('account_id', 'abcd0000-0000-4000-8000-000000000001', 'name', 'History bank', 'old_balance', 1300, 'new_balance', 1400),
     -- Shown as 150, but it is 200 now: changed since, so left alone.
     jsonb_build_object('account_id', 'abcd0000-0000-4000-8000-000000000002', 'name', 'History card', 'old_balance', 150, 'new_balance', 175),
     -- Another household's account, planted in the payload.
     jsonb_build_object('account_id', '99999999-9999-9999-9999-99999999000b', 'name', 'Other card', 'old_balance', 0, 'new_balance', 999)
   )), 1001, '9100001'),
  ('abcd0000-0000-4000-8000-0000000000a2', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'goal_contribution',
   jsonb_build_object('goal_id', '55555555-5555-5555-5555-555555550001', 'goal_name', 'House', 'amount', 750, 'occurred_at', '2026-10-02'), 1001, '9100002'),
  -- The same message the bot already recorded directly before proposals
  -- existed (source_ref 9000002, above).
  ('abcd0000-0000-4000-8000-0000000000a3', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'goal_contribution',
   jsonb_build_object('goal_id', '55555555-5555-5555-5555-555555550001', 'goal_name', 'House', 'amount', 500), 1001, '9000002'),
  -- A goal of another household.
  ('abcd0000-0000-4000-8000-0000000000a4', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'goal_contribution',
   jsonb_build_object('goal_id', '99999999-9999-9999-9999-99999999000d', 'amount', 10), 1001, null);
insert into bot_proposals (id, household_id, member_id, kind, payload, chat_id, created_at, expires_at)
values ('abcd0000-0000-4000-8000-0000000000a5', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'account_balances',
        jsonb_build_object('items', jsonb_build_array(jsonb_build_object('account_id', 'abcd0000-0000-4000-8000-000000000001', 'old_balance', 1400, 'new_balance', 1))),
        1001, now() - interval '2 days', now() - interval '1 day');
do $$
declare r jsonb; again jsonb; n int; e record; bal numeric;
begin
  r := apply_bot_proposal('abcd0000-0000-4000-8000-0000000000a1', '99999999-9999-9999-9999-99999999000a');
  if r ->> 'outcome' <> 'not_yours' then raise exception 'bot proposal FAILED: another member applied a proposal (%)', r; end if;
  if (select status from bot_proposals where id = 'abcd0000-0000-4000-8000-0000000000a1') <> 'proposed' then
    raise exception 'bot proposal FAILED: a refused confirmation changed the proposal';
  end if;

  r := apply_bot_proposal('abcd0000-0000-4000-8000-0000000000a1', '22222222-2222-2222-2222-222222222222');
  if r ->> 'outcome' <> 'applied' or jsonb_array_length(r -> 'applied') <> 1 or jsonb_array_length(r -> 'skipped') <> 2 then
    raise exception 'bot proposal FAILED: applying gave %', r;
  end if;
  select balance into bal from accounts where id = 'abcd0000-0000-4000-8000-000000000001';
  if bal <> 1400 then raise exception 'bot proposal FAILED: the balance is %, expected 1400', bal; end if;
  select balance into bal from accounts where id = 'abcd0000-0000-4000-8000-000000000002';
  if bal <> 200 then raise exception 'bot proposal FAILED: a balance changed since it was shown was overwritten (%)', bal; end if;
  select balance into bal from accounts where id = '99999999-9999-9999-9999-99999999000b';
  if bal <> 0 then raise exception 'bot proposal FAILED: another household''s account was changed (%)', bal; end if;
  if not exists (select 1 from jsonb_array_elements(r -> 'skipped') x where x ->> 'reason' = 'changed' and (x ->> 'balance')::numeric = 200) then
    raise exception 'bot proposal FAILED: the skipped item does not say what the balance is now (%)', r;
  end if;
  select * into e from account_balance_events where account_id = 'abcd0000-0000-4000-8000-000000000001' order by id desc limit 1;
  if e.source <> 'bot' or e.member_id is distinct from '22222222-2222-2222-2222-222222222222' or e.old_balance <> 1300 or e.new_balance <> 1400 then
    raise exception 'bot proposal FAILED: the change was recorded as %', row_to_json(e);
  end if;

  again := apply_bot_proposal('abcd0000-0000-4000-8000-0000000000a1', '22222222-2222-2222-2222-222222222222');
  if again ->> 'outcome' <> 'applied' or again -> 'result' -> 'applied' <> r -> 'applied' then
    raise exception 'bot proposal FAILED: a second yes did not repeat the first answer (%)', again;
  end if;
  select count(*) into n from account_balance_events where account_id = 'abcd0000-0000-4000-8000-000000000001' and source = 'bot';
  if n <> 1 then raise exception 'bot proposal FAILED: a second yes changed the balance again (% bot events)', n; end if;

  r := apply_bot_proposal('abcd0000-0000-4000-8000-0000000000a2', '22222222-2222-2222-2222-222222222222');
  select count(*) into n from goal_contributions where source_ref = '9100002' and amount = 750 and occurred_at = date '2026-10-02';
  if r ->> 'outcome' <> 'applied' or n <> 1 then raise exception 'bot proposal FAILED: a goal contribution gave % (% rows)', r, n; end if;
  perform apply_bot_proposal('abcd0000-0000-4000-8000-0000000000a2', '22222222-2222-2222-2222-222222222222');
  select count(*) into n from goal_contributions where source_ref = '9100002';
  if n <> 1 then raise exception 'bot proposal FAILED: a second yes recorded the contribution again'; end if;

  r := apply_bot_proposal('abcd0000-0000-4000-8000-0000000000a3', '22222222-2222-2222-2222-222222222222');
  select count(*) into n from goal_contributions where goal_id = '55555555-5555-5555-5555-555555550001' and source_ref = '9000002';
  if n <> 1 or (r -> 'applied' -> 0 ->> 'already_recorded')::boolean is not true then
    raise exception 'bot proposal FAILED: a message the bot had already recorded was recorded again (% rows, %)', n, r;
  end if;

  r := apply_bot_proposal('abcd0000-0000-4000-8000-0000000000a4', '22222222-2222-2222-2222-222222222222');
  if jsonb_array_length(r -> 'applied') <> 0 or jsonb_array_length(r -> 'skipped') <> 1 then
    raise exception 'bot proposal FAILED: a contribution to another household''s goal gave %', r;
  end if;

  r := apply_bot_proposal('abcd0000-0000-4000-8000-0000000000a5', '22222222-2222-2222-2222-222222222222');
  select balance into bal from accounts where id = 'abcd0000-0000-4000-8000-000000000001';
  if r ->> 'outcome' <> 'expired' or bal <> 1400
     or (select status from bot_proposals where id = 'abcd0000-0000-4000-8000-0000000000a5') <> 'expired' then
    raise exception 'bot proposal FAILED: an expired proposal gave % and left the balance at %', r, bal;
  end if;

  r := apply_bot_proposal('abcd0000-0000-4000-8000-0000000000ff', '22222222-2222-2222-2222-222222222222');
  if r ->> 'outcome' <> 'not_found' then raise exception 'bot proposal FAILED: an unknown proposal gave %', r; end if;

  -- A decided proposal records when; an open one does not.
  begin
    insert into bot_proposals (household_id, member_id, kind, payload, chat_id, status)
    values ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'goal_contribution', '{}', 1001, 'applied');
    raise exception 'bot proposal FAILED: a proposal was decided without a time';
  exception
    when check_violation then null;
  end;
  -- One proposal per Telegram update.
  begin
    insert into bot_proposals (household_id, member_id, kind, payload, chat_id, source_ref)
    values ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'goal_contribution', '{}', 1001, '9100002');
    raise exception 'bot proposal FAILED: one update proposed twice';
  exception
    when unique_violation then null;
  end;
  raise notice 'bot proposal ok: applied once, by its member, to unchanged balances in its household, until it expires';
end $$;

do $$
begin
  if not exists (
    select 1 from pg_proc
    where oid = 'public.apply_bot_proposal(uuid, uuid)'::regprocedure
      and prosecdef
      and proconfig @> array['search_path=""']
  ) then
    raise exception 'bot proposal FAILED: apply_bot_proposal() is not SECURITY DEFINER with an empty search_path';
  end if;
  if has_function_privilege('anon', 'public.apply_bot_proposal(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.apply_bot_proposal(uuid, uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.apply_bot_proposal(uuid, uuid)', 'execute') then
    raise exception 'bot proposal FAILED: apply_bot_proposal() is callable by someone other than the bot';
  end if;
  raise notice 'bot proposal ok: only service_role can apply a proposal';
end $$;

-- An autopay bill confirmed over Telegram is recorded once: one expense on the
-- bill's account and category, dated its due date, whoever confirms it, how
-- many times, or whether it was also logged another way.
do $$
declare
  hh constant uuid := '11111111-1111-1111-1111-111111111111';
  m1 constant uuid := '22222222-2222-2222-2222-222222222222';
  m2 constant uuid := 'a7000000-0000-4000-8000-000000000002';
  bank constant uuid := 'a7000000-0000-4000-8000-0000000000b1';
  cat constant uuid := 'a7000000-0000-4000-8000-0000000000c1';
  emi constant uuid := 'a7000000-0000-4000-8000-0000000000e1';
  r jsonb;
  n int;
  t transactions%rowtype;
begin
  insert into household_members (id, household_id, display_name) values (m2, hh, 'Partner');
  insert into accounts (id, household_id, name, type, balance, is_shared) values (bank, hh, 'Bank', 'checking', 10000, true);
  insert into categories (id, household_id, name, kind) values (cat, hh, 'Car EMI', 'expense');
  insert into recurring (id, household_id, name, account_id, category_id, is_shared, amount, cadence, next_due_date, autopay)
  values (emi, hh, 'Car EMI', bank, cat, true, -2000, 'monthly', '2026-10-03', true);

  -- The new kind is accepted; anything else still is not.
  begin
    insert into bot_proposals (household_id, member_id, kind, payload, chat_id) values (hh, m1, 'something_else', '{}', 1);
    raise exception 'autopay FAILED: an unknown proposal kind was accepted';
  exception when check_violation then null;
  end;

  -- The same question, asked of both members.
  insert into bot_proposals (id, household_id, member_id, kind, payload, chat_id, source_ref) values
    ('a7000000-0000-4000-8000-0000000000f1', hh, m1, 'autopay_payment',
     jsonb_build_object('recurring_id', emi, 'name', 'Car EMI', 'amount', 2000, 'due_date', '2026-10-03', 'next_due', '2026-11-03', 'asked_message_ids', '[11, 12]'::jsonb),
     1001, 'autopay:emi:2026-10-03:m1'),
    ('a7000000-0000-4000-8000-0000000000f2', hh, m2, 'autopay_payment',
     jsonb_build_object('recurring_id', emi, 'name', 'Car EMI', 'amount', 2000, 'due_date', '2026-10-03', 'next_due', '2026-11-03'),
     1002, 'autopay:emi:2026-10-03:m2');

  r := apply_bot_proposal('a7000000-0000-4000-8000-0000000000f1', m1);
  if r ->> 'outcome' <> 'applied' or (r -> 'applied' -> 0 ->> 'already_recorded')::boolean then
    raise exception 'autopay FAILED: confirming gave %', r;
  end if;
  select * into t from transactions where id = (r -> 'applied' -> 0 ->> 'transaction_id')::uuid;
  if t.amount <> -2000 or t.account_id <> bank or t.category_id <> cat or t.occurred_at <> '2026-10-03' or t.kind <> 'expense'
     or t.merchant <> 'Car EMI' or t.needs_review or not t.is_shared then
    raise exception 'autopay FAILED: recorded as %', row_to_json(t);
  end if;

  -- A second "yes" repeats the answer; the other member's question is closed.
  r := apply_bot_proposal('a7000000-0000-4000-8000-0000000000f1', m1);
  if r ->> 'outcome' <> 'applied' or r -> 'result' is null then raise exception 'autopay FAILED: a second yes gave %', r; end if;
  if (select status from bot_proposals where id = 'a7000000-0000-4000-8000-0000000000f2') <> 'expired' then
    raise exception 'autopay FAILED: the other member''s question stayed open';
  end if;
  r := apply_bot_proposal('a7000000-0000-4000-8000-0000000000f2', m2);
  if r ->> 'outcome' <> 'expired' then raise exception 'autopay FAILED: answering the closed question gave %', r; end if;
  select count(*) into n from transactions where account_id = bank and category_id = cat;
  if n <> 1 then raise exception 'autopay FAILED: % transactions for one bill', n; end if;

  -- Logged by hand for November (a pasted SMS): a "yes" records nothing more.
  insert into transactions (household_id, account_id, category_id, amount, occurred_at, is_shared, merchant)
  values (hh, bank, cat, -2010, '2026-11-04', true, 'BANK SMS');
  insert into bot_proposals (id, household_id, member_id, kind, payload, chat_id, source_ref) values
    ('a7000000-0000-4000-8000-0000000000f3', hh, m1, 'autopay_payment',
     jsonb_build_object('recurring_id', emi, 'name', 'Car EMI', 'amount', 2000, 'due_date', '2026-11-03'), 1001, 'autopay:emi:2026-11-03:m1');
  r := apply_bot_proposal('a7000000-0000-4000-8000-0000000000f3', m1);
  if not (r -> 'applied' -> 0 ->> 'already_recorded')::boolean then raise exception 'autopay FAILED: a logged bill was recorded again (%)', r; end if;
  select count(*) into n from transactions where account_id = bank and category_id = cat;
  if n <> 2 then raise exception 'autopay FAILED: % transactions after a logged month, expected 2', n; end if;

  -- An amount the member gave is the amount recorded.
  insert into bot_proposals (id, household_id, member_id, kind, payload, chat_id, source_ref) values
    ('a7000000-0000-4000-8000-0000000000f4', hh, m1, 'autopay_payment',
     jsonb_build_object('recurring_id', emi, 'name', 'Car EMI', 'amount', 2050, 'due_date', '2026-12-03'), 1001, 'autopay:emi:2026-12-03:m1');
  r := apply_bot_proposal('a7000000-0000-4000-8000-0000000000f4', m1);
  if (select amount from transactions where occurred_at = '2026-12-03' and account_id = bank) <> -2050 then
    raise exception 'autopay FAILED: the amount given was not the amount recorded (%)', r;
  end if;

  -- A bill with no account, or one from another household, records nothing.
  update recurring set account_id = null where id = emi;
  insert into bot_proposals (id, household_id, member_id, kind, payload, chat_id) values
    ('a7000000-0000-4000-8000-0000000000f5', hh, m1, 'autopay_payment', jsonb_build_object('recurring_id', emi, 'amount', 2000, 'due_date', '2027-01-03'), 1001),
    ('a7000000-0000-4000-8000-0000000000f6', hh, m1, 'autopay_payment', jsonb_build_object('recurring_id', gen_random_uuid(), 'amount', 2000, 'due_date', '2027-01-03'), 1001);
  r := apply_bot_proposal('a7000000-0000-4000-8000-0000000000f5', m1);
  if jsonb_array_length(r -> 'applied') <> 0 or r -> 'skipped' -> 0 ->> 'reason' <> 'unavailable' then raise exception 'autopay FAILED: a bill with no account gave %', r; end if;
  r := apply_bot_proposal('a7000000-0000-4000-8000-0000000000f6', m1);
  if jsonb_array_length(r -> 'applied') <> 0 then raise exception 'autopay FAILED: an unknown bill gave %', r; end if;
  select count(*) into n from transactions where category_id = cat;
  if n <> 3 then raise exception 'autopay FAILED: % transactions, expected 3', n; end if;

  delete from bot_proposals where id::text like 'a7000000-%';
  delete from transactions where category_id = cat;
  delete from recurring where id = emi;
  delete from categories where id = cat;
  delete from accounts where id = bank;
  delete from household_members where id = m2;
  raise notice 'autopay ok: a confirmed bill is recorded once, at the amount given, and never on top of one already logged';
end $$;

-- A card statement is recorded once, waits until it is closed with a time,
-- and its period cannot end before it starts. The statement question is on by
-- default. merchant_category_counts() groups a household's own expenses and
-- only the bot can call it.
do $$
declare
  hh constant uuid := '11111111-1111-1111-1111-111111111111';
  m1 constant uuid := '22222222-2222-2222-2222-222222222222';
  card constant uuid := 'a8000000-0000-4000-8000-0000000000c1';
  fuel constant uuid := 'a8000000-0000-4000-8000-0000000000f1';
  wash constant uuid := 'a8000000-0000-4000-8000-0000000000f2';
  enabled boolean;
  n int;
  r record;
begin
  insert into accounts (id, household_id, name, type, balance, is_shared, statement_day, due_day)
  values (card, hh, 'Bank card', 'credit_card', 0, true, 28, 22);

  insert into statement_reconciliations (household_id, account_id, statement_date, period_start, due_date)
  values (hh, card, '2026-09-28', '2026-08-29', '2026-10-22');
  if (select status from statement_reconciliations where account_id = card) <> 'waiting' then
    raise exception 'statements FAILED: a new statement is not waiting';
  end if;
  begin
    insert into statement_reconciliations (household_id, account_id, statement_date, period_start) values (hh, card, '2026-09-28', '2026-08-29');
    raise exception 'statements FAILED: the same statement was recorded twice';
  exception when unique_violation then null;
  end;
  begin
    insert into statement_reconciliations (household_id, account_id, statement_date, period_start) values (hh, card, '2026-08-28', '2026-09-01');
    raise exception 'statements FAILED: a period that ends before it starts was accepted';
  exception when check_violation then null;
  end;
  begin
    update statement_reconciliations set status = 'confirmed' where account_id = card;
    raise exception 'statements FAILED: a statement was closed without saying when';
  exception when check_violation then null;
  end;
  begin
    update statement_reconciliations set closed_at = now() where account_id = card;
    raise exception 'statements FAILED: a waiting statement carried a closing time';
  exception when check_violation then null;
  end;
  begin
    update statement_reconciliations set status = 'settled', closed_at = now() where account_id = card;
    raise exception 'statements FAILED: an unknown status was accepted';
  exception when check_violation then null;
  end;
  update statement_reconciliations set status = 'confirmed', closed_at = now(), closed_by_member_id = m1, asked_message_ids = '{11,12}' where account_id = card;
  if not exists (select 1 from statement_reconciliations where account_id = card and asked_message_ids @> '{12}') then
    raise exception 'statements FAILED: a question''s message id is not found by containment';
  end if;
  -- A question is found by its chat and message together, never by the
  -- message id alone: each chat numbers its own messages.
  update statement_reconciliations set asked_prompts = '[{"chat_id": 501, "message_id": 42, "member_id": "x"}]' where account_id = card;
  if not exists (select 1 from statement_reconciliations where account_id = card and asked_prompts @> '[{"chat_id": 501, "message_id": 42}]') then
    raise exception 'statements FAILED: a question is not found by its chat and message';
  end if;
  if exists (select 1 from statement_reconciliations where account_id = card and asked_prompts @> '[{"chat_id": 502, "message_id": 42}]') then
    raise exception 'statements FAILED: the same message id in another chat was taken for the question';
  end if;
  begin
    update statement_reconciliations set asked_prompts = '{"chat_id": 501}' where account_id = card;
    raise exception 'statements FAILED: asked_prompts accepted something other than a list';
  exception when check_violation then null;
  end;
  begin
    insert into statement_reconciliations (household_id, account_id, statement_date, period_start)
    values ('33333333-3333-3333-3333-333333333333', card, '2026-07-28', '2026-06-29');
    raise exception 'statements FAILED: a statement was filed under another household''s card';
  exception when foreign_key_violation then null;
  end;

  insert into telegram_notification_prefs (household_id) values (hh) on conflict (household_id) do nothing;
  select statement_enabled into enabled from telegram_notification_prefs where household_id = hh;
  if enabled is not true then raise exception 'statements FAILED: the statement question is not on by default'; end if;

  insert into categories (id, household_id, name, kind) values (fuel, hh, 'Fuel', 'expense'), (wash, hh, 'Car Wash', 'expense');
  insert into transactions (household_id, account_id, category_id, amount, occurred_at, is_shared, merchant, kind) values
    (hh, card, fuel, -100, '2026-01-01', true, 'EPPCO SITE 1077', 'expense'),
    (hh, card, fuel, -100, '2026-02-01', true, 'EPPCO SITE 1077', 'expense'),
    (hh, card, wash, -30, '2026-03-01', true, 'EPPCO SITE 1077', 'expense'),
    (hh, card, fuel, 20, '2026-03-02', true, 'EPPCO SITE 1077', 'refund'),
    (hh, card, null, -10, '2026-03-03', true, 'EPPCO SITE 1077', 'expense');
  select count(*) into n from merchant_category_counts(hh) where merchant = 'EPPCO SITE 1077';
  if n <> 2 then raise exception 'statements FAILED: % merchant/category pairs, expected 2', n; end if;
  select * into r from merchant_category_counts(hh) where category_id = fuel;
  if r.uses <> 2 or r.last_used <> '2026-02-01' then raise exception 'statements FAILED: fuel counted as % uses, last %', r.uses, r.last_used; end if;
  if has_function_privilege('authenticated', 'merchant_category_counts(uuid)', 'execute')
     or has_function_privilege('anon', 'merchant_category_counts(uuid)', 'execute') then
    raise exception 'statements FAILED: merchant_category_counts() is callable by someone other than the bot';
  end if;

  delete from transactions where account_id = card;
  delete from categories where id in (fuel, wash);
  delete from statement_reconciliations where account_id = card;
  delete from accounts where id = card;
  raise notice 'statements ok: one record per statement, closed with a time, asked by default; merchant history counted for the bot only';
end $$;

-- updated_at moves on every direct edit, including one that does not send it
-- (the transaction editor never did, SHR-307), and not when another trigger
-- re-values a row: a rupee bill following the rate was not edited.
do $$
declare
  hh constant uuid := '11111111-1111-1111-1111-111111111111';
  acct constant uuid := 'a9000000-0000-4000-8000-0000000000a1';
  tx constant uuid := 'a9000000-0000-4000-8000-0000000000b1';
  bill constant uuid := 'a9000000-0000-4000-8000-0000000000c1';
  backdated constant timestamptz := '2000-01-01T00:00:00Z';
  missing text;
  touched timestamptz;
begin
  select string_agg(c.table_name, ', ') into missing
  from information_schema.columns c
  where c.table_schema = 'public' and c.column_name = 'updated_at' and c.table_name <> 'accounts'
    and not exists (
      select 1 from information_schema.triggers t
      where t.event_object_schema = 'public' and t.event_object_table = c.table_name
        and t.action_statement = 'EXECUTE FUNCTION touch_updated_at()' and t.event_manipulation = 'UPDATE'
    );
  if missing is not null then
    raise exception 'updated_at FAILED: no touch_updated_at trigger on %', missing;
  end if;

  insert into accounts (id, household_id, name, type, balance, is_shared) values (acct, hh, 'Touch account', 'checking', 0, true);
  insert into transactions (id, household_id, account_id, amount, occurred_at, is_shared, kind) values (tx, hh, acct, -75, '2026-10-01', true, 'expense');
  insert into recurring (id, household_id, name, amount, currency, native_amount, cadence, next_due_date, is_shared)
  values (bill, hh, 'Rupee bill', -1, 'INR', -2500, 'monthly', '2026-11-01', true);

  -- now() is fixed for the whole transaction, so backdate the last edit (with
  -- triggers off) to be able to see whether a later write moves it.
  perform set_config('session_replication_role', 'replica', true);
  update transactions set updated_at = backdated where id = tx;
  update recurring set updated_at = backdated where id = bill;
  perform set_config('session_replication_role', 'origin', true);

  update transactions set note = 'edited' where id = tx;
  select updated_at into touched from transactions where id = tx;
  if touched <> now() then raise exception 'updated_at FAILED: an edit left a transaction at %', touched; end if;

  -- A writer that sends its own time is overruled: the database's clock decides.
  update transactions set updated_at = backdated, note = 'again' where id = tx;
  select updated_at into touched from transactions where id = tx;
  if touched <> now() then raise exception 'updated_at FAILED: a sent updated_at of % was kept', touched; end if;

  update households set inr_per_aed = 31 where id = hh;
  select updated_at into touched from recurring where id = bill;
  if touched <> backdated then raise exception 'updated_at FAILED: following the rupee rate moved a bill to %', touched; end if;
  update recurring set name = 'Rupee bill renamed' where id = bill;
  select updated_at into touched from recurring where id = bill;
  if touched <> now() then raise exception 'updated_at FAILED: renaming a bill left it at %', touched; end if;

  delete from recurring where id = bill;
  delete from transactions where id = tx;
  delete from accounts where id = acct;
  raise notice 'updated_at ok: every direct edit moves it, a trigger-side re-valuation does not';
end $$;

-- Every foreign key in public has an index whose leading columns are the
-- foreign key's own columns, in order, so removing a referenced row never
-- scans the referencing table. A partial index does not count: it cannot
-- serve every row the foreign key touches.
do $$
declare
  missing text;
begin
  select string_agg(format('%s.%s', c.conrelid::regclass, c.conname), ', ' order by 1) into missing
  from pg_constraint c
  where c.contype = 'f'
    and c.connamespace = 'public'::regnamespace
    and not exists (
      select 1 from pg_index i
      where i.indrelid = c.conrelid
        and i.indpred is null
        and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey
    );
  if missing is not null then
    raise exception 'fk indexes FAILED: no covering index for %', missing;
  end if;
  raise notice 'fk indexes ok: every public foreign key has a covering index';
end $$;

-- A backup record names what was done and how it went, and nothing else.
do $$
declare
  hh constant uuid := '11111111-1111-1111-1111-111111111111';
begin
  insert into backup_records (household_id, kind, result, done_on) values (hh, 'export', 'passed', '2026-10-01');
  begin
    insert into backup_records (household_id, kind, result, done_on) values (hh, 'snapshot', 'passed', '2026-10-01');
    raise exception 'backups FAILED: an unknown kind was recorded';
  exception when check_violation then null;
  end;
  begin
    insert into backup_records (household_id, kind, result, done_on) values (hh, 'export', 'maybe', '2026-10-01');
    raise exception 'backups FAILED: an unknown result was recorded';
  exception when check_violation then null;
  end;
  begin
    insert into backup_records (household_id, kind, result, done_on, note) values (hh, 'export', 'passed', '2026-10-01', repeat('x', 2001));
    raise exception 'backups FAILED: an oversized note was recorded';
  exception when check_violation then null;
  end;
  begin
    insert into backup_records (household_id, kind, result) values (hh, 'export', 'passed');
    raise exception 'backups FAILED: a record without a day was accepted';
  exception when not_null_violation then null;
  end;
  if has_function_privilege('authenticated', 'set_backup_record_author()', 'execute') then
    raise exception 'backups FAILED: the author trigger function is callable through the API';
  end if;
  delete from backup_records where household_id = hh;
  raise notice 'backups ok: kind, result, day and note size are enforced';
end $$;


-- The second-step rule is part of both membership helpers, runs with the
-- definer's rights (to read auth.mfa_factors), and is closed to anon.
do $$
begin
  if pg_get_functiondef('private.is_household_member(uuid)'::regprocedure) not like '%private.mfa_satisfied()%'
     or pg_get_functiondef('private.is_household_owner(uuid)'::regprocedure) not like '%private.mfa_satisfied()%' then
    raise exception 'two-step FAILED: a membership helper does not check the second step';
  end if;
  if not (select prosecdef from pg_proc where oid = 'private.mfa_satisfied()'::regprocedure) then
    raise exception 'two-step FAILED: mfa_satisfied() cannot read auth.mfa_factors as its caller';
  end if;
  if has_function_privilege('anon', 'private.mfa_satisfied()', 'execute') then
    raise exception 'two-step FAILED: anon can call mfa_satisfied()';
  end if;
  raise notice 'two-step ok: both membership helpers check the second step';
end $$;

-- Transfers: two sides, one link, the same amount out of one account and into
-- another. The rules are checked at commit; `set constraints all immediate`
-- runs them now, so each case can be tested inside this transaction.
do $$
declare
  hh constant uuid := '11111111-1111-1111-1111-111111111111';
  card constant uuid := '33333333-3333-3333-3333-333333333333';
  savings constant uuid := '33333333-3333-3333-3333-33333333aaaa';
  made jsonb;
  link uuid;
  out_id uuid;
  in_id uuid;
  n int;
begin
  insert into accounts (id, household_id, name, type, balance, is_shared) values (savings, hh, 'Test savings', 'savings', 0, true);

  made := record_transfer(hh, savings, card, 250, date '2026-10-01', 'Card payment');
  link := (made ->> 'link_id')::uuid;
  out_id := (made ->> 'from_transaction_id')::uuid;
  in_id := (made ->> 'to_transaction_id')::uuid;
  set constraints all immediate;
  set constraints all deferred;
  select count(*) into n from transactions where id in (out_id, in_id) and kind = 'transfer';
  if n <> 2 or (select amount from transactions where id = out_id) <> -250 or (select amount from transactions where id = in_id) <> 250 then
    raise exception 'transfers FAILED: record_transfer did not write -250 out and +250 in';
  end if;

  -- One side changed on its own breaks the pair.
  begin
    update transactions set amount = -240 where id = out_id;
    set constraints all immediate;
    raise exception 'transfers FAILED: the sides were allowed to differ';
  exception when check_violation then null;
  end;
  set constraints all deferred;
  begin
    update transactions set kind = 'expense' where id = out_id;
    set constraints all immediate;
    raise exception 'transfers FAILED: one side stopped being a transfer while linked';
  exception when check_violation then null;
  end;
  set constraints all deferred;
  begin
    delete from transactions where id = in_id;
    set constraints all immediate;
    raise exception 'transfers FAILED: one side was deleted and the other kept';
  exception when check_violation then null;
  end;
  set constraints all deferred;

  -- Both sides together.
  perform update_transfer(link, 300, date '2026-10-02', 'Card payment, corrected');
  set constraints all immediate;
  set constraints all deferred;
  if (select amount from transactions where id = in_id) <> 300 or (select occurred_at from transactions where id = out_id) <> date '2026-10-02' then
    raise exception 'transfers FAILED: update_transfer did not change both sides';
  end if;

  -- Unlinked: an expense out and income in, each with the change in its history.
  perform unlink_transfer(link);
  set constraints all immediate;
  set constraints all deferred;
  if (select kind from transactions where id = out_id) <> 'expense' or (select kind from transactions where id = in_id) <> 'income'
     or exists (select 1 from transaction_links where id = link) then
    raise exception 'transfers FAILED: unlink_transfer did not leave an expense and an income';
  end if;
  select count(*) into n from transaction_edits where transaction_id in (out_id, in_id) and field = 'kind' and old_value = 'Transfer';
  if n <> 2 then raise exception 'transfers FAILED: unlinking was not recorded in the edit history'; end if;

  -- And linked again.
  link := (link_transfer(out_id, in_id) ->> 'link_id')::uuid;
  set constraints all immediate;
  set constraints all deferred;

  -- A pair that doesn't balance, or sits on one account, can't be linked.
  insert into transactions (id, household_id, account_id, amount, occurred_at, is_shared)
  values ('44444444-4444-4444-4444-4444444444a1', hh, card, -80, '2026-10-03', true),
         ('44444444-4444-4444-4444-4444444444a2', hh, savings, 75, '2026-10-03', true),
         ('44444444-4444-4444-4444-4444444444a3', hh, card, 80, '2026-10-03', true);
  begin
    perform link_transfer('44444444-4444-4444-4444-4444444444a1', '44444444-4444-4444-4444-4444444444a2');
    set constraints all immediate;
    raise exception 'transfers FAILED: 80 out and 75 in were linked';
  exception when check_violation then null;
  end;
  set constraints all deferred;
  begin
    perform link_transfer('44444444-4444-4444-4444-4444444444a1', '44444444-4444-4444-4444-4444444444a3');
    set constraints all immediate;
    raise exception 'transfers FAILED: two records on one account were linked';
  exception when check_violation then null;
  end;
  set constraints all deferred;
  begin
    perform record_transfer(hh, card, card, 10, date '2026-10-03');
    raise exception 'transfers FAILED: a transfer from an account to itself was recorded';
  exception when invalid_parameter_value then null;
  end;

  -- Deleting the transfer takes both sides and the link.
  perform delete_transfer(link);
  set constraints all immediate;
  set constraints all deferred;
  if exists (select 1 from transactions where id in (out_id, in_id)) or exists (select 1 from transaction_links where id = link) then
    raise exception 'transfers FAILED: delete_transfer left something behind';
  end if;

  if has_function_privilege('authenticated', 'check_transfer(uuid)', 'execute')
     or has_function_privilege('authenticated', 'set_transaction_link_author()', 'execute')
     or has_function_privilege('anon', 'record_transfer(uuid, uuid, uuid, numeric, date, text, boolean, uuid)', 'execute') then
    raise exception 'transfers FAILED: an internal function is callable through the API';
  end if;

  delete from transactions where id in ('44444444-4444-4444-4444-4444444444a1', '44444444-4444-4444-4444-4444444444a2', '44444444-4444-4444-4444-4444444444a3');
  delete from accounts where id = savings;
  raise notice 'transfers ok: both sides, one link, equal amounts on two accounts, kept together through edit, unlink and delete';
end $$;


-- Splits: one transaction, several categories, lines that add up to it. The
-- rules run at commit; `set constraints all immediate` runs them now.
do $$
declare
  hh constant uuid := '11111111-1111-1111-1111-111111111111';
  card constant uuid := '33333333-3333-3333-3333-333333333333';
  tx constant uuid := '44444444-4444-4444-4444-4444444444b1';
  groceries constant uuid := '66666666-6666-6666-6666-6666666666b1';
  household constant uuid := '66666666-6666-6666-6666-6666666666b2';
  n int;
  total numeric;
  made jsonb;
begin
  insert into categories (id, household_id, name, kind) values (groceries, hh, 'Split groceries', 'expense'), (household, hh, 'Split household', 'expense');
  insert into transactions (id, household_id, account_id, amount, kind, category_id, occurred_at, is_shared)
  values (tx, hh, card, -500, 'expense', groceries, '2026-10-05', true);

  perform split_transaction(tx, jsonb_build_array(jsonb_build_object('category_id', groceries, 'amount', 400), jsonb_build_object('category_id', household, 'amount', 100)));
  set constraints all immediate;
  set constraints all deferred;
  select count(*), sum(amount) into n, total from transaction_splits where transaction_id = tx;
  if n <> 2 or total <> -500 or (select category_id from transactions where id = tx) is not null or not (select is_split from transactions where id = tx) then
    raise exception 'splits FAILED: split_transaction did not leave two lines of -400 and -100 on an uncategorised split';
  end if;

  -- The lines must add up.
  begin
    update transaction_splits set amount = -390 where transaction_id = tx and category_id = groceries;
    set constraints all immediate;
    raise exception 'splits FAILED: lines that no longer add up were kept';
  exception when check_violation then null;
  end;
  set constraints all deferred;
  begin
    update transactions set amount = -520 where id = tx;
    set constraints all immediate;
    raise exception 'splits FAILED: the total changed without its lines';
  exception when check_violation then null;
  end;
  set constraints all deferred;
  begin
    update transactions set category_id = groceries where id = tx;
    set constraints all immediate;
    raise exception 'splits FAILED: a split transaction took a category of its own';
  exception when check_violation then null;
  end;
  set constraints all deferred;
  begin
    perform split_transaction(tx, jsonb_build_array(jsonb_build_object('category_id', groceries, 'amount', 500)));
    raise exception 'splits FAILED: a one-line split was accepted';
  exception when invalid_parameter_value then null;
  end;

  -- The total and its lines change together.
  perform split_transaction(tx, jsonb_build_array(jsonb_build_object('category_id', groceries, 'amount', 420), jsonb_build_object('category_id', household, 'amount', 100)), 520);
  set constraints all immediate;
  set constraints all deferred;
  if (select amount from transactions where id = tx) <> -520 then raise exception 'splits FAILED: the new total was not saved'; end if;

  -- And back to one category, with the change in the history.
  perform unsplit_transaction(tx, household);
  set constraints all immediate;
  set constraints all deferred;
  if exists (select 1 from transaction_splits where transaction_id = tx) or (select is_split from transactions where id = tx)
     or (select category_id from transactions where id = tx) <> household then
    raise exception 'splits FAILED: unsplit_transaction did not leave one category';
  end if;
  select count(*) into n from transaction_edits where transaction_id = tx and field = 'category' and (new_value like 'Split:%' or old_value like 'Split:%');
  if n < 2 then raise exception 'splits FAILED: splitting and unsplitting were not in the edit history (% rows)', n; end if;

  -- A transfer has no category, so it is never split.
  insert into accounts (id, household_id, name, type, balance, is_shared) values ('33333333-3333-3333-3333-33333333bbbb', hh, 'Split test savings', 'savings', 0, true);
  made := record_transfer(hh, '33333333-3333-3333-3333-33333333bbbb', card, 50, date '2026-10-06');
  begin
    perform split_transaction((made ->> 'from_transaction_id')::uuid, jsonb_build_array(jsonb_build_object('category_id', groceries, 'amount', 30), jsonb_build_object('category_id', household, 'amount', 20)));
    raise exception 'splits FAILED: a transfer was split';
  exception when invalid_parameter_value then null;
  end;
  perform delete_transfer((made ->> 'link_id')::uuid);
  set constraints all immediate;
  set constraints all deferred;
  delete from accounts where id = '33333333-3333-3333-3333-33333333bbbb';

  if has_function_privilege('authenticated', 'check_split(uuid)', 'execute')
     or has_function_privilege('anon', 'split_transaction(uuid, jsonb, numeric)', 'execute') then
    raise exception 'splits FAILED: an internal function is callable through the API';
  end if;

  delete from transactions where id = tx;
  delete from categories where id in (groceries, household);
  raise notice 'splits ok: lines add up, same direction, no category of its own, never a transfer, kept together through edit and unsplit';
end $$;



-- Refund links: a refund joined to the purchase it returns, taking its
-- category; the rules run at commit.
do $$
declare
  hh constant uuid := '11111111-1111-1111-1111-111111111111';
  card constant uuid := '33333333-3333-3333-3333-333333333333';
  purchase constant uuid := '44444444-4444-4444-4444-4444444444c1';
  refund constant uuid := '44444444-4444-4444-4444-4444444444c2';
  second constant uuid := '44444444-4444-4444-4444-4444444444c3';
  receipt constant uuid := '44444444-4444-4444-4444-4444444444c4';
  back constant uuid := '44444444-4444-4444-4444-4444444444c5';
  groceries constant uuid := '66666666-6666-6666-6666-6666666666c1';
  household constant uuid := '66666666-6666-6666-6666-6666666666c2';
  link uuid;
  n int;
begin
  insert into categories (id, household_id, name, kind) values (groceries, hh, 'Refund groceries', 'expense'), (household, hh, 'Refund household', 'expense');
  insert into transactions (id, household_id, account_id, amount, kind, category_id, merchant, occurred_at, is_shared) values
    (purchase, hh, card, -200, 'expense', groceries, 'Shop', '2026-09-20', true),
    (refund, hh, card, 50, 'refund', null, 'Shop', '2026-10-02', true),
    (second, hh, card, 165, 'refund', null, 'Shop', '2026-10-03', true);

  -- Linked, the refund takes the purchase's category, with both in its history.
  link := (link_refund(purchase, refund) ->> 'link_id')::uuid;
  set constraints all immediate;
  set constraints all deferred;
  if (select category_id from transactions where id = refund) is distinct from groceries then
    raise exception 'refund links FAILED: the refund did not take the purchase''s category';
  end if;
  select count(*) into n from transaction_edits where transaction_id = refund and field in ('refund_for', 'category');
  if n <> 2 then raise exception 'refund links FAILED: linking was not in the refund''s history (% rows)', n; end if;

  -- More back than was paid (beyond 5% for exchange rates) is refused.
  begin
    perform link_refund(purchase, second);
    set constraints all immediate;
    raise exception 'refund links FAILED: refunds of 215 were linked to a purchase of 200';
  exception when check_violation then null;
  end;
  set constraints all deferred;
  update transactions set amount = 155 where id = second;
  perform link_refund(purchase, second);
  set constraints all immediate;
  set constraints all deferred;

  -- One purchase per refund, a refund never before its purchase, and neither
  -- changes kind while linked.
  begin
    insert into transactions (id, household_id, account_id, amount, kind, occurred_at, is_shared) values ('44444444-4444-4444-4444-4444444444c6', hh, card, -10, 'expense', '2026-09-01', true);
    perform link_refund('44444444-4444-4444-4444-4444444444c6', refund);
    raise exception 'refund links FAILED: one refund was linked to two purchases';
  exception when unique_violation then null;
  end;
  begin
    update transactions set occurred_at = '2026-09-19' where id = refund;
    set constraints all immediate;
    raise exception 'refund links FAILED: a refund was dated before its purchase';
  exception when check_violation then null;
  end;
  set constraints all deferred;
  begin
    update transactions set kind = 'income' where id = refund;
    set constraints all immediate;
    raise exception 'refund links FAILED: a linked refund became income';
  exception when check_violation then null;
  end;
  set constraints all deferred;
  begin
    update transactions set amount = -100 where id = purchase;
    set constraints all immediate;
    raise exception 'refund links FAILED: a purchase was cut below what was refunded on it';
  exception when check_violation then null;
  end;
  set constraints all deferred;
  begin
    perform link_refund(refund, second);
    raise exception 'refund links FAILED: a refund was linked to another refund';
  exception when invalid_parameter_value then null;
  end;

  -- Unlinked, the refund keeps its category; deleting the purchase takes the link.
  perform unlink_refund(link);
  set constraints all immediate;
  set constraints all deferred;
  if exists (select 1 from transaction_links where id = link) or (select category_id from transactions where id = refund) is distinct from groceries then
    raise exception 'refund links FAILED: unlinking did not leave the refund as it was';
  end if;
  delete from transactions where id = purchase;
  set constraints all immediate;
  set constraints all deferred;
  if exists (select 1 from transaction_links where to_transaction_id = second) then
    raise exception 'refund links FAILED: a deleted purchase left its link';
  end if;

  -- A refund of a split purchase is shared out in proportion, adding up to the cent.
  insert into transactions (id, household_id, account_id, amount, kind, category_id, occurred_at, is_shared) values
    (receipt, hh, card, -300, 'expense', null, '2026-09-20', true),
    (back, hh, card, 100, 'refund', null, '2026-10-02', true);
  perform split_transaction(receipt, jsonb_build_array(jsonb_build_object('category_id', groceries, 'amount', 200), jsonb_build_object('category_id', household, 'amount', 100)));
  perform link_refund(receipt, back);
  set constraints all immediate;
  set constraints all deferred;
  if not (select is_split from transactions where id = back)
     or (select amount from transaction_splits where transaction_id = back and category_id = groceries) <> 66.67
     or (select amount from transaction_splits where transaction_id = back and category_id = household) <> 33.33 then
    raise exception 'refund links FAILED: a refund of a split purchase was not shared out 66.67 / 33.33';
  end if;

  if has_function_privilege('authenticated', 'check_refund(uuid)', 'execute')
     or has_function_privilege('anon', 'link_refund(uuid, uuid)', 'execute') then
    raise exception 'refund links FAILED: an internal function is callable through the API';
  end if;

  delete from transactions where id in (refund, second, receipt, back, '44444444-4444-4444-4444-4444444444c6');
  delete from categories where id in (groceries, household);
  raise notice 'refund links ok: an expense to a refund, one purchase each, never more back than paid, the category followed and shared out';
end $$;


-- Transfers from the bot: recorded on a yes as both sides and a link, once,
-- joining a side already in the ledger rather than copying it.
do $$
declare
  hh constant uuid := '11111111-1111-1111-1111-111111111111';
  member constant uuid := '22222222-2222-2222-2222-222222222222';
  bank constant uuid := '33333333-3333-3333-3333-3333333333d1';
  card constant uuid := '33333333-3333-3333-3333-3333333333d2';
  paid constant uuid := '44444444-4444-4444-4444-4444444444d1';
  r jsonb;
  n int;
begin
  insert into accounts (id, household_id, name, type, balance, is_shared) values
    (bank, hh, 'Bot transfer bank', 'checking', 0, true),
    (card, hh, 'Bot transfer card', 'credit_card', 0, true);
  insert into bot_proposals (id, household_id, member_id, kind, payload, chat_id, source_ref) values
    ('abcd0000-0000-4000-8000-0000000000d1', hh, member, 'transfer',
     jsonb_build_object('from_account_id', bank, 'to_account_id', card, 'amount', 300, 'occurred_at', '2026-10-10'), 1001, '9200001'),
    ('abcd0000-0000-4000-8000-0000000000d2', hh, member, 'transfer',
     jsonb_build_object('from_account_id', bank, 'to_account_id', card, 'amount', 300, 'occurred_at', '2026-10-11'), 1001, '9200002'),
    ('abcd0000-0000-4000-8000-0000000000d3', hh, member, 'transfer',
     jsonb_build_object('from_account_id', bank, 'to_account_id', card, 'amount', 450, 'occurred_at', '2026-10-13'), 1001, '9200003'),
    ('abcd0000-0000-4000-8000-0000000000d4', hh, member, 'transfer',
     jsonb_build_object('from_account_id', bank, 'to_account_id', '99999999-9999-9999-9999-99999999000b', 'amount', 10, 'occurred_at', '2026-10-13'), 1001, '9200004');

  -- Both sides and the link, checked at commit like any transfer.
  r := apply_bot_proposal('abcd0000-0000-4000-8000-0000000000d1', member);
  set constraints all immediate;
  set constraints all deferred;
  select count(*) into n from transactions where account_id in (bank, card) and kind = 'transfer' and abs(amount) = 300;
  if r ->> 'outcome' <> 'applied' or n <> 2 or not exists (
       select 1 from transaction_links l join transactions o on o.id = l.from_transaction_id
       where l.kind = 'transfer' and o.account_id = bank and o.amount = -300) then
    raise exception 'bot transfers FAILED: a confirmed transfer was not recorded as two sides and a link (%)', r;
  end if;

  -- The same transfer again, a day later, is recognised rather than doubled.
  r := apply_bot_proposal('abcd0000-0000-4000-8000-0000000000d2', member);
  select count(*) into n from transactions where account_id in (bank, card) and abs(amount) = 300;
  if n <> 2 or not (r -> 'applied' -> 0 ->> 'already_recorded')::boolean then
    raise exception 'bot transfers FAILED: a transfer already recorded was recorded again (%)', r;
  end if;

  -- The payment already pasted as an expense becomes the money-out side.
  insert into transactions (id, household_id, account_id, amount, kind, merchant, occurred_at, is_shared)
  values (paid, hh, bank, -450, 'expense', 'Card payment', '2026-10-12', true);
  r := apply_bot_proposal('abcd0000-0000-4000-8000-0000000000d3', member);
  set constraints all immediate;
  set constraints all deferred;
  select count(*) into n from transactions where account_id = bank and abs(amount) = 450;
  if (select kind from transactions where id = paid) <> 'transfer' or n <> 1
     or not (r -> 'applied' -> 0 ->> 'joined_out')::boolean
     or not exists (select 1 from transaction_links where kind = 'transfer' and from_transaction_id = paid)
     or not exists (select 1 from transaction_edits where transaction_id = paid and field = 'kind' and new_value = 'Transfer') then
    raise exception 'bot transfers FAILED: the expense already recorded was not joined as the money-out side (%)', r;
  end if;

  -- Another household's account, planted in the payload, records nothing.
  r := apply_bot_proposal('abcd0000-0000-4000-8000-0000000000d4', member);
  if jsonb_array_length(r -> 'skipped') <> 1 or exists (select 1 from transactions where account_id = bank and amount = -10) then
    raise exception 'bot transfers FAILED: a transfer to another household''s account was recorded (%)', r;
  end if;

  delete from transactions where account_id in (bank, card);
  delete from bot_proposals where id::text like 'abcd0000-0000-4000-8000-0000000000d%';
  set constraints all immediate;
  set constraints all deferred;
  delete from accounts where id in (bank, card);
  raise notice 'bot transfers ok: both sides and a link on a yes, never twice, a side already recorded joined, own household only';
end $$;


-- A linked refund keeps its purchase's rules through later edits (QA
-- re-review, 17 October): the cap holds when the refund is edited, and its
-- categories follow the purchase's.
do $$
declare
  hh constant uuid := '11111111-1111-1111-1111-111111111111';
  card constant uuid := '33333333-3333-3333-3333-333333333333';
  purchase constant uuid := '44444444-4444-4444-4444-4444444444f1';
  refund constant uuid := '44444444-4444-4444-4444-4444444444f2';
  first_cat constant uuid := '66666666-6666-6666-6666-6666666666f1';
  second_cat constant uuid := '66666666-6666-6666-6666-6666666666f2';
begin
  insert into categories (id, household_id, name, kind) values (first_cat, hh, 'Integrity first', 'expense'), (second_cat, hh, 'Integrity second', 'expense');
  insert into transactions (id, household_id, account_id, amount, kind, category_id, occurred_at, is_shared) values
    (purchase, hh, card, -100, 'expense', first_cat, '2026-09-01', true),
    (refund, hh, card, 20, 'refund', null, '2026-09-10', true);
  perform link_refund(purchase, refund);
  set constraints all immediate;
  set constraints all deferred;

  -- Editing the refund past the cap is refused, as linking past it is.
  begin
    update transactions set amount = 200 where id = refund;
    set constraints all immediate;
    raise exception 'refund integrity FAILED: a linked refund was edited to 200 on a purchase of 100';
  exception when check_violation then null;
  end;
  set constraints all deferred;

  -- Filing the refund elsewhere on its own is refused.
  begin
    update transactions set category_id = second_cat where id = refund;
    set constraints all immediate;
    raise exception 'refund integrity FAILED: a linked refund was moved to another category';
  exception when check_violation then null;
  end;
  set constraints all deferred;

  -- Recategorising the purchase moves its refund with it, in the history.
  update transactions set category_id = second_cat where id = purchase;
  set constraints all immediate;
  set constraints all deferred;
  if (select category_id from transactions where id = refund) is distinct from second_cat then
    raise exception 'refund integrity FAILED: the refund did not follow its purchase to the new category';
  end if;
  if not exists (select 1 from transaction_edits where transaction_id = refund and field = 'category' and new_value like '%follows the purchase%') then
    raise exception 'refund integrity FAILED: following the purchase was not in the refund''s history';
  end if;

  -- Splitting the purchase shares the refund out; changing the refund's
  -- amount shares it out again, adding up to the cent.
  perform split_transaction(purchase, jsonb_build_array(jsonb_build_object('category_id', first_cat, 'amount', 75), jsonb_build_object('category_id', second_cat, 'amount', 25)));
  set constraints all immediate;
  set constraints all deferred;
  if not (select is_split from transactions where id = refund)
     or (select amount from transaction_splits where transaction_id = refund and category_id = first_cat) <> 15
     or (select amount from transaction_splits where transaction_id = refund and category_id = second_cat) <> 5 then
    raise exception 'refund integrity FAILED: the refund of a split purchase was not shared out 15 / 5';
  end if;
  update transactions set amount = 30 where id = refund;
  set constraints all immediate;
  set constraints all deferred;
  if (select sum(amount) from transaction_splits where transaction_id = refund) <> 30
     or (select amount from transaction_splits where transaction_id = refund and category_id = first_cat) <> 22.5 then
    raise exception 'refund integrity FAILED: a changed refund amount was not shared out again';
  end if;

  -- Back to one category: the refund follows again.
  perform unsplit_transaction(purchase, first_cat);
  set constraints all immediate;
  set constraints all deferred;
  if (select is_split from transactions where id = refund) or (select category_id from transactions where id = refund) is distinct from first_cat then
    raise exception 'refund integrity FAILED: the refund did not follow its purchase back to one category';
  end if;

  delete from transactions where id in (purchase, refund);
  delete from categories where id in (first_cat, second_cat);
  raise notice 'refund integrity ok: the cap holds through edits, and a linked refund follows its purchase''s categories';
end $$;

-- A linked refund's lines match its purchase's to the cent (QA re-check, 17
-- October): re-splitting the refund itself at the same total, or unsplitting
-- it into one of the purchase's categories, is refused; re-splitting the
-- purchase still moves the refund with it.
do $$
declare
  hh constant uuid := '11111111-1111-1111-1111-111111111111';
  card constant uuid := '33333333-3333-3333-3333-333333333333';
  purchase constant uuid := '44444444-4444-4444-4444-4444444444f3';
  refund constant uuid := '44444444-4444-4444-4444-4444444444f4';
  first_cat constant uuid := '66666666-6666-6666-6666-6666666666f3';
  second_cat constant uuid := '66666666-6666-6666-6666-6666666666f4';
begin
  insert into categories (id, household_id, name, kind) values (first_cat, hh, 'Allocation first', 'expense'), (second_cat, hh, 'Allocation second', 'expense');
  insert into transactions (id, household_id, account_id, amount, kind, category_id, occurred_at, is_shared) values
    (purchase, hh, card, -100, 'expense', first_cat, '2026-09-01', true),
    (refund, hh, card, 20, 'refund', null, '2026-09-10', true);
  perform split_transaction(purchase, jsonb_build_array(jsonb_build_object('category_id', first_cat, 'amount', 75), jsonb_build_object('category_id', second_cat, 'amount', 25)));
  perform link_refund(purchase, refund);
  set constraints all immediate;
  set constraints all deferred;

  -- The reviewer's case: 15 / 5 redistributed as 5 / 15.
  begin
    perform split_transaction(refund, jsonb_build_array(jsonb_build_object('category_id', first_cat, 'amount', 5), jsonb_build_object('category_id', second_cat, 'amount', 15)));
    set constraints all immediate;
    raise exception 'refund allocation FAILED: a linked refund was re-split 5 / 15 against a 75 / 25 purchase';
  exception when check_violation then null;
  end;
  set constraints all deferred;

  -- All of it into one of the purchase's categories.
  begin
    perform unsplit_transaction(refund, first_cat);
    set constraints all immediate;
    raise exception 'refund allocation FAILED: a linked refund of a split purchase was filed under one of its categories';
  exception when check_violation then null;
  end;
  set constraints all deferred;

  -- One line's amount changed by hand.
  begin
    update transaction_splits set amount = 16 where transaction_id = refund and category_id = first_cat;
    update transaction_splits set amount = 4 where transaction_id = refund and category_id = second_cat;
    set constraints all immediate;
    raise exception 'refund allocation FAILED: a linked refund''s lines were changed by hand';
  exception when check_violation then null;
  end;
  set constraints all deferred;

  -- Re-splitting the purchase still takes the refund with it.
  perform split_transaction(purchase, jsonb_build_array(jsonb_build_object('category_id', first_cat, 'amount', 50), jsonb_build_object('category_id', second_cat, 'amount', 50)));
  set constraints all immediate;
  set constraints all deferred;
  if (select amount from transaction_splits where transaction_id = refund and category_id = first_cat) <> 10
     or (select amount from transaction_splits where transaction_id = refund and category_id = second_cat) <> 10 then
    raise exception 'refund allocation FAILED: the refund did not follow its purchase to 50 / 50';
  end if;

  -- Unlinked, it can be filed any way.
  delete from transaction_links where kind = 'refund' and to_transaction_id = refund;
  perform split_transaction(refund, jsonb_build_array(jsonb_build_object('category_id', first_cat, 'amount', 5), jsonb_build_object('category_id', second_cat, 'amount', 15)));
  set constraints all immediate;
  set constraints all deferred;

  delete from transactions where id in (purchase, refund);
  delete from categories where id in (first_cat, second_cat);
  raise notice 'refund allocation ok: a linked refund''s lines match its purchase''s share to the cent, and follow it when it changes';
end $$;

-- Planning value ranges: the assumptions and a debt's terms stay within what
-- a plan can use, and 0 stays allowed where it is a real answer.
do $$
declare hh constant uuid := '11111111-1111-1111-1111-111111111111';
begin
  insert into planning_assumptions (household_id) values (hh) on conflict (household_id) do nothing;
  update planning_assumptions
     set nominal_return_pct = 0, inflation_pct = 0, safe_withdrawal_pct = 4, debt_extra_payment = 0,
         custom_nominal_return_pct = null, custom_inflation_pct = null, custom_safe_withdrawal_pct = null, custom_updated_at = now()
   where household_id = hh;

  begin
    update planning_assumptions set nominal_return_pct = -40 where household_id = hh;
    raise exception 'planning ranges FAILED: a return of -40%% was accepted';
  exception when check_violation then null;
  end;
  begin
    update planning_assumptions set custom_nominal_return_pct = 60 where household_id = hh;
    raise exception 'planning ranges FAILED: a Custom return of 60%% was accepted';
  exception when check_violation then null;
  end;
  begin
    update planning_assumptions set baseline_nominal_return_pct = 51 where household_id = hh;
    raise exception 'planning ranges FAILED: a baseline return of 51%% was accepted';
  exception when check_violation then null;
  end;
  begin
    update planning_assumptions set inflation_pct = -100 where household_id = hh;
    raise exception 'planning ranges FAILED: inflation of -100%% was accepted';
  exception when check_violation then null;
  end;
  begin
    update planning_assumptions set custom_inflation_pct = 31 where household_id = hh;
    raise exception 'planning ranges FAILED: Custom inflation of 31%% was accepted';
  exception when check_violation then null;
  end;
  begin
    update planning_assumptions set baseline_inflation_pct = -11 where household_id = hh;
    raise exception 'planning ranges FAILED: baseline inflation of -11%% was accepted';
  exception when check_violation then null;
  end;
  begin
    update planning_assumptions set safe_withdrawal_pct = 0 where household_id = hh;
    raise exception 'planning ranges FAILED: a withdrawal rate of 0%% was accepted';
  exception when check_violation then null;
  end;
  begin
    update planning_assumptions set custom_safe_withdrawal_pct = 12 where household_id = hh;
    raise exception 'planning ranges FAILED: a Custom withdrawal rate of 12%% was accepted';
  exception when check_violation then null;
  end;
  begin
    update planning_assumptions set lean_annual_spend = 0 where household_id = hh;
    raise exception 'planning ranges FAILED: a lean spend of 0 was accepted';
  exception when check_violation then null;
  end;
  begin
    update planning_assumptions set debt_extra_payment = -1 where household_id = hh;
    raise exception 'planning ranges FAILED: a negative extra payment was accepted';
  exception when check_violation then null;
  end;

  -- 0% return and inflation, a 0 extra payment and a blank Custom figure stand.
  if not exists (select 1 from planning_assumptions where household_id = hh and nominal_return_pct = 0 and inflation_pct = 0 and debt_extra_payment = 0 and custom_inflation_pct is null) then
    raise exception 'planning ranges FAILED: a 0%% figure or a blank Custom figure was refused';
  end if;

  insert into debts (id, household_id, name, balance, apr_pct, minimum_payment)
  values ('abababab-0000-0000-0000-0000000000d1', hh, 'Family loan', 6000, 0, 0);
  begin
    update debts set apr_pct = -1 where id = 'abababab-0000-0000-0000-0000000000d1';
    raise exception 'planning ranges FAILED: a negative rate was accepted';
  exception when check_violation then null;
  end;
  begin
    update debts set apr_pct = 101 where id = 'abababab-0000-0000-0000-0000000000d1';
    raise exception 'planning ranges FAILED: a rate above 100%% was accepted';
  exception when check_violation then null;
  end;
  begin
    update debts set minimum_payment = -50 where id = 'abababab-0000-0000-0000-0000000000d1';
    raise exception 'planning ranges FAILED: a negative minimum was accepted';
  exception when check_violation then null;
  end;
  begin
    update debts set balance = -1 where id = 'abababab-0000-0000-0000-0000000000d1';
    raise exception 'planning ranges FAILED: a negative balance was accepted';
  exception when check_violation then null;
  end;
  delete from debts where id = 'abababab-0000-0000-0000-0000000000d1';
  raise notice 'planning ranges ok: assumptions and debt terms stay in range, and 0 stands where it is real';
end $$;

-- The saved marker: a row created by another editor holds the database's
-- defaults and says nothing was saved; the assumptions drawer's save says it
-- was (Planning audit, 1.3).
do $$
declare hh constant uuid := '11111111-1111-1111-1111-111111111111';
declare r record;
begin
  delete from planning_assumptions where household_id = hh;
  insert into planning_assumptions (household_id, retirement_year) values (hh, 2050);
  select * into r from planning_assumptions where household_id = hh;
  if r.nominal_return_pct <> 6 or r.inflation_pct <> 2.5 or r.safe_withdrawal_pct <> 4 then
    raise exception 'saved marker FAILED: a new row did not hold the defaults the app shows (%, %, %)', r.nominal_return_pct, r.inflation_pct, r.safe_withdrawal_pct;
  end if;
  if r.assumptions_saved_at is not null then
    raise exception 'saved marker FAILED: a row the life plan created reads as saved assumptions';
  end if;
  update planning_assumptions set nominal_return_pct = 7, assumptions_saved_at = now() where household_id = hh;
  if (select assumptions_saved_at from planning_assumptions where household_id = hh) is null then
    raise exception 'saved marker FAILED: the marker did not keep';
  end if;
  raise notice 'saved marker ok: a row another editor creates holds the defaults and is not saved until the drawer saves';
end $$;

-- The saved payoff order: avalanche or snowball, and nothing else (Planning
-- audit, 1.4).
do $$
declare hh constant uuid := '11111111-1111-1111-1111-111111111111';
begin
  insert into planning_assumptions (household_id) values (hh) on conflict (household_id) do nothing;
  update planning_assumptions set debt_order = 'snowball' where household_id = hh;
  update planning_assumptions set debt_order = null where household_id = hh;
  begin
    update planning_assumptions set debt_order = 'custom' where household_id = hh;
    raise exception 'debt order FAILED: a custom order was accepted before a rank can be set';
  exception when check_violation then null;
  end;
  raise notice 'debt order ok: avalanche, snowball or blank, and nothing else';
end $$;

-- A goal's done mark and planned monthly amount: a plan is never below
-- nothing, and a done goal reopens (Planning audit, 2.7).
do $$
declare hh constant uuid := '11111111-1111-1111-1111-111111111111';
declare g uuid;
begin
  insert into goals (household_id, name, target_amount) values (hh, 'Trip', 1000) returning id into g;
  if (select done_at from goals where id = g) is not null or (select planned_monthly from goals where id = g) is not null then
    raise exception 'goal done and planned FAILED: a new goal reads as done or planned';
  end if;
  update goals set planned_monthly = 0 where id = g;
  update goals set planned_monthly = 250, done_at = now() where id = g;
  update goals set done_at = null where id = g;
  begin
    update goals set planned_monthly = -1 where id = g;
    raise exception 'goal done and planned FAILED: a negative monthly plan was accepted';
  exception when check_violation then null;
  end;
  raise notice 'goal done and planned ok: open by default, a plan of 0 or more, and a done goal reopens';
end $$;

-- The planning basis: budget, recorded or blank, and records counted from
-- the first of a month (Planning audit, 2.9).
do $$
declare hh constant uuid := '11111111-1111-1111-1111-111111111111';
begin
  insert into planning_assumptions (household_id) values (hh) on conflict (household_id) do nothing;
  if (select planning_basis from planning_assumptions where household_id = hh) is not null then
    raise exception 'planning basis FAILED: a row reads as having chosen a basis';
  end if;
  update planning_assumptions set planning_basis = 'budget', records_from = '2026-10-01' where household_id = hh;
  update planning_assumptions set planning_basis = 'recorded', records_from = null where household_id = hh;
  update planning_assumptions set planning_basis = null where household_id = hh;
  begin
    update planning_assumptions set planning_basis = 'forecast' where household_id = hh;
    raise exception 'planning basis FAILED: a basis other than budget or recorded was accepted';
  exception when check_violation then null;
  end;
  begin
    update planning_assumptions set records_from = '2026-10-15' where household_id = hh;
    raise exception 'planning basis FAILED: records counted from the middle of a month';
  exception when check_violation then null;
  end;
  raise notice 'planning basis ok: budget, recorded or blank, from the first of a month';
end $$;

-- Costs that start when work stops: amounts, names, currencies, the rise and
-- the timing are checked at the source (Planning audit, 3.13).
do $$
declare
  hh constant uuid := '11111111-1111-1111-1111-111111111111';
  c uuid;
begin
  insert into after_work_costs (household_id, name, amount) values (hh, 'Visa fees', 2000) returning id into c;
  if (select (per_person, rise_pct, starts_after_years, lasts_years, currency) from after_work_costs where id = c)
     is distinct from row(false, 0.00::numeric(5, 2), 0, null::int, 'AED'::text) then
    raise exception 'after_work_costs FAILED: a new cost is not for the household, level, from the stop, for good, in AED';
  end if;
  insert into after_work_costs (household_id, name, amount, currency, per_person, rise_pct, starts_after_years, lasts_years)
  values (hh, 'Health cover', 30000, 'INR', true, 3.5, 0, 30);
  begin
    insert into after_work_costs (household_id, name, amount) values (hh, 'Nothing', 0);
    raise exception 'after_work_costs FAILED: a zero amount was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into after_work_costs (household_id, name, amount) values (hh, '  ', 100);
    raise exception 'after_work_costs FAILED: a blank name was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into after_work_costs (household_id, name, amount, currency) values (hh, 'Cover', 100, 'EUR');
    raise exception 'after_work_costs FAILED: a currency the app cannot convert was accepted';
  exception when check_violation then null;
  end;
  begin
    update after_work_costs set rise_pct = 12 where id = c;
    raise exception 'after_work_costs FAILED: a rise above 10%% a year was accepted';
  exception when check_violation then null;
  end;
  begin
    update after_work_costs set rise_pct = -1 where id = c;
    raise exception 'after_work_costs FAILED: a falling cost was accepted';
  exception when check_violation then null;
  end;
  begin
    update after_work_costs set starts_after_years = 61 where id = c;
    raise exception 'after_work_costs FAILED: a start beyond 60 years was accepted';
  exception when check_violation then null;
  end;
  begin
    update after_work_costs set lasts_years = 0 where id = c;
    raise exception 'after_work_costs FAILED: a cost lasting no years was accepted';
  exception when check_violation then null;
  end;
  raise notice 'after_work_costs ok: amounts, names, currencies, the rise and the timing are checked';
end $$;

-- A holding's sector comes from the fixed list, and the household's
-- concentration cap is a share above nothing and at most the whole
-- (Planning audit, 4.17).
do $$
declare
  hh constant uuid := '11111111-1111-1111-1111-111111111111';
  h uuid;
begin
  insert into holdings (household_id, name, asset_class, value_aed) values (hh, 'Sector test', 'us_equity', 1000) returning id into h;
  if (select sector from holdings where id = h) is not null then
    raise exception 'holding sector FAILED: a new holding was given a sector';
  end if;
  update holdings set sector = 'technology' where id = h;
  update holdings set sector = 'broad' where id = h;
  update holdings set sector = null where id = h;
  begin
    update holdings set sector = 'Technology' where id = h;
    raise exception 'holding sector FAILED: a sector off the list was accepted';
  exception when check_violation then null;
  end;
  begin
    update holdings set sector = '' where id = h;
    raise exception 'holding sector FAILED: a blank sector was accepted';
  exception when check_violation then null;
  end;
  if (select concentration_cap_pct from households where id = hh) is not null then
    raise exception 'concentration cap FAILED: a household starts with a cap';
  end if;
  update households set concentration_cap_pct = 25 where id = hh;
  update households set concentration_cap_pct = 100 where id = hh;
  update households set concentration_cap_pct = null where id = hh;
  begin
    update households set concentration_cap_pct = 0 where id = hh;
    raise exception 'concentration cap FAILED: a cap of nothing was accepted';
  exception when check_violation then null;
  end;
  begin
    update households set concentration_cap_pct = 101 where id = hh;
    raise exception 'concentration cap FAILED: a cap above the whole was accepted';
  exception when check_violation then null;
  end;
  raise notice 'holding sector and concentration cap ok: the list, blank, and a cap between nothing and the whole';
end $$;

-- A note checked once a year: an ordinary note by default, never checked
-- until marked (Planning audit, 4.18).
do $$
declare
  hh constant uuid := '11111111-1111-1111-1111-111111111111';
  n uuid;
begin
  insert into household_notes (household_id, title) values (hh, 'Protection') returning id into n;
  if (select (check_yearly, checked_on) from household_notes where id = n) is distinct from row(false, null::date) then
    raise exception 'yearly check FAILED: a new note is a yearly check, or already checked';
  end if;
  update household_notes set check_yearly = true, checked_on = '2026-10-26' where id = n;
  if (select checked_on from household_notes where id = n) <> date '2026-10-26' then
    raise exception 'yearly check FAILED: the day it was checked was not kept';
  end if;
  begin
    update household_notes set check_yearly = null where id = n;
    raise exception 'yearly check FAILED: a note neither yearly nor not was accepted';
  exception when not_null_violation then null;
  end;
  raise notice 'yearly check ok: off by default, the day kept, never null';
end $$;

-- What cash earns in the Life plan: blank is the default, and a figure is a
-- plausible rate (Planning audit, 4.19).
do $$
declare
  hh constant uuid := '11111111-1111-1111-1111-111111111111';
begin
  insert into planning_assumptions (household_id) values (hh) on conflict (household_id) do nothing;
  if (select cash_return_pct from planning_assumptions where household_id = hh) is not null then
    raise exception 'cash return FAILED: a household starts with a cash rate of its own';
  end if;
  update planning_assumptions set cash_return_pct = 3.5 where household_id = hh;
  update planning_assumptions set cash_return_pct = -5 where household_id = hh;
  begin
    update planning_assumptions set cash_return_pct = 25 where household_id = hh;
    raise exception 'cash return FAILED: cash earning 25%% a year was accepted';
  exception when check_violation then null;
  end;
  begin
    update planning_assumptions set cash_return_pct = -6 where household_id = hh;
    raise exception 'cash return FAILED: cash losing 6%% a year was accepted';
  exception when check_violation then null;
  end;
  raise notice 'cash return ok: blank by default, between -5%% and 20%%';
end $$;

-- An Indian holding can carry its broker's sector; anything off both lists
-- is still refused.
do $$
declare
  hh constant uuid := '11111111-1111-1111-1111-111111111111';
  h uuid;
begin
  insert into holdings (household_id, name, asset_class, currency, value_aed) values (hh, 'Broker sector test', 'india_equity', 'INR', 1000) returning id into h;
  update holdings set sector = 'defence' where id = h;
  update holdings set sector = 'engineering_capital_goods' where id = h;
  update holdings set sector = 'fmcg' where id = h;
  begin
    update holdings set sector = 'textiles' where id = h;
    raise exception 'broker sectors FAILED: a sector on neither list was accepted';
  exception when check_violation then null;
  end;
  raise notice 'broker sectors ok: the statement''s sectors, and nothing else';
end $$;

-- ---------------------------------------------------------------------------
-- Share trades (SHR-367): trades are the record of a holding. Fixtures for
-- every B2 case below: a dollar broker fund, a rupee broker fund, and helpers
-- that build a holding with an opening entry.
-- ---------------------------------------------------------------------------

-- B2-01: a broker's cash is an account of its own kind, in its currency.
insert into accounts (id, household_id, name, type, currency, balance, is_shared)
values ('b2000000-0000-0000-0000-0000000000f1', '11111111-1111-1111-1111-111111111111', 'Dollar broker funds', 'broker_funds', 'USD', 1000, false);
insert into accounts (id, household_id, name, type, currency, balance, is_shared)
values ('b2000000-0000-0000-0000-0000000000f2', '11111111-1111-1111-1111-111111111111', 'Rupee broker funds', 'broker_funds', 'INR', 100000, false);
do $$ begin raise notice 'B2-01 ok: a broker funds account in dollars and one in rupees'; end $$;

-- B2-02: units keep eight decimals, so a fractional holding sold whole is not
-- read as selling more than was held.
do $$
declare q numeric;
begin
  insert into holdings (id, household_id, owner_member_id, is_shared, name, asset_class, currency, quantity, avg_price, value_aed)
  values ('b2000000-0000-0000-0000-000000000101', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', false, 'ABC', 'us_equity', 'USD', 1.23456789, 100.123456, 0);
  select quantity into q from holdings where id = 'b2000000-0000-0000-0000-000000000101';
  if q <> 1.23456789 then raise exception 'B2-02 FAILED: units stored as %', q; end if;
  raise notice 'B2-02 ok: 1.23456789 units kept exactly';
end $$;

-- B2-03: one opening entry per holding.
do $$
begin
  insert into holding_trades (household_id, holding_id, member_id, kind, trade_date, units, price, source)
  values ('11111111-1111-1111-1111-111111111111', 'b2000000-0000-0000-0000-000000000101', '22222222-2222-2222-2222-222222222222', 'opening', '2026-10-01', 1.23456789, 100.123456, 'opening');
  begin
    insert into holding_trades (household_id, holding_id, member_id, kind, trade_date, units, price, source)
    values ('11111111-1111-1111-1111-111111111111', 'b2000000-0000-0000-0000-000000000101', '22222222-2222-2222-2222-222222222222', 'opening', '2026-10-02', 1, 100, 'opening');
    raise exception 'B2-03 FAILED: a second opening entry was accepted';
  exception when unique_violation then null;
  end;
  raise notice 'B2-03 ok: a second opening entry is refused';
end $$;

-- B2-04: a buy carries a fund and a price; a split carries neither.
do $$
begin
  begin
    insert into holding_trades (household_id, holding_id, member_id, kind, trade_date, units, price, source)
    values ('11111111-1111-1111-1111-111111111111', 'b2000000-0000-0000-0000-000000000101', '22222222-2222-2222-2222-222222222222', 'buy', '2026-10-03', 1, 100, 'app');
    raise exception 'B2-04 FAILED: a buy without a fund was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into holding_trades (household_id, holding_id, member_id, kind, trade_date, units, price, source)
    values ('11111111-1111-1111-1111-111111111111', 'b2000000-0000-0000-0000-000000000101', '22222222-2222-2222-2222-222222222222', 'split', '2026-10-03', 10, 5, 'app');
    raise exception 'B2-04 FAILED: a split with a price was accepted';
  exception when check_violation then null;
  end;
  raise notice 'B2-04 ok: a buy needs a fund, a split takes no price';
end $$;

-- B2-05: the fund is in the holding's currency and still open.
do $$
begin
  begin
    insert into holding_trades (household_id, holding_id, member_id, kind, trade_date, units, price, funds_account_id, source)
    values ('11111111-1111-1111-1111-111111111111', 'b2000000-0000-0000-0000-000000000101', '22222222-2222-2222-2222-222222222222', 'buy', '2026-10-03', 1, 100, 'b2000000-0000-0000-0000-0000000000f2', 'app');
    raise exception 'B2-05 FAILED: a dollar holding''s buy through a rupee fund was accepted';
  exception when check_violation then null;
  end;
  update accounts set archived_at = now() where id = 'b2000000-0000-0000-0000-0000000000f1';
  begin
    insert into holding_trades (household_id, holding_id, member_id, kind, trade_date, units, price, funds_account_id, source)
    values ('11111111-1111-1111-1111-111111111111', 'b2000000-0000-0000-0000-000000000101', '22222222-2222-2222-2222-222222222222', 'buy', '2026-10-03', 1, 100, 'b2000000-0000-0000-0000-0000000000f1', 'app');
    raise exception 'B2-05 FAILED: a buy through a closed fund was accepted';
  exception when check_violation then null;
  end;
  update accounts set archived_at = null where id = 'b2000000-0000-0000-0000-0000000000f1';
  raise notice 'B2-05 ok: the fund must match the currency and be open';
end $$;

-- B2-06: a traded holding's units and average change only through the replay.
do $$
begin
  perform set_config('rokda.trade_replay', 'on', true);
  update holdings set trades_version = 1 where id = 'b2000000-0000-0000-0000-000000000101';
  perform set_config('rokda.trade_replay', '', true);
  begin
    update holdings set quantity = quantity + 1 where id = 'b2000000-0000-0000-0000-000000000101';
    raise exception 'B2-06 FAILED: units of a traded holding were edited by hand';
  exception when check_violation then null;
  end;
  begin
    update holdings set avg_price = 1 where id = 'b2000000-0000-0000-0000-000000000101';
    raise exception 'B2-06 FAILED: the average of a traded holding was edited by hand';
  exception when check_violation then null;
  end;
  perform set_config('rokda.trade_replay', 'on', true);
  update holdings set quantity = 2 where id = 'b2000000-0000-0000-0000-000000000101';
  perform set_config('rokda.trade_replay', '', true);
  update holdings set quantity = 2, name = 'ABC renamed' where id = 'b2000000-0000-0000-0000-000000000101';
  perform set_config('rokda.trade_replay', 'on', true);
  update holdings set trades_version = 0 where id = 'b2000000-0000-0000-0000-000000000101';
  perform set_config('rokda.trade_replay', '', true);
  update holdings set quantity = 3 where id = 'b2000000-0000-0000-0000-000000000101';
  raise notice 'B2-06 ok: hand edits refused on a traded holding, allowed to the replay and on untraded holdings';
end $$;

-- B2-07: a holding with buys or sells is kept; one with only its opening goes.
do $$
declare n int;
begin
  insert into holdings (id, household_id, owner_member_id, is_shared, name, asset_class, currency, quantity, avg_price, value_aed)
  values ('b2000000-0000-0000-0000-000000000102', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', false, 'XYZ', 'us_equity', 'USD', 10, 100, 0);
  insert into holding_trades (household_id, holding_id, member_id, kind, trade_date, units, price, source)
  values ('11111111-1111-1111-1111-111111111111', 'b2000000-0000-0000-0000-000000000102', '22222222-2222-2222-2222-222222222222', 'opening', '2026-10-01', 10, 100, 'opening');
  insert into holding_trades (household_id, holding_id, member_id, kind, trade_date, units, price, funds_account_id, source)
  values ('11111111-1111-1111-1111-111111111111', 'b2000000-0000-0000-0000-000000000102', '22222222-2222-2222-2222-222222222222', 'buy', '2026-10-02', 1, 100, 'b2000000-0000-0000-0000-0000000000f1', 'app');
  begin
    delete from holdings where id = 'b2000000-0000-0000-0000-000000000102';
    raise exception 'B2-07 FAILED: a holding with a buy was deleted';
  exception when check_violation then null;
  end;
  delete from holdings where id = 'b2000000-0000-0000-0000-000000000101';
  select count(*) into n from holding_trades where holding_id = 'b2000000-0000-0000-0000-000000000101';
  if n <> 0 then raise exception 'B2-07 FAILED: % entries outlived their holding', n; end if;
  delete from holding_trades where holding_id = 'b2000000-0000-0000-0000-000000000102';
  delete from holdings where id = 'b2000000-0000-0000-0000-000000000102';
  raise notice 'B2-07 ok: a holding with buys or sells is kept, one with only its opening is deleted with it';
end $$;

-- B2-10 to B2-15: the replay, the one place units, average and profit are
-- worked out. Entries are given as JSON, as the trade functions pass them.
do $$
declare r jsonb; sell jsonb; buy jsonb;
begin
  -- B2-10: the spec's worked example, brokerage kept out of the average.
  r := private.replay_entries('[
    {"id":"o","kind":"opening","trade_date":"2026-10-01","created_at":"2026-10-01T08:00:00Z","units":10,"price":100,"fees":0},
    {"id":"b","kind":"buy","trade_date":"2026-10-02","created_at":"2026-10-02T08:00:00Z","units":5,"price":130,"fees":1},
    {"id":"s","kind":"sell","trade_date":"2026-10-03","created_at":"2026-10-03T08:00:00Z","units":6,"price":150,"fees":1}
  ]'::jsonb, false);
  select x into buy from jsonb_array_elements(r -> 'entries') x where x ->> 'id' = 'b';
  select x into sell from jsonb_array_elements(r -> 'entries') x where x ->> 'id' = 's';
  if (r ->> 'ok')::boolean is not true or (r ->> 'units')::numeric <> 9 or (r ->> 'avg')::numeric <> 110
     or (sell ->> 'realised')::numeric <> 239 or (buy ->> 'avg_after')::numeric <> 110 or (buy ->> 'units_after')::numeric <> 15 then
    raise exception 'B2-10 FAILED: %', r;
  end if;
  raise notice 'B2-10 ok: 10 at 100, buy 5 at 130, sell 6 at 150 leaves 9 at 110 and a profit of 239';

  -- B2-11: a broker that puts brokerage into the average.
  r := private.replay_entries('[
    {"id":"o","kind":"opening","trade_date":"2026-10-01","created_at":"2026-10-01T08:00:00Z","units":10,"price":100,"fees":0},
    {"id":"b","kind":"buy","trade_date":"2026-10-02","created_at":"2026-10-02T08:00:00Z","units":5,"price":130,"fees":1}
  ]'::jsonb, true);
  if (r ->> 'avg')::numeric <> 110.066667 then raise exception 'B2-11 FAILED: average %', r ->> 'avg'; end if;
  raise notice 'B2-11 ok: brokerage in the average gives 110.066667';

  -- B2-12: a split multiplies units and divides the average; no profit.
  r := private.replay_entries('[
    {"id":"o","kind":"opening","trade_date":"2026-10-01","created_at":"2026-10-01T08:00:00Z","units":9,"price":110,"fees":0},
    {"id":"x","kind":"split","trade_date":"2026-10-05","created_at":"2026-10-05T08:00:00Z","units":10,"price":null,"fees":0}
  ]'::jsonb, false);
  select x into sell from jsonb_array_elements(r -> 'entries') x where x ->> 'id' = 'x';
  if (r ->> 'units')::numeric <> 90 or (r ->> 'avg')::numeric <> 11 or sell -> 'realised' <> 'null'::jsonb then
    raise exception 'B2-12 FAILED: %', r;
  end if;
  raise notice 'B2-12 ok: a 10-for-1 split of 9 at 110 gives 90 at 11';

  -- B2-13: a sale back-dated before the buy it needed is refused.
  r := private.replay_entries('[
    {"id":"o","kind":"opening","trade_date":"2026-10-01","created_at":"2026-10-01T08:00:00Z","units":10,"price":100,"fees":0},
    {"id":"b","kind":"buy","trade_date":"2026-10-10","created_at":"2026-10-10T08:00:00Z","units":5,"price":100,"fees":0},
    {"id":"s","kind":"sell","trade_date":"2026-10-05","created_at":"2026-10-11T08:00:00Z","units":12,"price":100,"fees":0}
  ]'::jsonb, false);
  if (r ->> 'ok')::boolean is not false or r ->> 'error' <> 'exceeds_units' or r ->> 'entry_id' <> 's' then
    raise exception 'B2-13 FAILED: %', r;
  end if;
  raise notice 'B2-13 ok: a sale before the buy it needed is refused';

  -- B2-14: nothing before the opening entry, and nothing without one.
  r := private.replay_entries('[
    {"id":"o","kind":"opening","trade_date":"2026-10-05","created_at":"2026-10-05T08:00:00Z","units":10,"price":100,"fees":0},
    {"id":"b","kind":"buy","trade_date":"2026-10-01","created_at":"2026-10-06T08:00:00Z","units":5,"price":100,"fees":0}
  ]'::jsonb, false);
  if r ->> 'error' is distinct from 'before_opening' then raise exception 'B2-14 FAILED: %', r; end if;
  r := private.replay_entries('[
    {"id":"b","kind":"buy","trade_date":"2026-10-01","created_at":"2026-10-01T08:00:00Z","units":5,"price":100,"fees":0}
  ]'::jsonb, false);
  if r ->> 'error' is distinct from 'no_opening' then raise exception 'B2-14 FAILED: %', r; end if;
  raise notice 'B2-14 ok: a trade before the opening entry, or with none, is refused';

  -- B2-15 (Review Focus 4): two trades on one day with no time replay in the
  -- order they were recorded.
  r := private.replay_entries('[
    {"id":"o","kind":"opening","trade_date":"2026-10-01","created_at":"2026-10-01T08:00:00Z","units":10,"price":100,"fees":0},
    {"id":"s","kind":"sell","trade_date":"2026-10-02","created_at":"2026-10-02T08:00:00Z","units":12,"price":100,"fees":0},
    {"id":"b","kind":"buy","trade_date":"2026-10-02","created_at":"2026-10-02T09:00:00Z","units":5,"price":100,"fees":0}
  ]'::jsonb, false);
  if r ->> 'error' is distinct from 'exceeds_units' then raise exception 'B2-15 FAILED: sell first was %', r; end if;
  r := private.replay_entries('[
    {"id":"o","kind":"opening","trade_date":"2026-10-01","created_at":"2026-10-01T08:00:00Z","units":10,"price":100,"fees":0},
    {"id":"s","kind":"sell","trade_date":"2026-10-02","created_at":"2026-10-02T09:00:00Z","units":12,"price":100,"fees":0},
    {"id":"b","kind":"buy","trade_date":"2026-10-02","created_at":"2026-10-02T08:00:00Z","units":5,"price":100,"fees":0}
  ]'::jsonb, false);
  if (r ->> 'ok')::boolean is not true or (r ->> 'units')::numeric <> 3 then raise exception 'B2-15 FAILED: buy first was %', r; end if;
  raise notice 'B2-15 ok: same-day trades with no time replay in the order recorded';
end $$;

-- B2-20 to B2-29: preview and record a trade. The bot calls these as the
-- service role for the member who confirmed; the fixtures are a dollar
-- holding of 10 at 100, priced at 150, live (opening entry, version 1), whose
-- trades go through the dollar fund of 1000 that nobody has confirmed yet.
do $$ begin perform set_config('request.jwt.claim.role', 'service_role', true); end $$;
update accounts set balance = 1000, balance_as_of = null, archived_at = null where id = 'b2000000-0000-0000-0000-0000000000f1';
insert into holdings (id, household_id, owner_member_id, is_shared, name, asset_class, currency, quantity, avg_price, current_price, value_aed, funds_account_id)
values ('b2000000-0000-0000-0000-000000000201', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', false, 'ABC', 'us_equity', 'USD', 10, 100, 150, 5508.75, 'b2000000-0000-0000-0000-0000000000f1');
insert into holding_trades (household_id, holding_id, member_id, kind, trade_date, units, price, source, units_after, avg_after)
values ('11111111-1111-1111-1111-111111111111', 'b2000000-0000-0000-0000-000000000201', '22222222-2222-2222-2222-222222222222', 'opening', '2026-10-01', 10, 100, 'opening', 10, 100);
select set_config('rokda.trade_replay', 'on', true);
update holdings set trades_version = 1 where id = 'b2000000-0000-0000-0000-000000000201';
select set_config('rokda.trade_replay', '', true);

-- B2-20 (and Review Focus 1): a buy moves the holding, the never-confirmed
-- fund, the value and today's value point together.
do $$
declare r jsonb; h holdings; f accounts; hist numeric; ev account_balance_events;
begin
  r := record_trade('b2000000-0000-0000-0000-000000000201', 'buy', '2026-10-02', 5, 130, 1,
    p_source => 'bot', p_member_id => '22222222-2222-2222-2222-222222222222');
  select * into h from holdings where id = 'b2000000-0000-0000-0000-000000000201';
  select * into f from accounts where id = 'b2000000-0000-0000-0000-0000000000f1';
  select value_aed into hist from holding_value_history where holding_id = h.id and as_of = household_today();
  select * into ev from account_balance_events where account_id = f.id order by id desc limit 1;
  if (r ->> 'ok')::boolean is not true or r ->> 'trade_id' is null then raise exception 'B2-20 FAILED: %', r; end if;
  if h.quantity <> 15 or h.avg_price <> 110 or h.trades_version <> 2 then raise exception 'B2-20 FAILED: holding % at %, version %', h.quantity, h.avg_price, h.trades_version; end if;
  if f.balance <> 349 then raise exception 'B2-20 FAILED: fund %, expected 349', f.balance; end if;
  if f.balance_as_of is not null then raise exception 'B2-20 FAILED: a trade set the fund''s confirmed date'; end if;
  if h.value_aed <> 8263.13 or hist is distinct from 8263.13 then raise exception 'B2-20 FAILED: value %, history %', h.value_aed, hist; end if;
  if ev.source <> 'bot' or ev.new_balance <> 349 or ev.member_id <> '22222222-2222-2222-2222-222222222222' then raise exception 'B2-20 FAILED: balance event %', row_to_json(ev); end if;
  raise notice 'B2-20 ok: holding, fund, value and its history moved together; the fund''s history names the bot';
end $$;

-- B2-22 and B2-21: the preview's figures are the save's, and the sale lands
-- in the fund.
do $$
declare p jsonb; r jsonb; t holding_trades; f accounts;
begin
  p := preview_trade('b2000000-0000-0000-0000-000000000201', 'sell', '2026-10-03', 6, 150, 1, p_member_id => '22222222-2222-2222-2222-222222222222');
  r := record_trade('b2000000-0000-0000-0000-000000000201', 'sell', '2026-10-03', 6, 150, 1,
    p_source => 'bot', p_member_id => '22222222-2222-2222-2222-222222222222');
  select * into t from holding_trades where id = (r ->> 'trade_id')::uuid;
  select * into f from accounts where id = 'b2000000-0000-0000-0000-0000000000f1';
  if (p ->> 'units_after')::numeric <> t.units_after or (p ->> 'avg_after')::numeric <> t.avg_after
     or (p ->> 'realised')::numeric <> t.realised or (p ->> 'cash_amount')::numeric <> t.cash_amount then
    raise exception 'B2-22 FAILED: preview % against saved %', p, row_to_json(t);
  end if;
  raise notice 'B2-22 ok: the preview''s figures are exactly what was saved';
  if t.realised <> 239 or t.cash_amount <> 899 or f.balance <> 1248 then raise exception 'B2-21 FAILED: profit %, cash %, fund %', t.realised, t.cash_amount, f.balance; end if;
  raise notice 'B2-21 ok: the sale made 239 and the fund is 1000 - 651 + 899 = 1248';
end $$;

-- B2-23: an oversized sale is refused and nothing changes.
do $$
declare r jsonb; n int; h holdings; f accounts;
begin
  r := record_trade('b2000000-0000-0000-0000-000000000201', 'sell', '2026-10-04', 100, 150, 0, p_source => 'bot', p_member_id => '22222222-2222-2222-2222-222222222222');
  select count(*) into n from holding_trades where holding_id = 'b2000000-0000-0000-0000-000000000201';
  select * into h from holdings where id = 'b2000000-0000-0000-0000-000000000201';
  select * into f from accounts where id = 'b2000000-0000-0000-0000-0000000000f1';
  if r ->> 'error' is distinct from 'exceeds_units' or n <> 3 or h.quantity <> 9 or f.balance <> 1248 then
    raise exception 'B2-23 FAILED: %, % entries, % units, fund %', r, n, h.quantity, f.balance;
  end if;
  raise notice 'B2-23 ok: selling more than held is refused and changes nothing';
end $$;

-- B2-24: a confirmation made on an older version of the holding is refused.
do $$
declare r jsonb;
begin
  r := record_trade('b2000000-0000-0000-0000-000000000201', 'buy', '2026-10-04', 1, 150, 0, p_source => 'bot',
    p_member_id => '22222222-2222-2222-2222-222222222222', p_expected_version => 2);
  if r ->> 'error' is distinct from 'stale' then raise exception 'B2-24 FAILED: %', r; end if;
  raise notice 'B2-24 ok: a stale confirmation is refused';
end $$;

-- B2-25: one bot confirmation records one trade, however often it arrives.
do $$
declare prop uuid; r1 jsonb; r2 jsonb; n int;
begin
  insert into bot_proposals (household_id, member_id, kind, payload, chat_id)
  values ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'account_balances', '{}', 1)
  returning id into prop;
  r1 := record_trade('b2000000-0000-0000-0000-000000000201', 'buy', '2026-10-04', 1, 150, 0, p_source => 'bot', p_proposal_id => prop, p_member_id => '22222222-2222-2222-2222-222222222222');
  r2 := record_trade('b2000000-0000-0000-0000-000000000201', 'buy', '2026-10-04', 1, 150, 0, p_source => 'bot', p_proposal_id => prop, p_member_id => '22222222-2222-2222-2222-222222222222');
  select count(*) into n from holding_trades where proposal_id = prop;
  if (r1 ->> 'ok')::boolean is not true or r2 ->> 'error' is distinct from 'already_recorded' or r2 ->> 'trade_id' <> r1 ->> 'trade_id' or n <> 1 then
    raise exception 'B2-25 FAILED: % then %, % trades', r1, r2, n;
  end if;
  raise notice 'B2-25 ok: the same proposal records one trade';
end $$;

-- B2-26: a trade from before the fund's confirmed balance is recorded but
-- leaves the fund alone, and the preview says why.
do $$
declare p jsonb; r jsonb; before numeric; after numeric;
begin
  update accounts set balance_as_of = '2026-10-20 12:00+04' where id = 'b2000000-0000-0000-0000-0000000000f1';
  select balance into before from accounts where id = 'b2000000-0000-0000-0000-0000000000f1';
  p := preview_trade('b2000000-0000-0000-0000-000000000201', 'buy', '2026-10-10', 1, 150, 0, p_member_id => '22222222-2222-2222-2222-222222222222');
  r := record_trade('b2000000-0000-0000-0000-000000000201', 'buy', '2026-10-10', 1, 150, 0, p_source => 'bot', p_member_id => '22222222-2222-2222-2222-222222222222');
  select balance into after from accounts where id = 'b2000000-0000-0000-0000-0000000000f1';
  if (p ->> 'funds_moves')::boolean is not false or not (p -> 'warnings') ? 'fund_confirmed_after' or (r ->> 'ok')::boolean is not true or after <> before then
    raise exception 'B2-26 FAILED: preview %, record %, fund % -> %', p, r, before, after;
  end if;
  update accounts set balance_as_of = null where id = 'b2000000-0000-0000-0000-0000000000f1';
  raise notice 'B2-26 ok: a trade before the confirmed balance leaves the fund alone, and the preview says so';
end $$;

-- B2-27: the preview's warnings.
do $$
declare p jsonb;
begin
  p := preview_trade('b2000000-0000-0000-0000-000000000201', 'buy', '2026-10-25', 1, 200, 0, p_member_id => '22222222-2222-2222-2222-222222222222');
  if not (p -> 'warnings') ? 'price_off_market' then raise exception 'B2-27 FAILED: 200 against a price of 150 gave %', p; end if;
  update accounts set balance = 100 where id = 'b2000000-0000-0000-0000-0000000000f1';
  p := preview_trade('b2000000-0000-0000-0000-000000000201', 'buy', '2026-10-25', 5, 130, 0, p_member_id => '22222222-2222-2222-2222-222222222222');
  if not (p -> 'warnings') ? 'fund_below_zero' or (p ->> 'funds_balance_after')::numeric <> -550 then raise exception 'B2-27 FAILED: a fund of 100 paying 650 gave %', p; end if;
  update accounts set balance = 1000 where id = 'b2000000-0000-0000-0000-0000000000f1';
  perform record_trade('b2000000-0000-0000-0000-000000000201', 'buy', '2026-10-25', 1, 151, 0, p_source => 'bot', p_member_id => '22222222-2222-2222-2222-222222222222');
  p := preview_trade('b2000000-0000-0000-0000-000000000201', 'buy', '2026-10-26', 1, 151, 0, p_member_id => '22222222-2222-2222-2222-222222222222');
  if not (p -> 'warnings') ? 'possible_duplicate' then raise exception 'B2-27 FAILED: the same buy a day later gave %', p; end if;
  raise notice 'B2-27 ok: price far from the market, fund below zero and a possible duplicate are flagged';
end $$;

-- B2-28 (Review Focus 2 and 3): a holding never priced, or a rupee holding
-- with no rupee rate, keeps the value it had.
do $$
declare v numeric;
begin
  perform set_config('rokda.trade_replay', 'on', true);
  insert into holdings (id, household_id, owner_member_id, is_shared, name, asset_class, currency, quantity, avg_price, current_price, value_aed, funds_account_id, trades_version)
  values ('b2000000-0000-0000-0000-000000000202', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', false, 'Unpriced', 'us_equity', 'USD', 10, 100, null, 500, 'b2000000-0000-0000-0000-0000000000f1', 1);
  perform set_config('rokda.trade_replay', '', true);
  insert into holding_trades (household_id, holding_id, member_id, kind, trade_date, units, price, source)
  values ('11111111-1111-1111-1111-111111111111', 'b2000000-0000-0000-0000-000000000202', '22222222-2222-2222-2222-222222222222', 'opening', '2026-10-01', 10, 100, 'opening');
  perform record_trade('b2000000-0000-0000-0000-000000000202', 'buy', '2026-10-02', 1, 100, 0, p_source => 'bot', p_member_id => '22222222-2222-2222-2222-222222222222');
  select value_aed into v from holdings where id = 'b2000000-0000-0000-0000-000000000202';
  if v <> 500 then raise exception 'B2-28 FAILED: an unpriced holding''s value became %', v; end if;

  update households set inr_per_aed = null where id = '11111111-1111-1111-1111-111111111111';
  perform set_config('rokda.trade_replay', 'on', true);
  insert into holdings (id, household_id, owner_member_id, is_shared, name, asset_class, currency, quantity, avg_price, current_price, value_aed, funds_account_id, trades_version)
  values ('b2000000-0000-0000-0000-000000000203', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', false, 'Rupee share', 'india_equity', 'INR', 10, 1000, 1000, 777, 'b2000000-0000-0000-0000-0000000000f2', 1);
  perform set_config('rokda.trade_replay', '', true);
  insert into holding_trades (household_id, holding_id, member_id, kind, trade_date, units, price, source)
  values ('11111111-1111-1111-1111-111111111111', 'b2000000-0000-0000-0000-000000000203', '22222222-2222-2222-2222-222222222222', 'opening', '2026-10-01', 10, 1000, 'opening');
  perform record_trade('b2000000-0000-0000-0000-000000000203', 'buy', '2026-10-02', 1, 1000, 0, p_source => 'bot', p_member_id => '22222222-2222-2222-2222-222222222222');
  select value_aed into v from holdings where id = 'b2000000-0000-0000-0000-000000000203';
  if v <> 777 then raise exception 'B2-28 FAILED: a rupee holding with no rate was valued at %', v; end if;
  raise notice 'B2-28 ok: no price or no rupee rate keeps the value as it was';
end $$;

-- B2-29: whole units for Indian shares, and the fund in the holding's currency.
do $$
declare r jsonb;
begin
  r := record_trade('b2000000-0000-0000-0000-000000000203', 'buy', '2026-10-03', 1.5, 1000, 0, p_source => 'bot', p_member_id => '22222222-2222-2222-2222-222222222222');
  if r ->> 'error' is distinct from 'whole_units_only' then raise exception 'B2-29 FAILED: half a share gave %', r; end if;
  r := record_trade('b2000000-0000-0000-0000-000000000203', 'buy', '2026-10-03', 1, 1000, 0, p_funds_account_id => 'b2000000-0000-0000-0000-0000000000f1',
    p_source => 'bot', p_member_id => '22222222-2222-2222-2222-222222222222');
  if r ->> 'error' is distinct from 'currency_mismatch' then raise exception 'B2-29 FAILED: a rupee share through a dollar fund gave %', r; end if;
  raise notice 'B2-29 ok: Indian shares in whole units, through a rupee fund';
end $$;

-- B2-30 to B2-35: fix and delete a trade. A fresh holding of 10 at 100,
-- priced at 150, with two unconfirmed dollar funds of 1000.
update accounts set balance = 1000, balance_as_of = null where id = 'b2000000-0000-0000-0000-0000000000f1';
insert into accounts (id, household_id, name, type, currency, balance, is_shared)
values ('b2000000-0000-0000-0000-0000000000f3', '11111111-1111-1111-1111-111111111111', 'Second dollar fund', 'broker_funds', 'USD', 1000, false);
select set_config('rokda.trade_replay', 'on', true);
insert into holdings (id, household_id, owner_member_id, is_shared, name, asset_class, currency, quantity, avg_price, current_price, value_aed, funds_account_id, trades_version)
values ('b2000000-0000-0000-0000-000000000301', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', false, 'DEF', 'us_equity', 'USD', 10, 100, 150, 5508.75, 'b2000000-0000-0000-0000-0000000000f1', 1);
select set_config('rokda.trade_replay', '', true);
insert into holding_trades (id, household_id, holding_id, member_id, kind, trade_date, units, price, source, units_after, avg_after)
values ('b2000000-0000-0000-0000-000000000310', '11111111-1111-1111-1111-111111111111', 'b2000000-0000-0000-0000-000000000301', '22222222-2222-2222-2222-222222222222', 'opening', '2026-10-01', 10, 100, 'opening', 10, 100);
create temporary table b2_ids (name text primary key, id uuid);

-- B2-30: fixing the buy's price replays the average and the later sale's
-- profit; the fund moves only by the difference.
do $$
declare b jsonb; sl jsonb; r jsonb; t holding_trades; h holdings; f numeric;
begin
  b := record_trade('b2000000-0000-0000-0000-000000000301', 'buy', '2026-10-02', 5, 130, 1, p_source => 'app', p_member_id => '22222222-2222-2222-2222-222222222222');
  sl := record_trade('b2000000-0000-0000-0000-000000000301', 'sell', '2026-10-03', 6, 150, 1, p_source => 'app', p_member_id => '22222222-2222-2222-2222-222222222222');
  insert into b2_ids values ('buy', (b ->> 'trade_id')::uuid), ('sell', (sl ->> 'trade_id')::uuid);
  r := fix_trade((b ->> 'trade_id')::uuid, '2026-10-02', 5, 120, 1, 0, null, 'b2000000-0000-0000-0000-0000000000f1', false, null, null,
    p_member_id => '22222222-2222-2222-2222-222222222222');
  select * into t from holding_trades where id = (sl ->> 'trade_id')::uuid;
  select * into h from holdings where id = 'b2000000-0000-0000-0000-000000000301';
  select balance into f from accounts where id = 'b2000000-0000-0000-0000-0000000000f1';
  if (r ->> 'ok')::boolean is not true or t.realised <> 259 or h.avg_price <> 106.666667 or h.quantity <> 9 or f <> 1298 then
    raise exception 'B2-30 FAILED: %, sale profit %, holding % at %, fund %', r, t.realised, h.quantity, h.avg_price, f;
  end if;
  raise notice 'B2-30 ok: a fixed buy price replays the sale''s profit (259) and moves the fund by the difference only (1298)';
end $$;

-- B2-31: deleting the sale restores its units and reverses its money.
do $$
declare r jsonb; h holdings; f numeric;
begin
  r := delete_trade((select id from b2_ids where name = 'sell'), null, p_member_id => '22222222-2222-2222-2222-222222222222');
  select * into h from holdings where id = 'b2000000-0000-0000-0000-000000000301';
  select balance into f from accounts where id = 'b2000000-0000-0000-0000-0000000000f1';
  if (r ->> 'ok')::boolean is not true or h.quantity <> 15 or f <> 399 or exists (select 1 from holding_trades where id = (select id from b2_ids where name = 'sell')) then
    raise exception 'B2-31 FAILED: %, % units, fund %', r, h.quantity, f;
  end if;
  raise notice 'B2-31 ok: deleting the sale gives back 15 units and takes its 899 out of the fund';
end $$;

-- B2-32: a fix that would leave a later sale selling more than was held is
-- refused, and nothing changes.
do $$
declare s2 jsonb; r jsonb; h holdings; f numeric; u numeric;
begin
  s2 := record_trade('b2000000-0000-0000-0000-000000000301', 'sell', '2026-10-04', 12, 150, 0, p_source => 'app', p_member_id => '22222222-2222-2222-2222-222222222222');
  select balance into f from accounts where id = 'b2000000-0000-0000-0000-0000000000f1';
  r := fix_trade((select id from b2_ids where name = 'buy'), '2026-10-02', 1, 120, 1, 0, null, 'b2000000-0000-0000-0000-0000000000f1', false, null, null,
    p_member_id => '22222222-2222-2222-2222-222222222222');
  select * into h from holdings where id = 'b2000000-0000-0000-0000-000000000301';
  select units into u from holding_trades where id = (select id from b2_ids where name = 'buy');
  if r ->> 'error' is distinct from 'exceeds_units' or h.quantity <> 3 or u <> 5
     or (select balance from accounts where id = 'b2000000-0000-0000-0000-0000000000f1') <> f then
    raise exception 'B2-32 FAILED: %, holding %, buy units %', r, h.quantity, u;
  end if;
  perform delete_trade((s2 ->> 'trade_id')::uuid, null, p_member_id => '22222222-2222-2222-2222-222222222222');
  raise notice 'B2-32 ok: a fix that a later sale cannot survive is refused';
end $$;

-- B2-33 (Review Focus 5): moving a trade to another fund reverses the first
-- fund and moves the second.
do $$
declare r jsonb; f1 numeric; f3 numeric;
begin
  r := fix_trade((select id from b2_ids where name = 'buy'), '2026-10-02', 5, 120, 1, 0, null, 'b2000000-0000-0000-0000-0000000000f3', false, null, null,
    p_member_id => '22222222-2222-2222-2222-222222222222');
  select balance into f1 from accounts where id = 'b2000000-0000-0000-0000-0000000000f1';
  select balance into f3 from accounts where id = 'b2000000-0000-0000-0000-0000000000f3';
  if (r ->> 'ok')::boolean is not true or f1 <> 1000 or f3 <> 399 then
    raise exception 'B2-33 FAILED: %, first fund %, second fund %', r, f1, f3;
  end if;
  raise notice 'B2-33 ok: the first fund gets its 601 back and the second pays it';
end $$;

-- B2-34: fixing or deleting a trade from before the fund's confirmed balance
-- changes the trade and the holding, never the fund.
do $$
declare r jsonb; f3 numeric; h holdings;
begin
  update accounts set balance_as_of = '2026-10-20 12:00+04' where id = 'b2000000-0000-0000-0000-0000000000f3';
  r := fix_trade((select id from b2_ids where name = 'buy'), '2026-10-02', 5, 110, 1, 0, null, 'b2000000-0000-0000-0000-0000000000f3', false, null, null,
    p_member_id => '22222222-2222-2222-2222-222222222222');
  select balance into f3 from accounts where id = 'b2000000-0000-0000-0000-0000000000f3';
  if (r ->> 'ok')::boolean is not true or f3 <> 399 then raise exception 'B2-34 FAILED: a fix moved a confirmed fund to %', f3; end if;
  r := delete_trade((select id from b2_ids where name = 'buy'), null, p_member_id => '22222222-2222-2222-2222-222222222222');
  select balance into f3 from accounts where id = 'b2000000-0000-0000-0000-0000000000f3';
  select * into h from holdings where id = 'b2000000-0000-0000-0000-000000000301';
  if (r ->> 'ok')::boolean is not true or f3 <> 399 or h.quantity <> 10 then raise exception 'B2-34 FAILED: delete gave %, fund %, units %', r, f3, h.quantity; end if;
  update accounts set balance_as_of = null where id = 'b2000000-0000-0000-0000-0000000000f3';
  raise notice 'B2-34 ok: a trade from before the confirmed balance is fixed and deleted without moving the fund';
end $$;

-- B2-35: selling everything closes the holding at no value; buying again
-- reopens it; the opening entry stays while trades exist.
do $$
declare r jsonb; h holdings;
begin
  perform record_trade('b2000000-0000-0000-0000-000000000301', 'sell', '2026-10-05', 10, 150, 0, p_source => 'app', p_member_id => '22222222-2222-2222-2222-222222222222');
  select * into h from holdings where id = 'b2000000-0000-0000-0000-000000000301';
  if h.quantity <> 0 or h.value_aed <> 0 then raise exception 'B2-35 FAILED: sold out left % units worth %', h.quantity, h.value_aed; end if;
  perform record_trade('b2000000-0000-0000-0000-000000000301', 'buy', '2026-10-06', 3, 100, 0, p_source => 'app', p_member_id => '22222222-2222-2222-2222-222222222222');
  select * into h from holdings where id = 'b2000000-0000-0000-0000-000000000301';
  if h.quantity <> 3 or h.avg_price <> 100 then raise exception 'B2-35 FAILED: bought again gives % at %', h.quantity, h.avg_price; end if;
  r := delete_trade('b2000000-0000-0000-0000-000000000310', null, p_member_id => '22222222-2222-2222-2222-222222222222');
  if r ->> 'error' is distinct from 'opening_has_trades' then raise exception 'B2-35 FAILED: deleting the opening gave %', r; end if;
  raise notice 'B2-35 ok: sold out is worth 0, buying again reopens it, and the opening entry stays';
end $$;

-- B2-40 to B2-42: the fresh start for one member. A second member with a
-- dollar fund, two rupee funds and three holdings (one without an average);
-- the first member's holding must be left alone.
insert into household_members (id, household_id, display_name)
values ('22222222-2222-2222-2222-0000000000b2', '11111111-1111-1111-1111-111111111111', 'Partner');
insert into accounts (id, household_id, owner_member_id, name, type, currency, balance, is_shared) values
  ('b2000000-0000-0000-0000-0000000004f1', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-0000000000b2', 'Partner dollar funds', 'broker_funds', 'USD', 0, false),
  ('b2000000-0000-0000-0000-0000000004f2', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-0000000000b2', 'Partner rupee funds A', 'broker_funds', 'INR', 0, false),
  ('b2000000-0000-0000-0000-0000000004f3', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-0000000000b2', 'Partner rupee funds B', 'broker_funds', 'INR', 0, false);
insert into holdings (id, household_id, owner_member_id, is_shared, name, asset_class, currency, quantity, avg_price, current_price, value_aed) values
  ('b2000000-0000-0000-0000-000000000401', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-0000000000b2', false, 'GHI', 'us_equity', 'USD', 4.12345678, 50, 60, 908.64),
  ('b2000000-0000-0000-0000-000000000402', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-0000000000b2', false, 'JKL', 'india_equity', 'INR', 3, 1000, 1100, 140),
  ('b2000000-0000-0000-0000-000000000403', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-0000000000b2', false, 'Valued only', 'us_equity', 'USD', 2, null, null, 300),
  ('b2000000-0000-0000-0000-000000000404', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', false, 'Not theirs', 'us_equity', 'USD', 1, 10, 10, 36.73),
  ('b2000000-0000-0000-0000-000000000405', '11111111-1111-1111-1111-111111111111', null, true, 'Shared', 'us_equity', 'USD', 1, 10, 10, 36.73);

-- B2-40: opening entries for the member's holdings with units and an
-- average, and only theirs; nothing about the holdings themselves changes.
do $$
declare r jsonb; n int; h holdings;
begin
  r := open_trade_history('22222222-2222-2222-2222-0000000000b2', '2026-10-27');
  n := (r ->> 'opened')::int;
  if n <> 2 or (r ->> 'shared_left')::int <> 1 then raise exception 'B2-40 FAILED: %, expected 2 opened and the 1 shared holding reported', r; end if;
  select * into h from holdings where id = 'b2000000-0000-0000-0000-000000000401';
  if h.trades_version <> 1 or h.quantity <> 4.12345678 or h.avg_price <> 50 or h.value_aed <> 908.64 then
    raise exception 'B2-40 FAILED: the dollar holding is now % at %, worth %, version %', h.quantity, h.avg_price, h.value_aed, h.trades_version;
  end if;
  if not exists (select 1 from holding_trades where holding_id = h.id and kind = 'opening' and units = 4.12345678 and price = 50 and trade_date = '2026-10-27' and units_after = 4.12345678) then
    raise exception 'B2-40 FAILED: the opening entry does not match the holding';
  end if;
  if (select trades_version from holdings where id = 'b2000000-0000-0000-0000-000000000403') <> 0
     or (select trades_version from holdings where id = 'b2000000-0000-0000-0000-000000000404') <> 0
     or exists (select 1 from holding_trades where holding_id in ('b2000000-0000-0000-0000-000000000403', 'b2000000-0000-0000-0000-000000000404')) then
    raise exception 'B2-40 FAILED: a holding without an average, or another member''s, was opened';
  end if;
  raise notice 'B2-40 ok: two opening entries, the holdings unchanged, the rest untouched';
end $$;

-- B2-41: running it again makes nothing.
do $$
declare n int;
begin
  n := (open_trade_history('22222222-2222-2222-2222-0000000000b2', '2026-10-28') ->> 'opened')::int;
  if n <> 0 or (select count(*) from holding_trades where holding_id = 'b2000000-0000-0000-0000-000000000401') <> 1 then
    raise exception 'B2-41 FAILED: a second run made % entries', n;
  end if;
  raise notice 'B2-41 ok: the fresh start happens once';
end $$;

-- B2-42: a holding is linked to the member's one fund in its currency; with
-- two, it waits for the member to choose.
do $$
begin
  if (select funds_account_id from holdings where id = 'b2000000-0000-0000-0000-000000000401') is distinct from 'b2000000-0000-0000-0000-0000000004f1' then
    raise exception 'B2-42 FAILED: the dollar holding was not linked to the one dollar fund';
  end if;
  if (select funds_account_id from holdings where id = 'b2000000-0000-0000-0000-000000000402') is not null then
    raise exception 'B2-42 FAILED: a rupee holding was linked although there are two rupee funds';
  end if;
  raise notice 'B2-42 ok: linked to the one fund in its currency, left alone with two';
end $$;

-- B2-50: the nightly price update writes a holding's value from its units as
-- they are when the price is written, so a trade in between is never undone.
do $$
declare v numeric; h holdings; hist numeric;
begin
  update accounts set balance = 1000, balance_as_of = null where id = 'b2000000-0000-0000-0000-0000000000f1';
  perform set_config('rokda.trade_replay', 'on', true);
  insert into holdings (id, household_id, owner_member_id, is_shared, name, asset_class, currency, quantity, avg_price, current_price, value_aed, funds_account_id, trades_version, price_fetch_error, price_fetch_fail_count)
  values ('b2000000-0000-0000-0000-000000000501', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', false, 'MNO', 'us_equity', 'USD', 10, 100, 100, 3672.5, 'b2000000-0000-0000-0000-0000000000f1', 1, 'old error', 2);
  perform set_config('rokda.trade_replay', '', true);
  insert into holding_trades (household_id, holding_id, member_id, kind, trade_date, units, price, source)
  values ('11111111-1111-1111-1111-111111111111', 'b2000000-0000-0000-0000-000000000501', '22222222-2222-2222-2222-222222222222', 'opening', '2026-10-01', 10, 100, 'opening');
  v := set_holding_price('b2000000-0000-0000-0000-000000000501', 150, 1.5, '2026-10-26 20:00+00', now());
  select * into h from holdings where id = 'b2000000-0000-0000-0000-000000000501';
  select value_aed into hist from holding_value_history where holding_id = h.id and as_of = household_today();
  if v <> 5508.75 or h.value_aed <> 5508.75 or hist <> 5508.75 or h.current_price <> 150 or h.day_change_pct <> 1.5
     or h.priced_at <> '2026-10-26 20:00+00' or h.price_fetch_error is not null or h.price_fetch_fail_count <> 0 then
    raise exception 'B2-50 FAILED: value %, holding %', v, row_to_json(h);
  end if;
  perform record_trade('b2000000-0000-0000-0000-000000000501', 'buy', '2026-10-02', 5, 150, 0, p_source => 'app', p_member_id => '22222222-2222-2222-2222-222222222222');
  v := set_holding_price('b2000000-0000-0000-0000-000000000501', 160, null, null, now());
  select * into h from holdings where id = 'b2000000-0000-0000-0000-000000000501';
  if v <> 8814.00 or h.value_aed <> 8814.00 or h.priced_at <> '2026-10-26 20:00+00' then
    raise exception 'B2-50 FAILED: after the trade the value is % (priced at %)', v, h.priced_at;
  end if;
  raise notice 'B2-50 ok: the price update values the units as they are now, and keeps the quote time when none is given';
end $$;

-- Review fixes (SHR-368). B2-16 (C1): the replay keeps units at eight
-- decimals at every step, so after a split by a fractional ratio the units
-- shown are the units that can be sold.
do $$
declare r jsonb;
begin
  r := private.replay_entries('[
    {"id":"o","kind":"opening","trade_date":"2026-10-01","created_at":"2026-10-01T08:00:00Z","units":3.12345678,"price":10,"fees":0},
    {"id":"x","kind":"split","trade_date":"2026-10-02","created_at":"2026-10-02T08:00:00Z","units":0.1,"price":null,"fees":0},
    {"id":"s","kind":"sell","trade_date":"2026-10-03","created_at":"2026-10-03T08:00:00Z","units":0.31234568,"price":100,"fees":0}
  ]'::jsonb, false);
  if (r ->> 'ok')::boolean is not true or (r ->> 'units')::numeric <> 0 then raise exception 'B2-16 FAILED: %', r; end if;
  raise notice 'B2-16 ok: after a reverse split the units shown can all be sold';
end $$;

-- B2-17 (I2): brokerage goes into the average by the fund each buy went
-- through, not by the holding's default.
do $$
declare r jsonb;
begin
  r := private.replay_entries('[
    {"id":"o","kind":"opening","trade_date":"2026-10-01","created_at":"2026-10-01T08:00:00Z","units":10,"price":100,"fees":0},
    {"id":"b","kind":"buy","trade_date":"2026-10-02","created_at":"2026-10-02T08:00:00Z","units":5,"price":130,"fees":1,"brokerage_in_average":true}
  ]'::jsonb, false);
  if (r ->> 'avg')::numeric <> 110.066667 then raise exception 'B2-17 FAILED: average %', r ->> 'avg'; end if;
  raise notice 'B2-17 ok: a buy through a fund that averages brokerage includes it';
end $$;

-- B2-36 (C1): a sale of the exact units after a reverse split closes the
-- holding; inputs are rounded to what is stored, so nothing is saved with
-- figures the replay cannot reproduce, and the fund preview is in fils.
do $$
declare r jsonb; p jsonb; h holdings;
begin
  update accounts set balance = 1000, balance_as_of = null where id = 'b2000000-0000-0000-0000-0000000000f1';
  perform set_config('rokda.trade_replay', 'on', true);
  insert into holdings (id, household_id, owner_member_id, is_shared, name, asset_class, currency, quantity, avg_price, current_price, value_aed, funds_account_id, trades_version)
  values ('b2000000-0000-0000-0000-000000000601', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', false, 'PQR', 'us_equity', 'USD', 3.12345678, 10, 100, 1147.08, 'b2000000-0000-0000-0000-0000000000f1', 1);
  perform set_config('rokda.trade_replay', '', true);
  insert into holding_trades (household_id, holding_id, member_id, kind, trade_date, units, price, source)
  values ('11111111-1111-1111-1111-111111111111', 'b2000000-0000-0000-0000-000000000601', '22222222-2222-2222-2222-222222222222', 'opening', '2026-10-01', 3.12345678, 10, 'opening');
  r := record_trade('b2000000-0000-0000-0000-000000000601', 'split', '2026-10-02', 0.1, null, p_source => 'bot', p_member_id => '22222222-2222-2222-2222-222222222222');
  select * into h from holdings where id = 'b2000000-0000-0000-0000-000000000601';
  if h.quantity <> 0.31234568 then raise exception 'B2-36 FAILED: after the split the holding shows %', h.quantity; end if;
  p := preview_trade('b2000000-0000-0000-0000-000000000601', 'sell', '2026-10-03', 0.312345678, 100.0000001, 0.00001, p_member_id => '22222222-2222-2222-2222-222222222222');
  if (p ->> 'funds_balance_after')::numeric <> round((p ->> 'funds_balance_after')::numeric, 2) then raise exception 'B2-36 FAILED: fund preview in more than fils: %', p; end if;
  r := record_trade('b2000000-0000-0000-0000-000000000601', 'sell', '2026-10-03', 0.312345678, 100.0000001, 0.00001, p_source => 'bot', p_member_id => '22222222-2222-2222-2222-222222222222');
  select * into h from holdings where id = 'b2000000-0000-0000-0000-000000000601';
  if (r ->> 'ok')::boolean is not true or h.quantity <> 0 or h.avg_price is null or h.value_aed <> 0
     or (select balance from accounts where id = 'b2000000-0000-0000-0000-0000000000f1') <> (p ->> 'funds_balance_after')::numeric then
    raise exception 'B2-36 FAILED: %, holding % at %, worth %', r, h.quantity, h.avg_price, h.value_aed;
  end if;
  r := record_trade('b2000000-0000-0000-0000-000000000601', 'buy', '2026-10-04', 0.000000001, 100, 0, p_source => 'bot', p_member_id => '22222222-2222-2222-2222-222222222222');
  if r ->> 'error' is distinct from 'bad_input' then raise exception 'B2-36 FAILED: a buy of less than a hundred-millionth of a unit gave %', r; end if;
  raise notice 'B2-36 ok: a reverse split then selling the units shown closes the holding, with the preview''s fund figure stored';
end $$;

-- B2-37 (I1): a fix that names no fund keeps the trade's own fund.
do $$
declare b jsonb; r jsonb;
begin
  b := record_trade('b2000000-0000-0000-0000-000000000201', 'buy', '2026-10-27', 1, 150, 0, p_funds_account_id => 'b2000000-0000-0000-0000-0000000000f3',
    p_source => 'app', p_member_id => '22222222-2222-2222-2222-222222222222');
  r := fix_trade((b ->> 'trade_id')::uuid, '2026-10-27', 1, 150, 2, 0, null, null, false, null, null, p_member_id => '22222222-2222-2222-2222-222222222222');
  if (r ->> 'ok')::boolean is not true or (select funds_account_id from holding_trades where id = (b ->> 'trade_id')::uuid) <> 'b2000000-0000-0000-0000-0000000000f3' then
    raise exception 'B2-37 FAILED: %, fund now %', r, (select funds_account_id from holding_trades where id = (b ->> 'trade_id')::uuid);
  end if;
  raise notice 'B2-37 ok: a fix that names no fund keeps the trade''s fund';
end $$;

-- B2-38 (I2): a buy through a fund that puts brokerage into the average
-- includes it, whatever the holding's default fund says.
do $$
declare h holdings;
begin
  insert into accounts (id, household_id, name, type, currency, balance, is_shared, brokerage_in_average)
  values ('b2000000-0000-0000-0000-0000000000f5', '11111111-1111-1111-1111-111111111111', 'Averaging fund', 'broker_funds', 'USD', 1000, false, true);
  perform set_config('rokda.trade_replay', 'on', true);
  insert into holdings (id, household_id, owner_member_id, is_shared, name, asset_class, currency, quantity, avg_price, current_price, value_aed, funds_account_id, trades_version)
  values ('b2000000-0000-0000-0000-000000000602', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', false, 'STU', 'us_equity', 'USD', 10, 100, 100, 3672.5, 'b2000000-0000-0000-0000-0000000000f1', 1);
  perform set_config('rokda.trade_replay', '', true);
  insert into holding_trades (household_id, holding_id, member_id, kind, trade_date, units, price, source)
  values ('11111111-1111-1111-1111-111111111111', 'b2000000-0000-0000-0000-000000000602', '22222222-2222-2222-2222-222222222222', 'opening', '2026-10-01', 10, 100, 'opening');
  perform record_trade('b2000000-0000-0000-0000-000000000602', 'buy', '2026-10-02', 5, 130, 1, p_funds_account_id => 'b2000000-0000-0000-0000-0000000000f5',
    p_source => 'app', p_member_id => '22222222-2222-2222-2222-222222222222');
  select * into h from holdings where id = 'b2000000-0000-0000-0000-000000000602';
  if h.avg_price <> 110.066667 then raise exception 'B2-38 FAILED: average %', h.avg_price; end if;
  raise notice 'B2-38 ok: brokerage in the average follows the fund the buy went through';
end $$;

-- B2-39 (I3): only a broker funds account can be a trade's fund.
do $$
declare r jsonb;
begin
  insert into accounts (id, household_id, name, type, currency, balance, is_shared)
  values ('b2000000-0000-0000-0000-0000000000c1', '11111111-1111-1111-1111-111111111111', 'Dollar card', 'credit_card', 'USD', 0, false);
  r := record_trade('b2000000-0000-0000-0000-000000000201', 'buy', '2026-10-27', 1, 150, 0, p_funds_account_id => 'b2000000-0000-0000-0000-0000000000c1',
    p_source => 'app', p_member_id => '22222222-2222-2222-2222-222222222222');
  if r ->> 'error' is distinct from 'not_broker_funds' then raise exception 'B2-39 FAILED: a card as the fund gave %', r; end if;
  begin
    insert into holding_trades (household_id, holding_id, member_id, kind, trade_date, units, price, funds_account_id, source)
    values ('11111111-1111-1111-1111-111111111111', 'b2000000-0000-0000-0000-000000000201', '22222222-2222-2222-2222-222222222222', 'buy', '2026-10-27', 1, 150, 'b2000000-0000-0000-0000-0000000000c1', 'app');
    raise exception 'B2-39 FAILED: a trade through a card was inserted';
  exception when check_violation then null;
  end;
  raise notice 'B2-39 ok: a card is refused as a trade''s fund';
end $$;

-- B2-08 (I4): a holding's version moves only with the replay, so it cannot be
-- reset to unlock its units or forged to pass the stale check.
do $$
begin
  begin
    update holdings set trades_version = 0 where id = 'b2000000-0000-0000-0000-000000000201';
    raise exception 'B2-08 FAILED: a traded holding''s version was reset by hand';
  exception when check_violation then null;
  end;
  begin
    update holdings set trades_version = trades_version + 5 where id = 'b2000000-0000-0000-0000-000000000202';
    raise exception 'B2-08 FAILED: a version was moved by hand';
  exception when check_violation then null;
  end;
  begin
    update holdings set trades_version = 1 where id = 'b2000000-0000-0000-0000-000000000404';
    raise exception 'B2-08 FAILED: an untraded holding was marked traded by hand';
  exception when check_violation then null;
  end;
  begin
    insert into holdings (id, household_id, owner_member_id, is_shared, name, asset_class, currency, quantity, avg_price, current_price, value_aed, trades_version)
    values ('b2000000-0000-0000-0000-000000000701', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', false, 'VWX', 'us_equity', 'USD', 1, 1, 1, 3.67, 1);
    raise exception 'B2-08 FAILED: a holding was created already marked traded';
  exception when check_violation then null;
  end;
  raise notice 'B2-08 ok: versions move only with the replay';
end $$;

-- B2-60 (M2): undoing a fresh start never lets a version come round again. A
-- confirmation shown at version 1, before the undo, must not apply to the
-- holding gone live a second time.
insert into household_members (id, household_id, display_name)
values ('22222222-2222-2222-2222-0000000000b6', '11111111-1111-1111-1111-111111111111', 'Third');
insert into holdings (id, household_id, owner_member_id, is_shared, name, asset_class, currency, quantity, avg_price, current_price, value_aed, funds_account_id)
values ('b2000000-0000-0000-0000-000000000801', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-0000000000b6', false, 'YZA', 'us_equity', 'USD', 5, 10, 10, 183.63, 'b2000000-0000-0000-0000-0000000000f1');
do $$
declare r jsonb; v int; opening uuid;
begin
  perform open_trade_history('22222222-2222-2222-2222-0000000000b6', '2026-10-20');
  select id into opening from holding_trades where holding_id = 'b2000000-0000-0000-0000-000000000801' and kind = 'opening';
  r := delete_trade(opening, null, '22222222-2222-2222-2222-0000000000b6');
  select trades_version into v from holdings where id = 'b2000000-0000-0000-0000-000000000801';
  if (r ->> 'ok')::boolean is not true or v <> -1 then raise exception 'B2-60 FAILED: undoing the fresh start gave %, version %', r, v; end if;
  update holdings set quantity = 6 where id = 'b2000000-0000-0000-0000-000000000801';
  perform open_trade_history('22222222-2222-2222-2222-0000000000b6', '2026-10-21');
  select trades_version into v from holdings where id = 'b2000000-0000-0000-0000-000000000801';
  if v <> 2 then raise exception 'B2-60 FAILED: going live again gave version %, expected 2', v; end if;
  r := record_trade('b2000000-0000-0000-0000-000000000801', 'buy', '2026-10-22', 1, 10, p_member_id => '22222222-2222-2222-2222-0000000000b6', p_expected_version => 1);
  if r ->> 'error' is distinct from 'stale' then raise exception 'B2-60 FAILED: a confirmation from before the undo gave %', r; end if;
  raise notice 'B2-60 ok: a version is never reused after a fresh start is undone';
end $$;

-- B2-61 (M3): a fund that is only a holding's usual fund can be deleted, and
-- the holding is left with none; a fund money moved through cannot.
insert into accounts (id, household_id, name, type, currency, balance, is_shared)
values ('b2000000-0000-0000-0000-0000000000f6', '11111111-1111-1111-1111-111111111111', 'Unused dollar fund', 'broker_funds', 'USD', 0, false);
insert into holdings (id, household_id, owner_member_id, is_shared, name, asset_class, currency, quantity, avg_price, current_price, value_aed, funds_account_id)
values ('b2000000-0000-0000-0000-000000000802', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', false, 'BCD', 'us_equity', 'USD', 1, 10, 10, 36.73, 'b2000000-0000-0000-0000-0000000000f6');
do $$
begin
  delete from accounts where id = 'b2000000-0000-0000-0000-0000000000f6';
  if (select funds_account_id from holdings where id = 'b2000000-0000-0000-0000-000000000802') is not null then
    raise exception 'B2-61 FAILED: the holding still points at the deleted fund';
  end if;
  begin
    delete from accounts where id = 'b2000000-0000-0000-0000-0000000000f1';
    raise exception 'B2-61 FAILED: a fund with trades through it was deleted';
  exception when foreign_key_violation then null;
  end;
  raise notice 'B2-61 ok: a fund that is only a default can go; one with trades cannot';
end $$;

rollback;
