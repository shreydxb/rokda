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

rollback;
