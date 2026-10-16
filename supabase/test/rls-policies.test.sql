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

-- One household per Rokda. On an empty database the first signed-in user
-- founds it with create_household() and becomes its owner; after that nobody
-- founds another -- not the founder, and not a signed-in stranger. This has to
-- run before the fixtures below, because they are households too.
insert into auth.users (id, email) values
  ('0f000000-0000-0000-0000-00000000000f', 'founder@example.test'),
  ('0e000000-0000-0000-0000-00000000000e', 'latecomer@example.test');

set role authenticated;
set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '0f000000-0000-0000-0000-00000000000f';

do $$
declare founded uuid; n int;
begin
  founded := create_household('First household', 'Founder');
  if not is_household_owner(founded) then
    raise exception 'one-household FAILED: the founder does not own the household they founded';
  end if;
  select count(*) into n from household_members where household_id = founded;
  if n <> 1 then raise exception 'one-household FAILED: a new household started with % members, expected 1', n; end if;

  -- useHousehold() resolves one membership per user; a second would make
  -- which household you see arbitrary.
  begin
    perform create_household('Second household', 'Founder again');
    raise exception 'one-household FAILED: the founder created a second household';
  exception
    when unique_violation then null;
  end;
  raise notice 'one-household ok: the first sign-in founds the household, once';
end $$;

set request.jwt.claim.sub = '0e000000-0000-0000-0000-00000000000e';
do $$
begin
  begin
    perform create_household('Latecomer household', 'Latecomer');
    raise exception 'one-household FAILED: a second household was founded beside the first';
  exception
    when insufficient_privilege then null;
  end;

  -- Refused before its input is even looked at: blank names get the same
  -- answer, not a hint about which field was missing.
  begin
    perform create_household('', '');
    raise exception 'one-household FAILED: a refused caller''s blank input was validated before they were refused';
  exception
    when insufficient_privilege then null;
  end;
  raise notice 'one-household ok: once a household exists, a stranger cannot found another';
end $$;

-- Checked as the superuser, who sees every row: a refusal leaves nothing.
reset role;
reset request.jwt.claim.sub;
reset request.jwt.claim.role;
do $$
declare n int;
begin
  select count(*) into n from households;
  if n <> 1 then raise exception 'one-household FAILED: % households exist, expected the founder''s 1', n; end if;
  if exists (select 1 from household_members where user_id = '0e000000-0000-0000-0000-00000000000e') then
    raise exception 'one-household FAILED: a refused founding left a roster row behind';
  end if;
end $$;

-- The fixtures below build their own households.
delete from households;

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

-- Independence income: one row in the other household, to be reached for.
insert into independence_income (id, household_id, name, kind, amount) values
  ('f2000000-0000-0000-0000-000000000001', 'd2000000-0000-0000-0000-000000000002', 'Their rent', 'yearly', 36000);

-- Household notes: one in the other household, to be reached for.
insert into household_notes (id, household_id, title, body) values
  ('f3000000-0000-0000-0000-000000000001', 'd2000000-0000-0000-0000-000000000002', 'Their plan', 'Private');

-- Life plan ages: the other household's owner has theirs set.
insert into member_life (member_id, household_id, birth_year, life_expectancy) values
  ('e2000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-000000000002', 1980, 85);

