# Dividends, PR 1: records and feed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dividends the feeds find are attributed to their ex-dates at the units the trades say were held, on the ex-date's share basis, kept as `earned` (or `presumed` received for a bank destination), and re-worked when trades change. No receipts, bot messages or tab yet.

**Architecture:** One migration adds the reference tables (`dividend_events`, `dividend_splits`, `dividend_feed_state`), the household tables (`holding_dividends`, `dividend_special_parts`), two holding columns and one account column, and the functions. The feed writes through `record_dividend_fetch`, which normalises every amount to its ex-date's share basis from the stored splits. One function, `private.sync_holding_dividends`, makes, re-works, moves and flags a holding's rows. Both `earn_dividends()` (nightly) and a trigger on `holding_trades` (on every trade change) call it, always under the holding's row lock. A new Edge Function, `dividend-refresh`, fetches Yahoo for Indian shares and Alpha Vantage for US shares, records each response, then calls `earn_dividends()`.

**Tech Stack:** Postgres (Supabase), plpgsql, SQL tests run with psql; Deno Edge Function with recorded responses; React/Vitest for the two editor fields.

**Spec:** `docs/superpowers/specs/2026-11-02-dividends-design.md` (sections 2, 3, 4.1, 5.1–5.3; PR 1 row and scenarios marked 1 in section 8).

## Global Constraints

- The repository is public: fixtures, tests, docs and commits use generic symbols (`ABC`, `ABC.NS`, `XYZ`), round figures, and no household figures. Recorded responses are renamed to generic symbols before they are committed.
- Style: plain JS/JSX, TypeScript in Deno, SQL; single quotes in JS; comments explain why in full sentences, matching the files around them (`CLAUDE.md`).
- One migration for the PR: `supabase/migrations/20261102120000_dividends.sql`. It is not applied to production until the household says "apply and merge".
- Every new constraint and trigger gets a case in `supabase/test/migration-behaviour.test.sql`, named `D1-01` onwards. Every new table gets cases in `supabase/test/rls-policies.test.sql`.
- Types: units numeric(20,8); per-share amounts numeric(18,6); split ratios numeric(18,8); money numeric(16,4); rates numeric(5,2).
- Today is `public.household_today()` (Dubai). An ex-date has passed when `ex_date <= household_today()`. A trade's market day is `(traded_at at time zone <exchange zone>)::date` when `traded_at` is set, else `trade_date`. The exchange zone is `America/New_York` for a USD holding and `Asia/Kolkata` otherwise.
- Withholding defaults: `india_equity` 20.8, `us_equity` and `intl_equity` 30, every other class null.
- Presumed: a row `earned` whose destination is not a Broker funds account becomes `presumed` on `greatest(ex_date + 30, coalesce(pay_date, ex_date + 30))`, with `credited_on` that date and `credited_on_estimated = true`.
- Supersession window 15 days; possible-duplicate window 10 days; a sold share is followed for 365 days after its last sale, checked when its last success is over 7 days old.
- Alpha Vantage per run: at most 5 calls, 12 seconds apart, at most 4 of them `DIVIDENDS` when any `SPLITS` is due. A held US symbol is due `DIVIDENDS` when its last success is over 3 days old; `SPLITS` when flagged `needs_splits` or its last splits success is over 30 days old or never.
- Lock order in every writer: holdings (id order), then `holding_dividends` rows, then funds (spec 3.7). `private.sync_holding_dividends` must only run with the holding's row lock held.
- The SQL test run (after `pg_ctlcluster 16 main start`), as in `CLAUDE.md`:

```sh
export PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres
bash scripts/verify-migrations.sh
for db in rokda_behaviour rokda_rls; do
  psql -d postgres -q -c "drop database if exists $db" -c "create database $db"
  psql -d $db -q -v ON_ERROR_STOP=1 -f supabase/test/platform-shim.sql
  for f in supabase/migrations/*.sql; do psql -d $db -q -v ON_ERROR_STOP=1 -f "$f"; done
done
psql -d rokda_behaviour -v ON_ERROR_STOP=1 -f supabase/test/migration-behaviour.test.sql
psql -d rokda_rls -v ON_ERROR_STOP=1 -f supabase/test/rls-policies.test.sql
```

  A failing case raises `... FAILED: ...`; a passing one prints `NOTICE: ... ok`.

## Review Focus

