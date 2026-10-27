#!/usr/bin/env bash
# Race conditions, which a single session structurally cannot find (SHR-238
# follow-on; "true concurrency" in every QA pass so far).
#
# supabase/test/*.test.sql run in ONE psql session. That proves constraints,
# policies and retry idempotency, and it cannot prove anything about two
# clients acting at the same instant -- the case where each transaction reads a
# snapshot taken before the other committed. This runs real concurrent psql
# sessions against a database built from supabase/migrations.
#
# Each race starts both sessions together, has them pause mid-transaction so
# the two genuinely overlap, and asserts on the state left behind.
#
#   PGHOST=/var/run/postgresql PGUSER=postgres scripts/verify-concurrency.sh
set -euo pipefail

ADMIN_DB="${PGDATABASE:-postgres}"
DB="rokda_concurrency_$$"
fail=0

psql -d "$ADMIN_DB" -v ON_ERROR_STOP=1 -q -c "create database \"$DB\";"
trap 'psql -d "$ADMIN_DB" -q -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true' EXIT

echo "verify-concurrency: building $DB from supabase/migrations"
psql -d "$DB" -v ON_ERROR_STOP=1 -q -f supabase/test/platform-shim.sql
for file in supabase/migrations/*.sql; do
  psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$file"
done

seed() {
  psql -d "$DB" -v ON_ERROR_STOP=1 -q <<'SQL'
set client_min_messages = warning;
truncate household_members, households, accounts, categories, transactions, intake cascade;
delete from auth.users;
insert into auth.users (id, email) values
  ('0a000000-0000-4000-8000-00000000000a', 'o1@example.test'),
  ('0b000000-0000-4000-8000-00000000000b', 'o2@example.test');
insert into households (id, name) values ('d1000000-0000-4000-8000-000000000001', 'Race household');
insert into household_members (id, household_id, user_id, display_name, role) values
  ('e1000000-0000-4000-8000-00000000000a', 'd1000000-0000-4000-8000-000000000001', '0a000000-0000-4000-8000-00000000000a', 'Owner one', 'owner'),
  ('e1000000-0000-4000-8000-00000000000b', 'd1000000-0000-4000-8000-000000000001', '0b000000-0000-4000-8000-00000000000b', 'Owner two', 'owner');
SQL
}

# Run a transaction that pauses before AND after its write, so two of them
# started together are guaranteed to overlap.
overlap() {
  psql -d "$DB" <<SQL >/dev/null 2>&1 || true
begin;
select pg_sleep(0.4);
$1
select pg_sleep(0.6);
commit;
SQL
}

check() { # name expected actual
  if [ "$2" = "$3" ]; then
    echo "  ok   $1 (owners=$3)"
  else
    echo "  FAIL $1 — expected owners=$2, got $3" >&2
    fail=1
  fi
}

echo "verify-concurrency: last owner, two sessions deleting different owners"
seed
overlap "delete from household_members where id='e1000000-0000-4000-8000-00000000000a';" &
overlap "delete from household_members where id='e1000000-0000-4000-8000-00000000000b';" &
wait
check "two concurrent owner deletes cannot empty the household" 1 \
  "$(psql -At -d "$DB" -c "select count(*) from household_members where role='owner'")"

echo "verify-concurrency: last owner, a demotion racing a delete"
seed
overlap "update household_members set role='member' where id='e1000000-0000-4000-8000-00000000000a';" &
overlap "delete from household_members where id='e1000000-0000-4000-8000-00000000000b';" &
wait
check "a demote racing a delete cannot empty the household" 1 \
  "$(psql -At -d "$DB" -c "select count(*) from household_members where role='owner'")"

echo "verify-concurrency: two sessions approving the same intake"
seed
psql -d "$DB" -v ON_ERROR_STOP=1 -q <<'SQL'
insert into accounts (id, household_id, name, type) values
  ('f1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'Current', 'checking');
insert into categories (id, household_id, name, kind) values
  ('c1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'Groceries', 'expense');
insert into intake (id, household_id, source, raw_text, parsed_amount, status, member_id) values
  ('a1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'telegram', 'spent 45', 45, 'pending', 'e1000000-0000-4000-8000-00000000000a');
SQL
APPROVE="select approve_intake('a1000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000001',45,'2026-09-14','expense','c1000000-0000-4000-8000-000000000001','AED','Coffee',true,'e1000000-0000-4000-8000-00000000000a');"
overlap "$APPROVE" &
overlap "$APPROVE" &
wait
txns=$(psql -At -d "$DB" -c "select count(*) from transactions")
if [ "$txns" = "1" ]; then
  echo "  ok   a double approval yields exactly one transaction (transactions=$txns)"
else
  echo "  FAIL a double approval yielded $txns transactions, expected 1" >&2
  fail=1
fi

echo "verify-concurrency: two deliveries of the same Telegram update (SHR-303)"
# Telegram retries a webhook it thinks failed, so the same update_id can arrive
# while the first delivery is still being processed. Exactly one may claim it;
# the other must be told it is busy -- never fresh, and never "completed",
# which would make the caller answer 200 and end Telegram's retries.
psql -d "$DB" -v ON_ERROR_STOP=1 -q <<'SQL'
set client_min_messages = warning;
create table if not exists race_claims (result text);
truncate race_claims;
delete from telegram_update_log;
SQL
CLAIM="insert into race_claims select claim_telegram_update(9100001);"
overlap "$CLAIM" &
overlap "$CLAIM" &
wait
outcome=$(psql -At -d "$DB" -c "select string_agg(result, ',' order by result) from race_claims")
if [ "$outcome" = "busy,claimed" ]; then
  echo "  ok   concurrent claims of one update: exactly one claimed ($outcome)"
else
  echo "  FAIL concurrent claims of one update gave '$outcome', expected 'busy,claimed'" >&2
  fail=1
fi

echo "verify-concurrency: two first sign-ins founding the household at once"
# create_household() founds the household only on an empty database. Two
# callers racing there would each see no household and found one apiece,
# without the advisory lock that serialises them.
seed
psql -d "$DB" -v ON_ERROR_STOP=1 -q <<'SQL'
set client_min_messages = warning;
truncate household_members, households, accounts, categories, transactions, intake cascade;
SQL
overlap "set local request.jwt.claim.sub = '0a000000-0000-4000-8000-00000000000a'; select create_household('Race household', 'First');" &
overlap "set local request.jwt.claim.sub = '0b000000-0000-4000-8000-00000000000b'; select create_household('Race household', 'Second');" &
wait
founded=$(psql -At -d "$DB" -c "select count(*) from households")
if [ "$founded" = "1" ]; then
  echo "  ok   two concurrent foundings leave exactly one household (households=$founded)"
else
  echo "  FAIL two concurrent foundings left $founded households, expected 1" >&2
  fail=1
fi

echo "verify-concurrency: two confirmations of the same bot proposal"
# A "yes" and a thumbs-up on the same message, or a "yes" Telegram redelivers,
# can reach apply_bot_proposal() at the same instant. The row lock on the
# proposal makes the second wait and then find it applied: one balance change,
# one history row.
seed
psql -d "$DB" -v ON_ERROR_STOP=1 -q <<'SQL'
set client_min_messages = warning;
insert into accounts (id, household_id, name, type, balance) values
  ('f1000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000001', 'Bank', 'checking', 100);
insert into bot_proposals (id, household_id, member_id, kind, payload, chat_id) values
  ('b1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-00000000000a', 'account_balances',
   '{"items": [{"account_id": "f1000000-0000-4000-8000-000000000002", "old_balance": 100, "new_balance": 250}]}', 1);
SQL
APPLY="select apply_bot_proposal('b1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-00000000000a');"
overlap "$APPLY" &
overlap "$APPLY" &
wait
# The stored result is what every later "yes" repeats, so it is checked too:
# without the proposal's row lock the balance still comes out right (the
# second session finds it changed and skips it), but the second session then
# overwrites the result with "skipped", and the member is told nothing saved.
applied=$(psql -At -d "$DB" -c "select (select balance from accounts where id = 'f1000000-0000-4000-8000-000000000002') || ',' || (select count(*) from account_balance_events where account_id = 'f1000000-0000-4000-8000-000000000002' and source = 'bot') || ',' || (select jsonb_array_length(result -> 'applied') || '/' || jsonb_array_length(result -> 'skipped') from bot_proposals where id = 'b1000000-0000-4000-8000-000000000001')")
if [ "$applied" = "250.00,1,1/0" ]; then
  echo "  ok   two concurrent confirmations apply the change once and record it once (balance,bot events,applied/skipped=$applied)"
else
  echo "  FAIL two concurrent confirmations gave balance,bot events,applied/skipped=$applied, expected 250.00,1,1/0" >&2
  fail=1
fi

# A household with a dollar broker fund of 1000 and one holding of 10 units at
# 100 bought through it, opened for trades.
seed_trades() {
  seed
  psql -d "$DB" -v ON_ERROR_STOP=1 -q <<'SQL' >/dev/null
set client_min_messages = warning;
select set_config('request.jwt.claim.role', 'service_role', false);
insert into accounts (id, household_id, name, type, currency, balance) values
  ('f1000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-000000000001', 'Broker funds', 'broker_funds', 'USD', 1000);
insert into holdings (id, household_id, owner_member_id, name, asset_class, currency, quantity, avg_price, current_price, value_aed, funds_account_id) values
  ('a1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-00000000000a', 'Share', 'us_equity', 'USD', 10, 100, 100, 3672.5, 'f1000000-0000-4000-8000-000000000003');
select open_trade_history('e1000000-0000-4000-8000-00000000000a', '2026-10-01');
SQL
}

echo "verify-concurrency: two deletes of the same sale"
# The app and the bot, or two taps on Delete, can delete one sale at the same
# instant. Both find the trade before either has locked its holding; the one
# that waits for the lock must then find it gone, or it reverses the sale's
# money a second time.
seed_trades
psql -d "$DB" -v ON_ERROR_STOP=1 -q <<'SQL' >/dev/null
select set_config('request.jwt.claim.role', 'service_role', false);
select record_trade('a1000000-0000-4000-8000-000000000001', 'sell', '2026-10-20', 5, 120, p_source => 'bot', p_member_id => 'e1000000-0000-4000-8000-00000000000a');
SQL
sale=$(psql -At -d "$DB" -c "select id from holding_trades where kind = 'sell'")
DELETE="select set_config('request.jwt.claim.role', 'service_role', true); select delete_trade('$sale', null, 'e1000000-0000-4000-8000-00000000000a');"
overlap "$DELETE" &
overlap "$DELETE" &
wait
deleted=$(psql -At -d "$DB" -c "select (select balance from accounts where id = 'f1000000-0000-4000-8000-000000000003') || ',' || (select quantity from holdings where id = 'a1000000-0000-4000-8000-000000000001') || ',' || (select count(*) from holding_trades)")
if [ "$deleted" = "1000.00,10.00000000,1" ]; then
  echo "  ok   two concurrent deletes of a sale reverse its money once (fund,units,trades left=$deleted)"
else
  echo "  FAIL two concurrent deletes of a sale gave fund,units,trades left=$deleted, expected 1000.00,10.00000000,1" >&2
  fail=1
fi

echo "verify-concurrency: a buy saved while the fund's balance is checked in"
# A member enters the fund's balance from the broker's screen, a figure that
# already includes a buy, while the bot saves that buy. Whichever commits
# second must see the other: the buy is either inside the checked-in balance
# or moves the fund, never both.
seed_trades
psql -d "$DB" <<'SQL' >/dev/null 2>&1 &
begin;
update accounts set balance = 500, balance_as_of = '2026-10-21 00:00+04' where id = 'f1000000-0000-4000-8000-000000000003';
select pg_sleep(1);
commit;
SQL
psql -d "$DB" <<'SQL' >/dev/null 2>&1 &
begin;
select pg_sleep(0.3);
select set_config('request.jwt.claim.role', 'service_role', true);
select record_trade('a1000000-0000-4000-8000-000000000001', 'buy', '2026-10-20', 5, 100, p_traded_at => '2026-10-20 10:00+04', p_source => 'bot', p_member_id => 'e1000000-0000-4000-8000-00000000000a');
commit;
SQL
wait
checked=$(psql -At -d "$DB" -c "select balance || ',' || (select quantity from holdings where id = 'a1000000-0000-4000-8000-000000000001') from accounts where id = 'f1000000-0000-4000-8000-000000000003'")
if [ "$checked" = "500.00,15.00000000" ]; then
  echo "  ok   a buy racing a balance check-in is counted once (fund,units=$checked)"
else
  echo "  FAIL a buy racing a balance check-in gave fund,units=$checked, expected 500.00,15.00000000" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "verify-concurrency: FAILED" >&2
  exit 1
fi
echo "verify-concurrency: ok"