-- Balance history and bot proposals: an account and a proposal in each
-- household. Opening each account records its first event.
insert into accounts (id, household_id, name, type, balance, is_shared) values
  ('f4000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'Our bank', 'checking', 100, true),
  ('f4000000-0000-0000-0000-000000000002', 'd2000000-0000-0000-0000-000000000002', 'Their bank', 'checking', 100, true);
insert into bot_proposals (id, household_id, member_id, kind, payload, chat_id) values
  ('f5000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-00000000000a', 'account_balances', '{"items": []}', 1),
  ('f5000000-0000-0000-0000-000000000002', 'd2000000-0000-0000-0000-000000000002', 'e2000000-0000-0000-0000-00000000000a', 'account_balances', '{"items": []}', 2);

-- Card statements: one in each household, on that household's account.
insert into statement_reconciliations (id, household_id, account_id, statement_date, period_start) values
  ('f6000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', '2026-09-28', '2026-08-29'),
  ('f6000000-0000-0000-0000-000000000002', 'd2000000-0000-0000-0000-000000000002', 'f4000000-0000-0000-0000-000000000002', '2026-09-28', '2026-08-29');

insert into backup_records (id, household_id, kind, result, done_on) values
  ('f7000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'export', 'passed', '2026-09-19'),
  ('f7000000-0000-0000-0000-000000000002', 'd2000000-0000-0000-0000-000000000002', 'export', 'passed', '2026-09-19');

-- A second account each, and a transfer in the other household.
insert into accounts (id, household_id, name, type, balance, is_shared) values
  ('f4000000-0000-0000-0000-000000000003', 'd1000000-0000-0000-0000-000000000001', 'Our savings', 'savings', 0, true),
  ('f4000000-0000-0000-0000-000000000004', 'd2000000-0000-0000-0000-000000000002', 'Their savings', 'savings', 0, true);
do $$ begin perform record_transfer('d2000000-0000-0000-0000-000000000002', 'f4000000-0000-0000-0000-000000000002', 'f4000000-0000-0000-0000-000000000004', 50, '2026-10-01'); end $$;
-- A purchase in the other household, which no member here may refund.
insert into transactions (id, household_id, account_id, amount, kind, occurred_at, is_shared) values
  ('f8000000-0000-0000-0000-000000000002', 'd2000000-0000-0000-0000-000000000002', 'f4000000-0000-0000-0000-000000000002', -70, 'expense', '2026-10-01', true);
-- Opening a balance records it; these two aren't part of the balance-history
-- case below, which counts its own.
delete from account_balance_events where account_id in ('f4000000-0000-0000-0000-000000000003', 'f4000000-0000-0000-0000-000000000004');

set role authenticated;
set request.jwt.claim.role = 'authenticated';

-- ---------------------------------------------------------------- non-owner
set request.jwt.claim.sub = '0b000000-0000-0000-0000-00000000000b';

-- A holding's cost is worked out as the member who saves it, from their own
-- household's rupee rate, and follows that rate when the member changes it.
do $$
declare inv numeric;
begin
  update households set inr_per_aed = 25 where id = 'd1000000-0000-0000-0000-000000000001';
  insert into holdings (id, household_id, name, asset_class, currency, quantity, avg_price, value_aed)
  values ('f6000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'Rupee share', 'india_equity', 'INR', 10, 1000, 0);
  select invested_value_aed into inv from holdings where id = 'f6000000-0000-0000-0000-000000000001';
  if inv is distinct from 400.00 then raise exception 'holding cost FAILED: as a member the rupee cost is %, expected 400.00', inv; end if;
  update households set inr_per_aed = 20 where id = 'd1000000-0000-0000-0000-000000000001';
  select invested_value_aed into inv from holdings where id = 'f6000000-0000-0000-0000-000000000001';
  if inv is distinct from 500.00 then raise exception 'holding cost FAILED: as a member the cost did not follow the rate (got %)', inv; end if;
  delete from holdings where id = 'f6000000-0000-0000-0000-000000000001';
  raise notice 'holding cost ok: worked out and re-valued as a signed-in member';
end $$;

-- Independence income is household data like any other planning row: a
-- member reads and writes their own household's, and cannot see, add to or
-- move a row into another household.
do $$
declare n int;
begin
  insert into independence_income (household_id, name, kind, amount, starts_after_years, lasts_years)
  values ('d1000000-0000-0000-0000-000000000001', 'Flat rent', 'yearly', 48000, 0, null);
  select count(*) into n from independence_income;
  if n <> 1 then raise exception 'independence_income FAILED: a member sees % rows, expected only their own 1', n; end if;

  begin
    insert into independence_income (household_id, name, kind, amount)
    values ('d2000000-0000-0000-0000-000000000002', 'Planted', 'lump_sum', 1000);
    raise exception 'independence_income FAILED: a member wrote into another household';
  exception
    when insufficient_privilege then null;
  end;

  begin
    update independence_income set household_id = 'd2000000-0000-0000-0000-000000000002' where name = 'Flat rent';
    raise exception 'independence_income FAILED: a member moved a row into another household';
  exception
    when insufficient_privilege then null;
  end;

  update independence_income set amount = 1 where id = 'f2000000-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'independence_income FAILED: a member updated another household''s row'; end if;

  delete from independence_income where name = 'Flat rent';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'independence_income FAILED: a member could not delete their own row'; end if;
  raise notice 'independence_income ok: own household only, in every direction';
end $$;

-- Life plan ages: a member sets them for anyone in their own household --
-- including a placeholder with no login, which is how a partner is often
-- tracked -- and cannot see or reach the other household's.
do $$
declare n int;
begin
  insert into member_life (member_id, household_id, birth_year, life_expectancy) values
    ('e1000000-0000-0000-0000-00000000000b', 'd1000000-0000-0000-0000-000000000001', 1994, 80),
    ('e1000000-0000-0000-0000-00000000000c', 'd1000000-0000-0000-0000-000000000001', 1994, 85);
  select count(*) into n from member_life;
  if n <> 2 then raise exception 'member_life FAILED: a member sees % rows, expected their own household''s 2', n; end if;

  begin
    insert into member_life (member_id, household_id, birth_year, life_expectancy)
    values ('e2000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-000000000002', 1990, 90);
    raise exception 'member_life FAILED: a member wrote into another household';
  exception
    when insufficient_privilege then null;
  end;

  update member_life set life_expectancy = 99 where member_id = 'e2000000-0000-0000-0000-00000000000a';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'member_life FAILED: a member updated another household''s row'; end if;

  update member_life set life_expectancy = 82 where member_id = 'e1000000-0000-0000-0000-00000000000c';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'member_life FAILED: a member could not update their household''s placeholder'; end if;
  raise notice 'member_life ok: own household only, placeholders included';
end $$;

-- Household notes: the plan in words is as private as the figures.
do $$
declare n int;
begin
  insert into household_notes (household_id, title, body) values ('d1000000-0000-0000-0000-000000000001', 'Our plan', 'Rent is shared');
  select count(*) into n from household_notes;
  if n <> 1 then raise exception 'household_notes FAILED: a member sees % notes, expected only their own 1', n; end if;
  begin
    insert into household_notes (household_id, title) values ('d2000000-0000-0000-0000-000000000002', 'Planted');
    raise exception 'household_notes FAILED: a member wrote into another household';
  exception
    when insufficient_privilege then null;
  end;
  begin
    update household_notes set household_id = 'd2000000-0000-0000-0000-000000000002' where title = 'Our plan';
    raise exception 'household_notes FAILED: a member moved a note into another household';
  exception
    when insufficient_privilege then null;
  end;
  update household_notes set body = 'x' where id = 'f3000000-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'household_notes FAILED: a member edited another household''s note'; end if;
  delete from household_notes where title = 'Our plan';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'household_notes FAILED: a member could not delete their own note'; end if;
  raise notice 'household_notes ok: own household only, in every direction';
end $$;

-- Balance history: a member reads their own household's, and a change they
-- make in the app is recorded as theirs. Nobody writes or edits the history
-- through the API; the trigger is its only writer.
do $$
declare n int; e record;
begin
  select count(*) into n from account_balance_events;
  if n <> 1 then raise exception 'balance history FAILED: a member sees % events, expected their household''s 1', n; end if;

  update accounts set balance = 150 where id = 'f4000000-0000-0000-0000-000000000001';
  select * into e from account_balance_events where account_id = 'f4000000-0000-0000-0000-000000000001' order by id desc limit 1;
  if e.source <> 'app' or e.member_id is distinct from 'e1000000-0000-0000-0000-00000000000b'
     or e.old_balance <> 100 or e.new_balance <> 150 then
    raise exception 'balance history FAILED: a member''s change was recorded as %', row_to_json(e);
  end if;

  begin
    insert into account_balance_events (household_id, account_id, new_balance, source)
    values ('d1000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', 1, 'app');
    raise exception 'balance history FAILED: a member wrote a history row';
  exception
    when insufficient_privilege then null;
  end;
  update account_balance_events set new_balance = 1;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'balance history FAILED: a member edited % history rows', n; end if;
  delete from account_balance_events;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'balance history FAILED: a member deleted % history rows', n; end if;
  raise notice 'balance history ok: own household only, read-only, and a member''s change is theirs';
end $$;

-- Bot proposals: a member sees their household's, and only the bot decides
-- one. apply_bot_proposal() is not callable from the API at all.
do $$
declare n int;
begin
  select count(*) into n from bot_proposals;
  if n <> 1 then raise exception 'bot proposals FAILED: a member sees % proposals, expected their household''s 1', n; end if;

  begin
    insert into bot_proposals (household_id, member_id, kind, payload, chat_id)
    values ('d1000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-00000000000b', 'account_balances', '{"items": []}', 1);
    raise exception 'bot proposals FAILED: a member created a proposal';
  exception
    when insufficient_privilege then null;
  end;
  update bot_proposals set status = 'applied', decided_at = now();
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'bot proposals FAILED: a member decided % proposals', n; end if;

  begin
    perform apply_bot_proposal('f5000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-00000000000a');
    raise exception 'bot proposals FAILED: a member applied a proposal through the API';
  exception
    when insufficient_privilege then null;
  end;
  raise notice 'bot proposals ok: own household only, read-only, applied only by the bot';
end $$;

-- Card statements: a member sees and marks their own household's, never
-- another's, and cannot delete one. Only the bot reads merchant history
-- through merchant_category_counts().
do $$
declare n int;
begin
  select count(*) into n from statement_reconciliations;
  if n <> 1 then raise exception 'statements FAILED: a member sees % statements, expected their household''s 1', n; end if;

  update statement_reconciliations set status = 'confirmed', closed_at = now(), closed_by_member_id = 'e1000000-0000-0000-0000-00000000000b';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'statements FAILED: a member marked % of their statements done, expected 1', n; end if;
  update statement_reconciliations set status = 'confirmed', closed_at = now() where id = 'f6000000-0000-0000-0000-000000000002';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'statements FAILED: a member marked another household''s statement done'; end if;

  insert into statement_reconciliations (household_id, account_id, statement_date, period_start, status, closed_at)
  values ('d1000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', '2026-08-28', '2026-07-29', 'confirmed', now());
  begin
    insert into statement_reconciliations (household_id, account_id, statement_date, period_start)
    values ('d2000000-0000-0000-0000-000000000002', 'f4000000-0000-0000-0000-000000000002', '2026-08-28', '2026-07-29');
    raise exception 'statements FAILED: a member recorded a statement in another household';
  exception
    when insufficient_privilege then null;
  end;

  delete from statement_reconciliations;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'statements FAILED: a member deleted % statements', n; end if;

  begin
    perform merchant_category_counts('d1000000-0000-0000-0000-000000000001');
    raise exception 'statements FAILED: a member read merchant history through the bot''s function';
  exception
    when insufficient_privilege then null;
  end;
  raise notice 'statements ok: own household only, marked done by a member, never deleted; merchant history is the bot''s';
end $$;

-- Backup records: a member reads and adds their own household's, as
-- themselves whatever they send, and can neither change nor remove one.
do $$
declare n int; who uuid;
begin
  select count(*) into n from backup_records;
  if n <> 1 then raise exception 'backups FAILED: a member sees % backup records, expected their household''s 1', n; end if;

  insert into backup_records (id, household_id, kind, result, done_on, recorded_by)
  values ('f7000000-0000-0000-0000-000000000003', 'd1000000-0000-0000-0000-000000000001', 'restore_drill', 'passed', '2026-10-01', 'e1000000-0000-0000-0000-00000000000a');
  select recorded_by into who from backup_records where id = 'f7000000-0000-0000-0000-000000000003';
  if who is distinct from 'e1000000-0000-0000-0000-00000000000b' then
    raise exception 'backups FAILED: a record was attributed to % rather than the member who made it', who;
  end if;

  begin
    insert into backup_records (household_id, kind, result, done_on) values ('d2000000-0000-0000-0000-000000000002', 'export', 'passed', '2026-10-01');
    raise exception 'backups FAILED: a member recorded a backup for another household';
  exception
    when insufficient_privilege then null;
  end;

  update backup_records set result = 'failed';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'backups FAILED: a member changed % backup records', n; end if;
  delete from backup_records;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'backups FAILED: a member deleted % backup records', n; end if;
  raise notice 'backups ok: own household only, recorded as the caller, never changed or removed';
end $$;

-- Transfers: a member records, edits, unlinks and deletes their own
-- household's, and can neither see nor touch another household's.
do $$
declare
  n int;
  made jsonb;
  theirs uuid;
  their_tx uuid;
  who uuid;
begin
  select count(*) into n from transaction_links;
  if n <> 0 then raise exception 'transfers FAILED: a member sees % of another household''s transfer links', n; end if;
  select id, from_transaction_id into theirs, their_tx from transaction_links limit 1;

  made := record_transfer('d1000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000003', 120, '2026-10-02');
  select count(*) into n from transaction_links;
  if n <> 1 then raise exception 'transfers FAILED: a member''s own transfer is not visible to them'; end if;
  select created_by into who from transaction_links where id = (made ->> 'link_id')::uuid;
  if who is distinct from 'e1000000-0000-0000-0000-00000000000b' then
    raise exception 'transfers FAILED: the link was attributed to % rather than the member who made it', who;
  end if;
  perform update_transfer((made ->> 'link_id')::uuid, 130, '2026-10-02');
  perform unlink_transfer((made ->> 'link_id')::uuid);
  perform link_transfer((made ->> 'from_transaction_id')::uuid, (made ->> 'to_transaction_id')::uuid);

  begin
    perform record_transfer('d2000000-0000-0000-0000-000000000002', 'f4000000-0000-0000-0000-000000000002', 'f4000000-0000-0000-0000-000000000004', 10, '2026-10-02');
    raise exception 'transfers FAILED: a member recorded a transfer in another household';
  exception when insufficient_privilege then null;
  end;
  begin
    perform record_transfer('d1000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000002', 10, '2026-10-02');
    raise exception 'transfers FAILED: a member moved money to another household''s account';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into transaction_links (household_id, kind, from_transaction_id, to_transaction_id)
    values ('d2000000-0000-0000-0000-000000000002', 'transfer', (made ->> 'from_transaction_id')::uuid, (made ->> 'to_transaction_id')::uuid);
    raise exception 'transfers FAILED: a member wrote a link into another household';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;

  select id into theirs from transaction_links where household_id = 'd2000000-0000-0000-0000-000000000002';
  if theirs is not null then raise exception 'transfers FAILED: another household''s link was readable'; end if;

  select id into theirs from transaction_links where from_transaction_id = (made ->> 'from_transaction_id')::uuid;
  perform delete_transfer(theirs);
  select count(*) into n from transactions where id in ((made ->> 'from_transaction_id')::uuid, (made ->> 'to_transaction_id')::uuid);
  if n <> 0 then raise exception 'transfers FAILED: deleting a transfer left % of its sides', n; end if;
  raise notice 'transfers ok: own household only; record, edit, unlink, link and delete as a member';
end $$;

-- Splits: a member splits their own household's transactions, and can't see,
-- write or use another household's lines or categories.
do $$
declare
  n int;
  ours uuid;
  cat_a uuid;
  cat_b uuid;
  their_cat uuid;
begin
  select count(*) into n from transaction_splits;
  if n <> 0 then raise exception 'splits FAILED: a member sees % of another household''s split lines', n; end if;

  insert into categories (household_id, name, kind) values ('d1000000-0000-0000-0000-000000000001', 'Our split A', 'expense') returning id into cat_a;
  insert into categories (household_id, name, kind) values ('d1000000-0000-0000-0000-000000000001', 'Our split B', 'expense') returning id into cat_b;
  insert into transactions (household_id, account_id, amount, kind, occurred_at, is_shared)
  values ('d1000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', -90, 'expense', '2026-10-03', true)
  returning id into ours;

  perform split_transaction(ours, jsonb_build_array(jsonb_build_object('category_id', cat_a, 'amount', 60), jsonb_build_object('category_id', cat_b, 'amount', 30)));
  select count(*) into n from transaction_splits where transaction_id = ours;
  if n <> 2 then raise exception 'splits FAILED: a member could not split their own transaction'; end if;

  select id into their_cat from categories where household_id = 'd2000000-0000-0000-0000-000000000002' limit 1;
  if their_cat is not null then raise exception 'splits FAILED: another household''s category was readable'; end if;
  begin
    perform split_transaction(ours, jsonb_build_array(jsonb_build_object('category_id', cat_a, 'amount', 60), jsonb_build_object('category_id', 'c9000000-0000-0000-0000-000000000009', 'amount', 30)));
    raise exception 'splits FAILED: a line was filed under a category outside the household';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into transaction_splits (household_id, transaction_id, category_id, amount)
    values ('d2000000-0000-0000-0000-000000000002', ours, cat_a, -1);
    raise exception 'splits FAILED: a member wrote a line into another household';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;

  perform unsplit_transaction(ours, cat_a);
  delete from transactions where id = ours;
  delete from categories where id in (cat_a, cat_b);
  raise notice 'splits ok: own household only; split and unsplit as a member';
end $$;

-- Refund links: a member links a refund to their own household's purchase,
-- and can neither link to another household's nor see its links.
do $$
declare
  n int;
  purchase uuid;
  refund uuid;
  made jsonb;
begin
  insert into transactions (household_id, account_id, amount, kind, occurred_at, is_shared)
  values ('d1000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', -80, 'expense', '2026-10-03', true)
  returning id into purchase;
  insert into transactions (household_id, account_id, amount, kind, occurred_at, is_shared)
  values ('d1000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', 30, 'refund', '2026-10-05', true)
  returning id into refund;

  made := link_refund(purchase, refund);
  select count(*) into n from transaction_links where kind = 'refund';
  if n <> 1 then raise exception 'refund links FAILED: a member could not link their own refund'; end if;
  perform unlink_refund((made ->> 'link_id')::uuid);

  begin
    perform link_refund('f8000000-0000-0000-0000-000000000002', refund);
    raise exception 'refund links FAILED: a refund was linked to another household''s purchase';
  exception when no_data_found then null;
  end;
  begin
    insert into transaction_links (household_id, kind, from_transaction_id, to_transaction_id)
    values ('d2000000-0000-0000-0000-000000000002', 'refund', 'f8000000-0000-0000-0000-000000000002', refund);
    raise exception 'refund links FAILED: a member wrote a refund link into another household';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;

  delete from transactions where id in (purchase, refund);
  raise notice 'refund links ok: own household only; link and unlink as a member';
end $$;

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

-- A member who sets the rupee rate re-values every rupee account in the
-- household, the owner's included. The re-valuation runs as them: it needs
-- members to be able to update every account in their household, and to
-- execute household_today(), which the account trigger calls.
do $$
declare aed numeric;
begin
  insert into accounts (id, household_id, name, type, currency, balance, is_shared, owner_member_id)
  values ('f1000000-0000-0000-0000-0000000000c1', 'd1000000-0000-0000-0000-000000000001', 'Owner rupee account', 'savings', 'INR', 50000, false, 'e1000000-0000-0000-0000-00000000000a');
  update households set inr_per_aed = 20 where id = 'd1000000-0000-0000-0000-000000000001';
  select balance_aed into aed from accounts where id = 'f1000000-0000-0000-0000-0000000000c1';
  if aed is distinct from 2500 then
    raise exception 'rupee rate FAILED: a member''s new rate left the owner''s rupee account at %', aed;
  end if;
  raise notice 'rupee rate ok: a member''s new rate re-values every rupee account in the household';
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

-- QA pass 3 P1: bootstrap. Closing the self-join clause removed the only route
-- by which a household could be created, and create_household() replaced it
-- -- for the first sign-in on an empty database only (one household per
-- Rokda; that path is proven at the top of this file). Here, with households
-- already in place, a signed-in stranger has no way in at all.
reset role;
insert into auth.users (id, email) values
  ('0c000000-0000-0000-0000-00000000000c', 'newcomer@example.test');

set role authenticated;
set request.jwt.claim.sub = '0c000000-0000-0000-0000-00000000000c';

do $$
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

  -- Nor found a household of their own beside this one.
  begin
    perform create_household('Newcomer household', 'Newcomer');
    raise exception 'QA-P1 FAILED: a stranger founded a second household';
  exception
    when insufficient_privilege then null;
  end;

  if is_household_member('d1000000-0000-0000-0000-000000000001') then
    raise exception 'QA-P1 FAILED: a refused stranger became a member of an existing household';
  end if;

  raise notice 'QA-P1 ok: a stranger can neither join a household nor found another';
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

  -- The membership helper must stay callable by a signed-in user: the RLS
  -- policies that use it (private.is_household_member) are evaluated as the
  -- caller, and a function body reaches it by name through the public
  -- wrapper. Revoking either from authenticated would take them down.
  perform is_household_member('d1000000-0000-0000-0000-000000000001');
  perform private.is_household_member('d1000000-0000-0000-0000-000000000001');
  raise notice 'QA-§10 ok: trigger helpers are not RPCs; the membership helper still is';
end $$;

-- The membership helpers now live in private (private_membership_helpers).
-- Every test above already ran through them, because a policy follows its
-- function by OID; this states it outright, as a signed-in member: the
-- policies still show exactly one household, the definer functions answer for
-- the caller, the public wrappers agree with them, and the role guard -- which
-- calls is_household_owner() by name -- still refuses self-promotion.
-- e1...000b handed ownership back to e1...000a in the QA #3 block above, so
-- 000b is a plain member here.
set request.jwt.claim.sub = '0b000000-0000-0000-0000-00000000000b';
do $$
declare n int;
begin
  select count(*) into n from households;
  if n <> 1 then raise exception 'helpers FAILED: a member sees % households, expected their own 1', n; end if;

  select count(*) into n from household_members where household_id = 'd2000000-0000-0000-0000-000000000002';
  if n <> 0 then raise exception 'helpers FAILED: a member sees % rows of another household''s roster', n; end if;

  if not private.is_household_member('d1000000-0000-0000-0000-000000000001')
     or private.is_household_member('d2000000-0000-0000-0000-000000000002')
     or private.is_household_owner('d1000000-0000-0000-0000-000000000001') then
    raise exception 'helpers FAILED: the private helpers answer wrongly for a plain member';
  end if;

  if is_household_member('d1000000-0000-0000-0000-000000000001')
       is distinct from private.is_household_member('d1000000-0000-0000-0000-000000000001')
     or is_household_owner('d1000000-0000-0000-0000-000000000001')
       is distinct from private.is_household_owner('d1000000-0000-0000-0000-000000000001') then
    raise exception 'helpers FAILED: the public wrappers disagree with the functions they wrap';
  end if;

  begin
    update household_members set role = 'owner' where id = 'e1000000-0000-0000-0000-00000000000b';
    raise exception 'helpers FAILED: the role guard let a member promote themselves';
  exception
    when insufficient_privilege then null;
  end;
  raise notice 'helpers ok: policies, the private helpers, their wrappers and the role guard agree';
end $$;

-- The owner's side of the same: the wrapper and the function behind it both
-- say yes, and generate_telegram_link_code() -- the other function that calls
-- a helper by name -- still issues a code for their own household's member and
-- refuses one for another household's. Settings calls it as an RPC; on the
-- hosted project authenticated holds EXECUTE on it through Supabase's default
-- privileges, which a bare PostgreSQL does not have, so the grant is made here
-- the way the platform makes it (and rolled back with the rest).
reset role;
grant execute on function generate_telegram_link_code(uuid) to authenticated;
set role authenticated;
set request.jwt.claim.sub = '0a000000-0000-0000-0000-00000000000a';
do $$
declare code text;
begin
  if not (is_household_owner('d1000000-0000-0000-0000-000000000001')
          and private.is_household_owner('d1000000-0000-0000-0000-000000000001')) then
    raise exception 'helpers FAILED: the owner is not an owner through the helpers';
  end if;
  code := generate_telegram_link_code('e1000000-0000-0000-0000-00000000000a');
  if code is null or length(code) <> 32 then
    raise exception 'helpers FAILED: generate_telegram_link_code() did not issue a code (%)', code;
  end if;
  begin
    perform generate_telegram_link_code('e2000000-0000-0000-0000-00000000000a');
    raise exception 'helpers FAILED: a link code was issued for another household''s member';
  exception
    when insufficient_privilege then null;
  end;
  raise notice 'helpers ok: the owner check and the link code still resolve the helpers by name';
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
  -- Nor the definer function behind it, which anon cannot even name: it has
  -- no USAGE on private.
  begin
    perform private.is_household_member('d1000000-0000-0000-0000-000000000001');
    raise exception 'helpers FAILED: anon could execute private.is_household_member()';
  exception
    when insufficient_privilege then null;
  end;
  raise notice 'QA-§10 ok: anon cannot execute the membership helper, in public or in private';
end $$;
reset role;

-- The scheduler secret runs either nightly job; nobody calling the API as a
-- visitor or a signed-in member may read it.
set role anon;
do $$
begin
  begin
    perform get_scheduler_secret();
    raise exception 'scheduler secret FAILED: anon could read the scheduler secret';
  exception
    when insufficient_privilege then null;
  end;
end $$;
reset role;
set role authenticated;
do $$
begin
  begin
    perform get_scheduler_secret();
    raise exception 'scheduler secret FAILED: a signed-in member could read the scheduler secret';
  exception
    when insufficient_privilege then null;
  end;
  raise notice 'scheduler secret ok: neither anon nor a signed-in member can read it';
end $$;
reset role;

-- Two-step sign-in (SHR-312): a member who has an authenticator reads and
-- writes nothing of the household from a password-only (aal1) session, and
-- everything from one that has passed its code (aal2). A member with no
-- authenticator yet is not refused, so nobody is locked out before adding one.
reset role;
insert into auth.mfa_factors (user_id, status) values ('0b000000-0000-0000-0000-00000000000b', 'verified');
set role authenticated;
set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '0b000000-0000-0000-0000-00000000000b';
set request.jwt.claim.aal = 'aal1';
do $$
declare n int;
begin
  select count(*) into n from household_members;
  if n <> 0 then raise exception 'two-step FAILED: a password-only session read % roster rows', n; end if;
  select count(*) into n from accounts;
  if n <> 0 then raise exception 'two-step FAILED: a password-only session read % accounts', n; end if;
  select count(*) into n from household_notes;
  if n <> 0 then raise exception 'two-step FAILED: a password-only session read % notes', n; end if;
  begin
    insert into household_notes (household_id, title) values ('d1000000-0000-0000-0000-000000000001', 'Written without a code');
    raise exception 'two-step FAILED: a password-only session wrote a note';
  exception
    when insufficient_privilege then null;
  end;
  update accounts set name = 'Renamed without a code';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'two-step FAILED: a password-only session renamed % accounts', n; end if;

  perform set_config('request.jwt.claim.aal', 'aal2', true);
  select count(*) into n from accounts;
  if n = 0 then raise exception 'two-step FAILED: a session that passed its code read no accounts'; end if;
  insert into household_notes (household_id, title) values ('d1000000-0000-0000-0000-000000000001', 'Written with a code');
  raise notice 'two-step ok: a member with an authenticator needs a code for every read and write';
end $$;
set request.jwt.claim.aal = 'aal1';
set request.jwt.claim.sub = '0a000000-0000-0000-0000-00000000000a';
do $$
declare n int;
begin
  select count(*) into n from accounts;
  if n = 0 then raise exception 'two-step FAILED: a member with no authenticator yet was locked out'; end if;
  raise notice 'two-step ok: a member with no authenticator yet is not locked out';
end $$;
reset request.jwt.claim.aal;
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