1. **Existing trade tests with the new trigger.** Every existing `B2-*`/`B3-*` case inserts and fixes trades, and the trigger now runs on each one. With no events, it must be a no-op that never raises. Pinned in Task 5 by running the whole behaviour file.
2. **A holding with no `price_symbol`, or a commodity or mutual fund.** `sync_holding_dividends` and `dividend_symbols()` must skip it without error. Pinned in Task 3 (`D1-12`).
3. **A holding deleted with only its opening entry.** The cascade deletes its trades, and the trigger fires for a holding that is going away. It must return quietly. Pinned in Task 5 (`D1-17`).
4. **Yahoo returning `result: null` for a delisted symbol, or Alpha Vantage's `"Information"`/`"Note"` at HTTP 200.** These are failures that change no event, not empty successes that would unlist every event. Pinned in Task 6.
5. **A trade and the nightly run on the same holding at the same moment.** Neither deadlocks, and the rows are right afterwards. Pinned in Task 5 with a race in `scripts/verify-concurrency.sh`.

---

### Task 0: What the household provides (before Task 2, Step 3)

- [ ] **Step 1:** Ask the household to (a) claim a free Alpha Vantage key and add it as the Edge Function secret `ALPHAVANTAGE_API_KEY` (Supabase dashboard → Edge Functions → Secrets), never pasting it into the chat; and (b) open `https://www.alphavantage.co/query?function=DIVIDENDS&symbol=NVDA&apikey=<their key>` and paste the entries dated 2024 into the chat.
- [ ] **Step 2:** Record the answer. If the March 2024 entry reads `0.04`, Alpha Vantage gives amounts as paid on the ex-date (does not adjust); if `0.004`, it adjusts for the June 2024 10:1 split. The answer sets `private.source_adjusts_for_splits`; the fixture that pins it (Task 6) is synthetic.

### Task 1: Tables, columns and their guards

**Files:**
- Create: `supabase/migrations/20261102120000_dividends.sql`
- Test: `supabase/test/migration-behaviour.test.sql` (append), `supabase/test/rls-policies.test.sql` (append)

**Interfaces:**
- Produces:
  - `dividend_events` (spec 3.1): `id uuid pk`, `symbol`, `ex_date`, `amount numeric(18,6)`, `source_amount numeric(18,6)`, `source_factor numeric(18,8) default 1`, `source_fetched_on date`, `currency`, `pay_date`, `record_date`, `declared_on`, `source text check in ('alphavantage','yahoo')`, `first_seen_at`, `last_seen_at`, `superseded_by uuid references dividend_events`; unique `(symbol, ex_date)`.
  - `dividend_splits` (3.2): `symbol`, `effective_date`, `ratio numeric(18,8) check > 0`, `source`, `first_seen_at`, `last_seen_at`; pk `(symbol, effective_date)`.
  - `dividend_feed_state` (3.4): pk `(symbol, provider, kind)`, `kind in ('dividends','splits')`, `last_attempt_at`, `last_success_at`, `last_failure_at`, `fail_count int default 0`, `last_error`, `covered_from date`, `needs_splits boolean default false`.
  - `dividend_special_parts` (3.3): `household_id`, `event_id`, `special_per_share numeric(18,6)`, `updated_at`, `updated_by`; unique `(household_id, event_id)`; `special_per_share` from 0 to the event's amount (trigger).
  - `holding_dividends` (3.5), with every column in the spec's table, plus `review_event_id uuid references dividend_events` (the event a `possible_duplicate` names). `status in ('earned','received','presumed','skipped')`; `evidence in ('member','intimation')`; `units_basis in ('trades','stated')`; `source in ('feed','app','bot','import')`; `review_reason in ('trades_changed','feed_changed','split_on_ex_date','possible_duplicate','moved_ex_date')`; `proposal_id references bot_proposals(id) on delete set null`, not unique; `(household_id, holding_id)` references `holdings (household_id, id) on delete cascade`; `version int not null default 1`.
  - `holdings.dividend_tax_pct numeric(5,2)` (0–100), `holdings.dividend_fee_per_share numeric(18,6) not null default 0` (≥ 0).
  - `accounts.dividends_into_account_id uuid`.
  - Triggers: `holdings_default_dividend_tax` (before insert: a null rate is set from the class); `accounts_check_dividends_into` (before insert or update: non-null only on a `broker_funds` account, naming an unarchived account of the same household and currency, not itself; otherwise `check_violation`); `holding_dividends_check_destination` (before insert or update: a non-null `paid_into_account_id` belongs to the household and has the row's currency; the row's currency equals the holding's; otherwise `check_violation`).

- [ ] **Step 1: Write the failing behaviour cases** (household `11111111-…` and member `22222222-…-0000000000b7` from the file's fixtures; rows inserted as the superuser):
  - `D1-01`: a holding inserted as `india_equity` gets `dividend_tax_pct` 20.8, `us_equity` 30, `intl_equity` 30, `commodity` null; one inserted with 15 keeps 15.
  - `D1-02`: a `holding_dividends` row with `expected_net <> expected_gross - expected_tax - expected_fees` raises `check_violation`; one with `received_net` set while `status = 'earned'` raises `check_violation`; one `received` without `credited_on` raises `check_violation`; two rows for one holding and event raise `unique_violation`.
  - `D1-03`: a row in USD on an INR holding raises `check_violation`; a row whose `paid_into_account_id` is in INR while the row is USD raises `check_violation`.
  - `D1-04`: `dividends_into_account_id` on a `checking` account raises `check_violation`; on a USD broker fund naming an INR bank account raises `check_violation`; on an INR broker fund naming an INR checking account of the same household succeeds.
  - `D1-05`: a `dividend_special_parts` row above its event's amount raises `check_violation`.
- [ ] **Step 2: Write the failing RLS cases** (the file's two-household fixtures): a member reads every `dividend_events` and `dividend_splits` row; reads their household's `holding_dividends` and `dividend_special_parts` rows and not the other's; reads no `dividend_feed_state` row; and `insert`, `update`, `delete` on all five tables as `authenticated` raise `insufficient_privilege` or affect no rows.
- [ ] **Step 3: Run the SQL test run.** Expected: FAIL at `D1-01`.
- [ ] **Step 4: Write the migration's first section**: the tables, columns, checks, indexes (`holding_dividends (holding_id, ex_date)`, `dividend_events (symbol, ex_date)`), the three triggers, the migration's backfill of `dividend_tax_pct` for existing holdings by class, RLS (`select` for `authenticated` on events and splits; `select` through household membership on `holding_dividends` and `dividend_special_parts`, using the predicate the `holding_trades` policy uses; no policies on `dividend_feed_state`), and `revoke insert, update, delete` from `anon, authenticated` on all five tables.
- [ ] **Step 5: Run the SQL test run.** Expected: `D1-01` to `D1-05` and the new RLS cases print `ok`; every older case still passes.
- [ ] **Step 6: Commit** (`Dividends: tables, columns and their guards`).

### Task 2: Recording what the feeds return

**Files:**
- Modify: `supabase/migrations/20261102120000_dividends.sql`
- Test: `supabase/test/migration-behaviour.test.sql` (append)

**Interfaces:**
- Consumes: Task 1's tables; Task 0's answer.
- Produces:
  - `private.source_adjusts_for_splits(p_source text) returns boolean`: `yahoo` true; `alphavantage` per Task 0.
  - `private.split_factor_after(p_symbol text, p_ex_date date, p_before date) returns numeric`: the product of `ratio` over `dividend_splits` with `effective_date > p_ex_date and effective_date < p_before`; 1 with none.
  - `private.recompute_event_amounts(p_symbol text) returns void`: for each event of the symbol, `source_factor = case when source_adjusts_for_splits(source) then split_factor_after(symbol, ex_date, source_fetched_on) else 1 end` and `amount = round(source_amount * source_factor, 6)`.
  - `public.record_dividend_fetch(p_symbol text, p_provider text, p_kind text, p_result jsonb, p_now timestamptz default clock_timestamp()) returns jsonb`, service role only (`p_now` exists for tests; the function passes nothing). `p_provider in ('yahoo','alphavantage')`, `p_kind in ('dividends','splits')`. `p_result` is `{"ok": true, "items": [...], "covered_from": "YYYY-MM-DD"|null}` or `{"ok": false, "error": "..."}`. A dividends item is `{"ex_date", "amount", "currency"?, "pay_date"?, "record_date"?, "declared_on"?}`; a splits item is `{"effective_date", "ratio"}`. Returns `{"ok": true, "listed": n, "changed_past": n}` or `{"ok": false, "error": "..."}` for bad input.
  - `public.dividend_symbols() returns table (symbol text, provider text, held boolean, dividends_last_success_at timestamptz, splits_last_success_at timestamptz, ex_passed_since_success boolean, needs_splits boolean)`, service role only.

- [ ] **Step 1: Write the failing cases:**
  - `D1-06`: a failed fetch (`{"ok": false, "error": "x"}`) for a symbol with two events changes neither event's `last_seen_at`, raises `fail_count` to 1 and keeps `last_success_at`; both events stay listed.
  - `D1-07`: a successful dividends fetch listing one of two stored events leaves the other unlisted (`last_seen_at < last_success_at`) and deletes nothing; `first_seen_at` of the listed one is unchanged.
  - `D1-08` (the share basis, Yahoo, which adjusts): a split of 10 effective 2026-06-10, then a dividends fetch at `p_now` 2026-07-01 with ex-date 2026-03-05 at 0.004 and ex-date 2026-06-20 at 0.01: the first's `amount` is 0.04 (`source_factor` 10), the second's 0.01. A split of 2 effective 2026-08-01 recorded at 2026-08-05 leaves the first at 0.04 (fetched before that split). A dividends fetch at 2026-08-05 giving 0.002 for it keeps 0.04 (factor 20).
  - `D1-08b` (a split learnt after the adjusted amount, as with Alpha Vantage if it adjusts): a dividends fetch at 2026-08-05 gives 0.002 for ex-date 2026-03-05 while only the split of 10 is known, so the amount reads 0.02; recording the split of 2 effective 2026-08-01 then makes it 0.04.
  - `D1-09`: for an Alpha Vantage symbol, a dividends fetch in which a past event's source amount differs from the stored one sets `needs_splits` on the symbol's dividends state; a splits fetch clears it.
  - `D1-10`: `dividend_symbols()` returns an Indian holding priced by Yahoo as `yahoo` and a `us_equity` USD holding as `alphavantage`; skips a commodity, an `india_mf` and a holding without `price_symbol`; returns a USD symbol sold 100 days ago with `held` false, and one sold 400 days ago not at all; returns `ex_passed_since_success` true for a symbol with a listed event whose ex-date is after its last success's Dubai date and on or before today.
- [ ] **Step 2: Run the SQL test run.** Expected: FAIL at `D1-06` (function missing).
- [ ] **Step 3: Implement** the five functions. `record_dividend_fetch` uses `p_now` for both `last_seen_at` and the state's `last_success_at`, so "listed" is an exact equality. A dividends fetch sets each listed event's `source_amount` and `source_fetched_on = (p_now at time zone 'Asia/Dubai')::date`. Either kind ends with `recompute_event_amounts(p_symbol)`.
- [ ] **Step 4: Run the SQL test run.** Expected: `D1-06` to `D1-10` print `ok`.
- [ ] **Step 5: Commit** (`Dividends: recording what the feeds return`).

### Task 3: Earning: units on the ex-date, new rows, links, feed changes and presumed receipts

**Files:**
- Modify: `supabase/migrations/20261102120000_dividends.sql`
- Test: `supabase/test/migration-behaviour.test.sql` (append)

**Interfaces:**
- Consumes: Task 2's functions; `private.holding_entries(uuid, uuid)`, `private.replay_entries(jsonb, boolean)` from the trades migration.
- Produces:
  - `private.units_on_ex_date(p_holding_id uuid, p_ex_date date) returns numeric`: null when the holding has no opening entry on or before the ex-date; otherwise `units` of `replay_entries` over the opening plus the entries whose market day is before the ex-date.
  - `private.dividend_expected(p_units numeric, p_per_share numeric, p_tax_pct numeric, p_fee_per_share numeric) returns jsonb` `{gross, tax, fees, net}`, each rounded to 4: gross = units × per share; tax = gross × coalesce(rate, 0) / 100; fees = least(units × fee, gross − tax); net = gross − tax − fees.
  - `private.dividend_destination(p_holding public.holdings) returns uuid`: the holding's fund's `dividends_into_account_id`, else the fund, else null.
  - `private.sync_holding_dividends(p_holding_id uuid, p_from date) returns jsonb` `{made, updated, removed, flagged, presumed, superseded}`, with spec 5.2 steps 2–4 for this holding's events with `ex_date >= coalesce(p_from, '-infinity')`; Task 4 adds step 1. Earned, unfixed rows also take the current destination and tax rate.
  - `public.earn_dividends() returns jsonb` (service role only): for each holding with a `price_symbol` that has events, in id order, `select … for update` then `sync_holding_dividends(id, null)`; returns the summed counts.

- [ ] **Step 1: Write the failing cases.** Fixture: a USD holding `ABC` with an opening entry of 100 on 2026-10-01, a USD broker fund (destination itself), Yahoo-free Alpha Vantage events recorded through `record_dividend_fetch` with a success dated after their ex-dates.
  - `D1-11`: units on the ex-date. A buy of 10 on 2026-10-09 counts for an ex-date of 2026-10-10. A buy on 2026-10-10 does not. A buy with `trade_date` 2026-10-10 and `traded_at` 2026-10-10 00:30 Dubai (the 9th in New York) counts. An ex-date on 2026-10-01 counts the opening.
  - `D1-12`: after `earn_dividends()`, one `earned` row per event with `units` 100, `per_share` the event's amount, tax at 30%, `paid_into_account_id` the fund, `units_basis` `trades`, `source` `feed`. A commodity holding and a holding with no `price_symbol` get nothing and raise nothing. A holding whose opening is after the ex-date, or which has none, gets nothing.
  - `D1-13`: an event with `pay_date` before its ex-date, and one with a split effective on its ex-date, earn nothing.
  - `D1-14`: a row added as the superuser with `event_id` null and the same ex-date is linked, not duplicated, and flagged `feed_changed` when its `per_share` differs. One 8 days away is not linked, no second row is made, and it is flagged `possible_duplicate` with `review_event_id` the event.
  - `D1-15`: a later fetch changing an event's amount and pay date updates an `earned` unfixed row's figures. A `received` row (set as the superuser) is flagged `feed_changed` instead. With its `review_baseline` set to the new per-share amount, it is not flagged.
  - `D1-16`: an INR holding whose fund names an INR checking account. Its row is `presumed` once `household_today()` is at least 30 days after the ex-date (fixture ex-date 40 days ago), with `credited_on` = ex-date + 30 and `credited_on_estimated` true. A USD broker-fund row with the same dates stays `earned`.
  - `D1-17` (sold after the ex-date): a sale of all 100 units dated the day after the ex-date leaves the row `earned` with units 100.
  - `D1-18` (outage): one success listing five events spread over four months earns all five.
  - `D1-19` (idempotent): a second `earn_dividends()` returns zero counts and changes no row's `version` or `updated_at`.
- [ ] **Step 2: Run the SQL test run.** Expected: FAIL at `D1-11`.
- [ ] **Step 3: Implement** the five functions. Within `sync_holding_dividends`, an event is earnable when it is listed, not superseded, `ex_date <= household_today()`, the state's `(last_success_at at time zone 'Asia/Dubai')::date >= ex_date`, `pay_date` is null or on or after the ex-date, and no `dividend_splits` row is effective on the ex-date. Linking and possible duplicates follow spec 5.2 step 2. Feed changes and `review_baseline` follow 5.2 step 3: the baseline is jsonb `{"per_share", "units", "ex_date"}`, and a flag is raised only when the new value differs from both the row and the baseline. A row's `version` and `updated_at` change only when the row changes.
- [ ] **Step 4: Run the SQL test run.** Expected: `D1-11` to `D1-19` print `ok`.
- [ ] **Step 5: Commit** (`Dividends: earning from the feed`).

### Task 4: Moved ex-dates

**Files:**
- Modify: `supabase/migrations/20261102120000_dividends.sql` (`private.sync_holding_dividends`)
- Test: `supabase/test/migration-behaviour.test.sql` (append)

**Interfaces:**
- Consumes: Task 3's `sync_holding_dividends`.
- Produces: spec 5.2 step 1 inside `sync_holding_dividends`, run before step 2. It sets `dividend_events.superseded_by` and counts `superseded`.

- [ ] **Step 1: Write the failing cases:**
  - `D1-20`: event A (ex 2026-10-10) is listed by a fetch on 2026-10-05; the next fetch, dated the 11th, lists only B (ex 2026-10-12). After `earn_dividends()` on the 12th, there is exactly one row, for B; A has no row.
  - `D1-21`: A is earned (row for A); a later fetch lists only B (3 days later). After `earn_dividends()`, there is still one row, now `event_id` B with `ex_date` B's, its units worked out again; `A.superseded_by = B`; a further run changes nothing.
  - `D1-22`: as `D1-21`, but A's row is `received` (set as the superuser). It keeps `event_id` A and is flagged `moved_ex_date`; B makes no row for that holding.
  - `D1-23`: when two listed events fall within 15 days of the unlisted A, nothing moves; A's earned row is flagged `moved_ex_date`.
- [ ] **Step 2: Run the SQL test run.** Expected: FAIL at `D1-21` (a second row appears).
- [ ] **Step 3: Implement** step 1. A candidate replacement is a listed, unsuperseded event of the same symbol, other than A, within 15 days of A's ex-date, with no row for this holding. Exactly one candidate sets `A.superseded_by` (once set, it is reused for every holding). An earned, unfixed row moves (and is removed if the new units are zero). Anything else is flagged `moved_ex_date`, unless the row's `review_baseline` already holds its current ex-date and per-share amount.
- [ ] **Step 4: Run the SQL test run.** Expected: `D1-20` to `D1-23` print `ok`; `D1-11` to `D1-19` still pass.
- [ ] **Step 5: Commit** (`Dividends: a moved ex-date supersedes, never duplicates`).

### Task 5: Trades and rate changes re-work dividends

**Files:**
- Modify: `supabase/migrations/20261102120000_dividends.sql`
- Modify: `scripts/verify-concurrency.sh`
- Test: `supabase/test/migration-behaviour.test.sql` (append)

**Interfaces:**
- Consumes: `sync_holding_dividends`; `record_trade`, `fix_trade`, `delete_trade` as they are.
- Produces:
  - Trigger `holding_trades_sync_dividends`: after insert, delete, or `update of trade_date, traded_at, units, kind` on `holding_trades`, for each row. It calls `private.sync_holding_dividends(holding_id, least(old.trade_date, new.trade_date) - 1)` (the one date present on insert or delete; a day earlier because a US trade's market day can be the day before its `trade_date`), and returns quietly when the holding no longer exists.
  - Trigger `holdings_rates_sync_dividends`: after `update of dividend_tax_pct, dividend_fee_per_share` on `holdings`, calls `sync_holding_dividends(id, null)`.

- [ ] **Step 1: Write the failing cases:**
  - `D1-24`: an earned row (units 100), then `record_trade` buys 10 dated before the ex-date. In the same call, the row's units become 110 and its expected figures are worked out again. A received row on another event of that holding keeps its units and is flagged `trades_changed`. With its baseline units already 110, it is not flagged.
  - `D1-25`: `fix_trade` moving that buy to after the ex-date returns the earned row to 100. `delete_trade` of a sale that had emptied the holding before an ex-date makes that event's row at once.
  - `D1-26`: a split of 2 recorded before an ex-date doubles that row's units.
  - `D1-27`: changing the holding's `dividend_tax_pct` from 30 to 15 re-works its earned, unfixed rows and leaves received and fixed ones alone.
  - `D1-28`: deleting a holding that has only its opening entry and an earned row succeeds, and removes both.
- [ ] **Step 2: Run the SQL test run.** Expected: FAIL at `D1-24`.
- [ ] **Step 3: Implement** both triggers (`security definer`, `set search_path = ''`).
- [ ] **Step 4: Run the whole SQL test run.** Expected: `D1-24` to `D1-28` print `ok`, and every older `B*`, `QA-*` and `SHR-*` case still passes.
- [ ] **Step 5: Add a race to `scripts/verify-concurrency.sh`**, in the style of its existing races. Session one calls `record_trade` on a holding with an earned row, pausing after its holding lock with `pg_sleep`. Session two calls `earn_dividends()`. Assert both finish without a deadlock error, and the row's units equal the replay afterwards. Run: `PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres scripts/verify-concurrency.sh`. Expected: the new race prints `ok`.
- [ ] **Step 6: Commit** (`Dividends: trades and rate changes re-work what was earned`).

### Task 6: The feed's parsers and planner

**Files:**
- Create: `supabase/functions/dividend-refresh/sources.ts`
- Create: `supabase/functions/dividend-refresh/sources.test.ts`
- Create: `supabase/functions/dividend-refresh/fixtures/` with:
  - `yahoo-combined-special.json` (synthetic, in Yahoo's shape: `ABC.NS`, whose February 2025 payment combines an ordinary 10 and a special 50);
  - `yahoo-bonus.json` (synthetic: `DEF.NS`, with a 1:1 bonus issue as a `2:1` split);
  - `yahoo-not-found.json`;
  - `av-dividends.json` (Alpha Vantage's demo `DIVIDENDS` response; renamed `ABC`);
  - `av-splits.json` (its demo `SPLITS` response; renamed `ABC`);
  - `av-information.json` (the demo refusal);
  - `av-dividends-split.json` (synthetic, in Alpha Vantage's shape: `XYZ`, paying quarterly, a 4:1 split in June 2025, amounts as paid, a zero entry and an entry with "None" dates).

  No fixture is built from a real share's history: the household's own holdings must not be recognisable in this public repository. Yahoo fixtures carry `meta.currency`, `meta.exchangeTimezoneName`, `meta.firstTradeDate` and `events` only.

**Interfaces:**
- Produces (all exported):
  - `type DividendItem = { ex_date: string; amount: number; currency: string | null; pay_date: string | null; record_date: string | null; declared_on: string | null }`
  - `type SplitItem = { effective_date: string; ratio: number }`
  - `type FetchResult<T> = { ok: true; items: T[]; covered_from: string | null } | { ok: false; error: string }`
  - `type FollowedSymbol = { symbol: string; provider: "yahoo" | "alphavantage"; held: boolean; dividends_last_success_at: string | null; splits_last_success_at: string | null; ex_passed_since_success: boolean; needs_splits: boolean }`, as `dividend_symbols()` returns it
  - `yahooUrl(symbol: string): string`: `https://query1.finance.yahoo.com/v8/finance/chart/<symbol>?range=max&interval=1mo&events=div,split`
  - `alphaVantageUrl(fn: "DIVIDENDS" | "SPLITS", symbol: string, key: string): string`
  - `parseYahooChart(body: unknown): { dividends: FetchResult<DividendItem>; splits: FetchResult<SplitItem> }`. Dates are each event's epoch in `meta.exchangeTimezoneName`; `currency` is `meta.currency`; `covered_from` is `meta.firstTradeDate`'s date; a split's ratio is `numerator / denominator`.
  - `parseAlphaVantageDividends(body: unknown): FetchResult<DividendItem>` and `parseAlphaVantageSplits(body: unknown): FetchResult<SplitItem>`. `"None"` becomes null; amounts and factors are numbers; `covered_from` is the earliest date listed, or null.
  - `planYahooSymbols(symbols: FollowedSymbol[], now: Date): string[]`
  - `planAlphaVantageCalls(symbols: FollowedSymbol[], now: Date, budget = 5): { fn: "DIVIDENDS" | "SPLITS"; symbol: string }[]`

- [ ] **Step 1: Write the failing tests** (`Deno.test`, `jsr:@std/assert@1`):
  - `parseYahooChart` on `yahoo-combined-special.json` includes `{ ex_date: "2025-02-14", amount: 60, currency: "INR", pay_date: null }`. On `yahoo-bonus.json` it includes a split `{ effective_date: "2023-03-10", ratio: 2 }`. On `yahoo-not-found.json`, both results are `ok: false`.
  - `parseAlphaVantageDividends` on `av-dividends.json` gives an item with all four dates and `amount` 1.69, and an old item with `pay_date: null`. On `av-information.json` it gives `ok: false`, and so does `{}` or an object without `data`. `parseAlphaVantageSplits` on `av-splits.json` gives `{ effective_date: "2021-11-04", ratio: 1.046 }`.
  - `planYahooSymbols`: a held symbol is always planned. A sold one is planned only when its last success is over 7 days old or null.
  - `planAlphaVantageCalls`: never more than 5 calls. `ex_passed_since_success` symbols come first, then never-checked ones. With a `SPLITS` due, at most 4 `DIVIDENDS`. A held symbol checked 2 days ago is not due. `needs_splits` puts that symbol's `SPLITS` ahead of the others. With nothing due, it returns `[]`.
- [ ] **Step 2: Run** `cd supabase/functions && deno test --node-modules-dir=none --allow-read dividend-refresh/sources.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `sources.ts` and save the fixtures.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** (`Dividends: the feed's parsers and planner`).

### Task 7: The `dividend-refresh` function and its nightly job

**Files:**
- Create: `supabase/functions/dividend-refresh/index.ts`
- Modify: `supabase/config.toml` (`[functions.dividend-refresh] verify_jwt = false`, under the comment that covers the scheduled functions)
- Modify: `supabase/functions/_shared/scheduledCallers.test.ts`
- Modify: `supabase/migrations/20261102120000_dividends.sql` (`schedule_all_jobs`)
- Modify: `scripts/verify-cron-targets.sql`, `docs/backup-restore.md` (four jobs)
- Modify: `CLAUDE.md` (the bot test command)

**Interfaces:**
- Consumes: Task 6's exports; RPCs `get_scheduler_secret`, `dividend_symbols`, `record_dividend_fetch`, `earn_dividends`.
- Produces: an Edge Function answering the scheduler only, with `{ yahoo: n, alphavantage: n, failures: n, earned: {...} }`, and a job `daily-dividend-refresh` at `30 1 * * *` with `timeout_milliseconds := 120000`.

- [ ] **Step 1: Write the failing tests** in `scheduledCallers.test.ts`, importing `../dividend-refresh/index.ts` the way it imports the other two:
  - no scheduler secret gives 403; a member's token gives 403;
  - the right secret gives 200, calls `dividend_symbols` and then `earn_dividends`, and makes no Yahoo or Alpha Vantage request when `dividend_symbols` returns `[]`;
  - with one Yahoo symbol, it records `splits` before `dividends` for it;
  - an RPC answered with no body (the file's catch-all answers a POST with 204) is read as no symbols, not a crash;
  - without `ALPHAVANTAGE_API_KEY`, it makes no Alpha Vantage request.
- [ ] **Step 2: Run** `cd supabase/functions && deno test --node-modules-dir=none --allow-env --allow-read --allow-net=supabase.test _shared/scheduledCallers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `index.ts`:
  - check the scheduler secret as `fd-accrual` does;
  - Yahoo symbols in sequence; Alpha Vantage calls 12 seconds apart (the wait comes from an exported `sleep` the test replaces);
  - each response through its parser into `record_dividend_fetch`;
  - a network error or non-2xx response recorded as `{ ok: false, error }`;
  - then `earn_dividends`.
- [ ] **Step 4: Update `schedule_all_jobs`** in the migration (the whole function, as `20261011195208_scheduler_secret.sql` has it, plus `daily-dividend-refresh`, unscheduled first if it exists, posting to `/functions/v1/dividend-refresh` with the scheduler header). End the migration with `select schedule_all_jobs('https://erggbzbbutsvhleqcddq.supabase.co');`. Add the job to `verify-cron-targets.sql`'s expected list and wording, and to `docs/backup-restore.md`'s job list.
- [ ] **Step 5: Add** `dividend-refresh/sources.test.ts` to the `deno test` command in `CLAUDE.md`.
- [ ] **Step 6: Run** the Deno test from Step 2, the full bot command from `CLAUDE.md` (with `deno check --node-modules-dir=none dividend-refresh/index.ts` too, then delete `deno.lock`), and the SQL test run. Expected: all pass.
- [ ] **Step 7: Commit** (`Dividends: the nightly dividend-refresh`).

### Task 8: Withholding, fees and "paid into" in the editors

**Files:**
- Modify: `src/screens/wealth/HoldingEditor.jsx`, `src/screens/wealth/HoldingEditor.test.jsx`
- Modify: `src/screens/wealth/AccountEditor.jsx`, `src/screens/wealth/AccountEditor.test.jsx`, `src/screens/wealth/Accounts.jsx` (pass `accounts`)

**Interfaces:**
- Produces: the holding editor saves `dividend_tax_pct` (number, or null when empty) and `dividend_fee_per_share` (number, 0 when empty) for `us_equity`, `intl_equity` and `india_equity`, and leaves both out otherwise. The account editor takes an `accounts` prop and, for type `broker_funds`, saves `dividends_into_account_id` (null for "This fund"); for any other type it sends null.

- [ ] **Step 1: Write the failing tests:**
  - HoldingEditor: an Indian holding shows "Withholding on dividends" filled with 20.8 and "Fees per share" with 0. Saving with 10 and 0.01 sends `dividend_tax_pct: 10, dividend_fee_per_share: 0.01`. 120 shows "Enter a rate from 0 to 100." and saves nothing. A commodity shows neither field.
  - AccountEditor: a USD broker fund lists "This fund" and only the household's open USD accounts other than itself. Choosing one saves its id. A checking account shows no such field and saves `dividends_into_account_id: null`.
- [ ] **Step 2: Run** `npx vitest run src/screens/wealth/HoldingEditor.test.jsx src/screens/wealth/AccountEditor.test.jsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** The holding fields go under Sector, in the same field style. The account field goes under the balance fields for a Broker funds account, labelled "Dividends paid into", with the hint "Where this broker's dividends land. Indian companies pay the bank account linked to the demat account."
- [ ] **Step 4: Run** the same tests, then `npx eslint src e2e` and `npx vitest run`. Expected: all pass.
- [ ] **Step 5: Commit** (`Dividends: withholding, fees and where dividends land`).

### Task 9: Docs, and the checks before pushing

**Files:**
- Modify: `docs/decisions.md` (a new "Dividends" section; the "A broker's cash is an account" bullet on dividends; "Not yet" in "The bot records trades"), `docs/features.md` (Wealth → Investments editor fields, the feed, the scheduled-jobs table)

- [ ] **Step 1: Write the "Dividends" section** in the decisions file's style, with a bullet for each household decision in spec section 2, plus:
  - the share basis;
  - whole-history fetches and "listed";
  - superseding a moved ex-date;
  - trades re-working dividends;
  - presumed receipts;
  - the lock order.

  Change the broker-cash bullet to say a dividend received into a fund moves it once confirmed (PR 2). Add the job to the features table.
- [ ] **Step 2: Run every check in `CLAUDE.md`:**
  - eslint;
  - vitest;
  - the build with the e2e environment;
  - Playwright with `CHROMIUM_PATH`;
  - the Deno check and tests (delete `deno.lock` after);
  - `bash scripts/verify-migrations.sh` and the SQL test run;
  - `scripts/verify-concurrency.sh`.

  Expected: all pass. Note any that cannot run here, and why.
- [ ] **Step 3: Commit** (`Dividends: decisions and features for PR 1`), push the branch, and open the pull request with the repository's template. The description says the migration is not applied and that the household must add `ALPHAVANTAGE_API_KEY` before merge.
