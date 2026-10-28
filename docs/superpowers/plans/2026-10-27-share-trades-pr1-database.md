# Share trades, PR 1: the database and the sums — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trades become the record of a holding: a `holding_trades` table, broker fund accounts, and database functions that preview, record, fix and delete a trade and replay the holding, all in one transaction.

**Architecture:** One new migration holds the table, the holding and account changes, and every function. The sums live in one pure SQL function, `private.replay_entries`, which both the preview and the save call, so they cannot disagree. Writes to trades go only through `security definer` functions; members read trades through RLS. The app and bot only learn the new account type in this PR; the bot's trade flow (PR 2) and the trade screens (PR 3) come later.

**Tech Stack:** Postgres (Supabase), plpgsql, SQL test files run with psql; React/Vitest for the account-type lists and the holding editor; Deno for the price feed and the bot.

**Spec:** `docs/superpowers/specs/2026-10-27-share-trades-design.md` (sections 3, 4, 9 and 12.1).

## Global Constraints

- The repository is public: tests, docs and commits use round example numbers and generic names ("Partner", "Dollar broker funds"), never the household's.
- Style: plain JS/JSX and SQL, single quotes in JS, comments explain why in full sentences, matching the files around them (`CLAUDE.md`).
- One migration file for the whole PR: `supabase/migrations/20261027120000_holding_trades.sql`. Its version is renamed to production's at apply time; it is not applied before the household says "apply and merge".
- Every new constraint and trigger gets a case in `supabase/test/migration-behaviour.test.sql`; the new table gets cases in `supabase/test/rls-policies.test.sql`.
- Money: units numeric(20,8), prices numeric(18,6), fees, tax and cash numeric(16,4). The dirham peg is 3.6725; rupees convert with `households.inr_per_aed`.
- A trade's moment is `traded_at`, or the end of its trade date in Dubai (`(trade_date + 1)::timestamp at time zone 'Asia/Dubai'`) when `traded_at` is null.
- Refusals come back as `{"ok": false, "error": "<code>"}` from the functions, never as an exception, so the bot and app can explain them. Error codes, exactly: `not_member`, `holding_not_found`, `trade_not_found`, `stale`, `no_opening`, `before_opening`, `exceeds_units`, `whole_units_only`, `currency_mismatch`, `fund_required`, `fund_archived`, `already_recorded`, `opening_has_trades`, `bad_input`.
- The SQL test run (after `pg_ctlcluster 16 main start`):

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

1. A fund account never confirmed (`balance_as_of` null): every trade moves it. Pinned in Task 3.
2. A holding never priced (`current_price` null): recording a trade leaves `value_aed` as it was rather than zeroing it. Pinned in Task 3.
3. A rupee holding when `households.inr_per_aed` is null or 0: the value is left as it was, not divided by zero. Pinned in Task 3.
4. Two trades on one day with no `traded_at`: they replay in the order recorded, so a sell recorded before a same-day buy is checked against the units before that buy. Pinned in Task 2.
5. A trade fixed to use a different fund: the old fund is reversed and the new one moved, each by the confirmation rule. Pinned in Task 4.

---

### Task 1: Tables, columns and guards

**Files:**
- Create: `supabase/migrations/20261027120000_holding_trades.sql`
- Test: `supabase/test/migration-behaviour.test.sql` (append), `supabase/test/rls-policies.test.sql` (append)

**Interfaces:**
- Produces: table `holding_trades` with the columns of spec 3.1 (`id`, `household_id`, `holding_id`, `member_id`, `kind`, `trade_date`, `traded_at`, `units`, `price`, `fees`, `tax_withheld`, `tax_to_confirm`, `funds_account_id`, `cash_amount`, `units_after`, `avg_after`, `realised`, `source`, `proposal_id`, `note`, `created_at`, `created_by`); `holdings.funds_account_id uuid`, `holdings.trades_version integer not null default 0`; `holdings.quantity numeric(20,8)`, `holdings.avg_price numeric(18,6)`; account type `broker_funds`; `accounts.brokerage_in_average boolean not null default false`.

- [ ] **Step 1: Write the failing behaviour cases** (append to `migration-behaviour.test.sql`, each a `do $$` block in the file's style, named `B2-01` to `B2-07`):
  - `B2-01`: an account of type `broker_funds` in USD can be created.
  - `B2-02`: a holding's `quantity` keeps `1.23456789` exactly.
  - `B2-03`: inserting a second `opening` row for one holding raises `unique_violation`.
  - `B2-04`: a `buy` row with `funds_account_id` null raises `check_violation`; a `split` row with a price raises `check_violation`.
  - `B2-05`: a `buy` row whose fund is in INR on a USD holding raises `check_violation` (trigger); one on an archived fund raises `check_violation`.
  - `B2-06`: with `trades_version` set to 1, `update holdings set quantity = quantity + 1` raises `check_violation`; with `set_config('rokda.trade_replay', 'on', true)` in the same transaction it succeeds; on a holding with `trades_version = 0` it succeeds.
  - `B2-07`: deleting a holding that has a `buy` row raises `check_violation`; deleting one that has only its `opening` row succeeds and removes the row.

  Fixtures: the file's household `11111111-…` and member `22222222-…`; insert trade rows directly as the superuser, with a funds account `broker_funds` USD.

- [ ] **Step 2: Write the failing RLS cases** (append to `rls-policies.test.sql`, using that file's two-household fixtures): a member reads their household's `holding_trades` rows and not the other household's; `insert`, `update` and `delete` on `holding_trades` as `authenticated` affect no rows or raise `insufficient_privilege`.

- [ ] **Step 3: Run the SQL test run.** Expected: FAIL at `B2-01` (type not allowed).

- [ ] **Step 4: Write the migration's first section.**
  - `holding_trades` per spec 3.1; `(household_id, holding_id)` references `holdings (household_id, id) on delete cascade`; `(household_id, member_id)` references `household_members (household_id, id)`; `(household_id, funds_account_id)` references `accounts (household_id, id)` (no cascade, so a fund with trades cannot be deleted); `proposal_id` references `bot_proposals (id) on delete set null`, unique when not null.
  - Checks: `kind in ('opening','buy','sell','split')`; `units > 0`; `fees >= 0`; `tax_withheld >= 0`; `tax_withheld = 0 or kind = 'sell'`; `(price is not null) = (kind <> 'split')`; `(funds_account_id is not null) = (kind in ('buy','sell'))`; `source in ('opening','bot','app','statement')`.
  - A unique partial index: one `opening` per `holding_id`. An index on `(holding_id, trade_date, traded_at, created_at)`.
  - `alter table holdings` for the three columns and the two widened types (if a view depends on these columns, drop and recreate it in the same file).
  - `accounts_type_check` recreated with `broker_funds` added; `accounts.brokerage_in_average`.
  - Trigger `holding_trades_check_fund` (before insert or update): the fund's currency equals the holding's, and the fund is not archived; otherwise raise with `errcode = 'check_violation'`.
  - Trigger `holdings_guard_traded_units` (before update of `quantity`, `avg_price`): refuse a change when `old.trades_version > 0` and `current_setting('rokda.trade_replay', true)` is not `'on'`, with `errcode = 'check_violation'`.
  - Trigger `holdings_guard_traded_delete` (before delete): refuse when a `buy` or `sell` row exists for the holding, with `errcode = 'check_violation'`.
  - RLS on `holding_trades`: one `select` policy using `private.is_household_member(household_id)`; no write policies; `revoke insert, update, delete` from `anon, authenticated`.
  - `comment on` the table and each new column, saying why.

- [ ] **Step 5: Run the SQL test run.** Expected: every `B2-0x` and the new RLS cases print `ok`; nothing else fails.

- [ ] **Step 6: Commit** `supabase/migrations/20261027120000_holding_trades.sql` and both test files: "Trades table, broker funds and the guards on traded holdings".

### Task 2: The sums, `private.replay_entries`

**Files:**
- Modify: `supabase/migrations/20261027120000_holding_trades.sql` (append)
- Test: `supabase/test/migration-behaviour.test.sql` (append)

**Interfaces:**
- Produces: `private.replay_entries(p_entries jsonb, p_brokerage_in_average boolean) returns jsonb`, immutable, no table access. Input: an array of `{id, kind, trade_date, traded_at, created_at, units, price, fees, tax_withheld}`. Output: `{"ok": true, "units": n, "avg": n, "entries": [{"id", "units_after", "avg_after", "realised"}]}` in replay order, or `{"ok": false, "error": "<code>", "entry_id": <id>}`.

- [ ] **Step 1: Write the failing cases** `B2-10` to `B2-15`, calling `private.replay_entries` with literal JSON:
  - `B2-10` (spec 4 worked example, brokerage not in the average): opening 10 at 100; buy 5 at 130 fees 1; sell 6 at 150 fees 1 → final `units = 9`, `avg = 110`; the sell's `realised = 239`; the buy's `avg_after = 110`.
  - `B2-11`: the same buy with `p_brokerage_in_average = true` → `avg_after = 110.066667`.
  - `B2-12`: a split by 10 after opening 9 at 110 → `units = 90`, `avg = 11`, `realised` null.
  - `B2-13`: opening 10 dated 1 Oct, buy 5 dated 10 Oct, sell 12 dated 5 Oct → `{"ok": false, "error": "exceeds_units"}` naming the sell.
  - `B2-14`: a buy dated before the opening → `before_opening`; no opening entry at all → `no_opening`.
  - `B2-15` (Review Focus 4): opening 10; on one day with no `traded_at`, a sell of 12 recorded (`created_at`) before a buy of 5 → `exceeds_units`; the same two recorded buy first → `ok`, units 3.

- [ ] **Step 2: Run the SQL test run.** Expected: FAIL, function does not exist.

- [ ] **Step 3: Implement `private.replay_entries`** in the migration. The algorithm:

```text
sort entries by trade_date, traded_at (nulls last), created_at
first entry must be kind 'opening', else no_opening; any entry dated before it -> before_opening
U := opening.units; A := opening.price
for each later entry e:
  buy:   A := (U*A + e.units*e.price + (fees if p_brokerage_in_average else 0)) / (U + e.units); U := U + e.units
  sell:  if e.units > U -> exceeds_units (entry e)
         realised := e.units * (e.price - A) - e.fees; U := U - e.units      (A unchanged)
  split: U := U * e.units; A := A / e.units
  record units_after = round(U, 8), avg_after = round(A, 6), realised = round(realised, 4) or null
```

- [ ] **Step 4: Run the SQL test run.** Expected: `B2-10` to `B2-15` print `ok`.

- [ ] **Step 5: Commit**: "The replay: one place that works out units, average and profit".

### Task 3: Preview and record, with the fund and the value

**Files:**
- Modify: `supabase/migrations/20261027120000_holding_trades.sql` (append)
- Test: `supabase/test/migration-behaviour.test.sql`, `supabase/test/rls-policies.test.sql` (append)

**Interfaces:**
- Consumes: `private.replay_entries` (Task 2).
- Produces:
  - `private.trade_caller(p_household_id uuid, p_member_id uuid) returns uuid`: the acting member. With `auth.uid()` set, that user's member row in the household (null if none). Without it, `p_member_id` when `auth.role() = 'service_role'` and that member is in the household. Null means `not_member`.
  - `private.holding_value_aed(p_holding holdings) returns numeric`: `quantity × current_price × rate` (AED 1, USD 3.6725, INR `1 / inr_per_aed`), rounded to 2; null when `quantity`, `current_price` or a positive rate is missing.
  - `private.trade_moves_fund(p_fund accounts, p_trade_date date, p_traded_at timestamptz) returns boolean`: true when `p_fund.balance_as_of` is null or the trade's moment is after it.
  - `preview_trade(p_holding_id uuid, p_kind text, p_trade_date date, p_units numeric, p_price numeric, p_fees numeric default 0, p_tax_withheld numeric default 0, p_traded_at timestamptz default null, p_funds_account_id uuid default null, p_replace_trade_id uuid default null, p_member_id uuid default null) returns jsonb`: `{ok, error, trades_version, units_before, avg_before, units_after, avg_after, realised, cash_amount, funds_account_id, funds_moves, funds_balance_before, funds_balance_after, warnings}`. `p_funds_account_id` defaults to the holding's. `warnings` is an array of `fund_below_zero`, `fund_confirmed_after`, `price_off_market` (more than 20% from `current_price`), `possible_duplicate` (same holding, kind, units and price within 2 days, the replaced trade excluded).
  - `record_trade(p_holding_id uuid, p_kind text, p_trade_date date, p_units numeric, p_price numeric, p_fees numeric default 0, p_tax_withheld numeric default 0, p_traded_at timestamptz default null, p_funds_account_id uuid default null, p_source text default 'app', p_proposal_id uuid default null, p_member_id uuid default null, p_expected_version integer default null, p_tax_to_confirm boolean default false, p_note text default null) returns jsonb`: the preview's fields plus `trade_id`, or a refusal.
  - `private.write_replay(p_holding_id uuid, p_result jsonb)`: writes each entry's `units_after`, `avg_after` and `realised`, the holding's `quantity` and `avg_price` (under `rokda.trade_replay = 'on'`), `trades_version + 1`, `value_aed` from `private.holding_value_aed` when not null, and upserts `holding_value_history (holding_id, household_today())`.
  - Grants: `preview_trade` and `record_trade` to `authenticated, service_role`; `revoke` from `public, anon`. Both `security definer`, `set search_path = ''`.

- [ ] **Step 1: Write the failing cases** `B2-20` to `B2-29` (superuser; call the functions as service role by setting `request.jwt.claim.role = 'service_role'` and passing `p_member_id`). Fixtures: a USD `broker_funds` account with balance 1000 and `balance_as_of` null; a USD holding with an opening entry of 10 at 100 (inserted directly, then replayed so `trades_version = 1`) and `current_price` 150.
  - `B2-20`: `record_trade` buy 5 at 130 fees 1 → holding 15 at 110, `trades_version = 2`; fund 349; `value_aed = 15 × 150 × 3.6725` rounded; today's `holding_value_history` row has that value; an `account_balance_events` row with source `bot`; the fund's `balance_as_of` unchanged.
  - `B2-21`: `record_trade` sell 6 at 150 fees 1 → `realised = 239`, fund 1248 (1000 − 651 + 899).
  - `B2-22`: the preview for the same sell, taken before recording, returns the same `units_after`, `avg_after`, `realised` and `cash_amount` that the record writes.
  - `B2-23`: a sell of 100 → `exceeds_units`; the trade count, the holding and the fund are unchanged.
  - `B2-24`: `p_expected_version` one behind → `stale`, nothing written.
  - `B2-25`: the same `p_proposal_id` twice → second returns `already_recorded` with the first `trade_id`.
  - `B2-26`: the fund's `balance_as_of` set to after a back-dated buy's moment → the buy records, the fund does not move, and the preview listed `fund_confirmed_after`.
  - `B2-27`: preview warnings: a price of 200 against `current_price` 150 → `price_off_market`; a fund of 100 and a buy of 5 at 130 → `fund_below_zero`; recording the same buy twice in two days → `possible_duplicate` on the second preview.
  - `B2-28` (Review Focus 1, 2, 3): a never-confirmed fund moves (covered by `B2-20`, asserted explicitly); a holding with `current_price` null keeps its `value_aed`; an INR holding with `households.inr_per_aed` null keeps its `value_aed`.
  - `B2-29`: an INR `india_equity` holding: a buy of 1.5 units → `whole_units_only`; a buy through a USD fund → `currency_mismatch`.

  RLS (append): a signed-in member calls `record_trade` on their household's holding → `ok`; a member of the other household → `not_member`; `anon` cannot execute it.

- [ ] **Step 2: Run the SQL test run.** Expected: FAIL, functions missing.

- [ ] **Step 3: Implement** the helpers, `preview_trade`, `write_replay` and `record_trade` in the migration. `record_trade`: lock the holding row (`for update`), check the caller, version, proposal, fund and units; build the entry list from the holding's rows plus the new one; call `private.replay_entries` with the fund's `brokerage_in_average`; on success insert the trade with its `cash_amount` (buy `−(units × price + fees)`, sell `units × price − fees − tax`), call `private.write_replay`, and move the fund by `cash_amount` when `private.trade_moves_fund`, setting `rokda.balance_source` (the source, `bot` or `app`) and `rokda.balance_member` first. `preview_trade` does the same reads and replay and writes nothing.

- [ ] **Step 4: Run the SQL test run.** Expected: `B2-20` to `B2-29` and the RLS cases print `ok`.

- [ ] **Step 5: Commit**: "Preview and record a trade, moving the fund and the value together".

### Task 4: Fix and delete a trade

**Files:**
- Modify: `supabase/migrations/20261027120000_holding_trades.sql` (append)
- Test: `supabase/test/migration-behaviour.test.sql` (append)

**Interfaces:**
- Consumes: Task 3's helpers.
- Produces:
  - `fix_trade(p_trade_id uuid, p_trade_date date, p_units numeric, p_price numeric, p_fees numeric, p_tax_withheld numeric, p_traded_at timestamptz, p_funds_account_id uuid, p_tax_to_confirm boolean, p_note text, p_expected_version integer, p_member_id uuid default null) returns jsonb`.
  - `delete_trade(p_trade_id uuid, p_expected_version integer, p_member_id uuid default null) returns jsonb`.
  - Same grants as Task 3. The opening entry can be fixed (units and price only); it cannot be deleted while other entries exist (`opening_has_trades`).

- [ ] **Step 1: Write the failing cases** `B2-30` to `B2-35`:
  - `B2-30`: fix the buy's price from 130 to 120 → holding average and the later sell's `realised` replayed; the fund moves by the difference in `cash_amount` only.
  - `B2-31`: delete the sell → units back to 15, the fund reversed by its `cash_amount`.
  - `B2-32`: fixing a buy down so that a later sell exceeds the units → `exceeds_units`, nothing changed.
  - `B2-33` (Review Focus 5): fix a buy from fund A to fund B (both USD, unconfirmed) → A reversed, B moved.
  - `B2-34`: a fix or delete of a trade whose moment is before the fund's `balance_as_of` → the trade changes, the fund does not.
  - `B2-35`: sell everything → `quantity = 0`, `value_aed = 0`; a later buy of 3 at 100 → `quantity = 3`, average 100 (the closed holding reopens); deleting the opening while trades exist → `opening_has_trades`.

- [ ] **Step 2: Run the SQL test run.** Expected: FAIL.

- [ ] **Step 3: Implement** `fix_trade` and `delete_trade`: lock the holding, check caller and version, replay with the trade changed or removed, refuse on error; then write the replay, and adjust funds by reversing the old `cash_amount` on the old fund (when `private.trade_moves_fund` for the old moment) and applying the new on the new fund (when it moves for the new moment).

- [ ] **Step 4: Run the SQL test run.** Expected: `B2-30` to `B2-35` print `ok`.

- [ ] **Step 5: Commit**: "Fix and delete a trade, replaying the holding".

### Task 5: The fresh start, `open_trade_history`

**Files:**
- Modify: `supabase/migrations/20261027120000_holding_trades.sql` (append)
- Test: `supabase/test/migration-behaviour.test.sql` (append)

**Interfaces:**
- Produces: `open_trade_history(p_member_id uuid, p_trade_date date) returns integer` (the number of opening entries created). `service_role` only. For each of the member's holdings with `quantity > 0`, `avg_price` set and no opening entry: insert `opening` (units = quantity, price = avg_price, source `opening`), set `funds_account_id` to the member's only non-archived `broker_funds` account in the holding's currency when it is null and exactly one exists, and replay so `trades_version = 1`. The holding's units and average do not change.

- [ ] **Step 1: Write the failing cases** `B2-40` to `B2-42`:
  - `B2-40`: three holdings of the member (two with units and an average, one without an average) and one of another member → returns 2; those two have `trades_version = 1` and their `quantity` and `avg_price` unchanged; the other member's holding is untouched.
  - `B2-41`: running it again returns 0 and creates nothing.
  - `B2-42`: with one USD `broker_funds` account for the member, the USD holding's `funds_account_id` is set to it; with two, it stays null.

- [ ] **Step 2: Run the SQL test run.** Expected: FAIL.
- [ ] **Step 3: Implement `open_trade_history`.**
- [ ] **Step 4: Run the SQL test run.** Expected: `B2-40` to `B2-42` print `ok`.
- [ ] **Step 5: Commit**: "The fresh start: an opening entry per holding, once".

### Task 6: The price feed writes value from current units

**Files:**
- Modify: `supabase/migrations/20261027120000_holding_trades.sql` (append), `supabase/functions/price-refresh/index.ts:255-350`
- Test: `supabase/test/migration-behaviour.test.sql` (append)

**Interfaces:**
- Produces: `set_holding_price(p_holding_id uuid, p_price numeric, p_day_change_pct numeric, p_quoted_at timestamptz, p_fetched_at timestamptz) returns numeric`, `service_role` only: under a row lock, sets `current_price`, `day_change_pct`, `priced_at` (only when `p_quoted_at` is not null), `price_fetched_at`, clears `price_fetch_error` and `price_fetch_fail_count`, sets `value_aed` from `private.holding_value_aed` when not null and upserts today's `holding_value_history`; returns the value written or null.

- [ ] **Step 1: Write the failing case** `B2-50`: a USD holding of 10 units; `set_holding_price(h, 150, 1.5, '2026-10-26 20:00+00', now())` → `value_aed = 10 × 150 × 3.6725`, today's history row equal; after a trade replays the holding to 15 units, calling it again with 150 writes the value for 15 units.
- [ ] **Step 2: Run the SQL test run.** Expected: FAIL.
- [ ] **Step 3: Implement `set_holding_price`;** in `price-refresh/index.ts`, replace the per-holding `update` and the history `upsert` with `supabase.rpc('set_holding_price', {...})`, keep the failure path as it is, and add `.or('quantity.is.null,quantity.gt.0')` to the holdings query so closed holdings are skipped. Keep the comment about `priced_at` with the new call.
- [ ] **Step 4: Run** the SQL test run (expected `B2-50 ok`) and, from `supabase/functions`, `deno check --node-modules-dir=none price-refresh/index.ts` (expected: no errors; delete `deno.lock` afterwards).
- [ ] **Step 5: Commit**: "The price feed values a holding from its units at the moment it writes".

### Task 7: The app and the bot learn the new account type

**Files:**
- Modify: `src/lib/accounts.js:9-18`, `src/lib/planningModel.js:86`, `src/screens/wealth/HoldingEditor.jsx`, `supabase/functions/telegram-webhook/index.ts:572-640`
- Test: `src/lib/accounts.test.js`, `src/lib/planningModel.test.js`, `src/screens/overviewMath.test.js`, `src/screens/wealth/HoldingEditor.test.jsx`, `supabase/functions/telegram-webhook/index.test.ts` (each modified or created beside its file)

**Interfaces:**
- Produces: `ACCOUNT_TYPE_LABELS.broker_funds = 'Broker funds'`, placed after `investment`; `export function isSpendingAccount(a: { type?: string | null }): boolean` in the bot (false only for `broker_funds`).

- [ ] **Step 1: Write the failing tests:**
  - `accounts.test.js`: `accountTypeLabel('broker_funds')` is `'Broker funds'`.
  - `planningModel.test.js`: `planStart` counts a `broker_funds` account's AED value in `cash`.
  - `overviewMath.test.js`: `liquidAssets` leaves a `broker_funds` account out.
  - `HoldingEditor.test.jsx`: with `trades_version: 1`, the Units and Average price inputs are read-only, the text "Units and average price come from this holding's trades." is shown, and saving a name change sends a payload without `quantity` or `avg_price`; with `trades_version: 0` they are editable as today.
  - `index.test.ts`: `isSpendingAccount({ type: 'broker_funds' })` is false; `isSpendingAccount({ type: 'checking' })` is true.
- [ ] **Step 2: Run** `npx vitest run src/lib/accounts.test.js src/lib/planningModel.test.js src/screens/overviewMath.test.js src/screens/wealth/HoldingEditor.test.jsx` and the deno test command from `CLAUDE.md`. Expected: the new tests fail.
- [ ] **Step 3: Implement:** the label; `'broker_funds'` in `CASH_ACCOUNT_TYPES`; the editor's read-only fields, note and payload; `isSpendingAccount`, with both account matchers selecting `type` and keeping only spending accounts.
- [ ] **Step 4: Run** the same commands. Expected: PASS. Then `npx eslint src e2e` and `npx vitest run`: clean and all passing.
- [ ] **Step 5: Commit**: "Broker funds count as cash, not as spending money; traded units are read-only".

### Task 8: Docs, full checks and the pull request

**Files:**
- Modify: `docs/decisions.md`, `docs/features.md`

- [ ] **Step 1: Write** three sections in `docs/decisions.md`: "Trades are the record of a holding" (approach A, the replay, writes only through functions), "A broker's cash is an account" (where `broker_funds` counts and why, and why a trade before a confirmed balance leaves it alone), and "The price feed values a holding as it writes" (the race it closes). Add the trades and Broker funds lines to `docs/features.md`.
- [ ] **Step 2: Run every check in `CLAUDE.md`:** eslint, vitest, the build, Playwright, the deno check and tests, and the SQL test run. Expected: all pass.
- [ ] **Step 3: Commit and push** to `claude/vibrant-turing-45j3sn`; open the pull request "Share trades, part 1: the database and the sums" with the template's sections; subscribe to its activity.
- [ ] **Step 4: Stop.** Applying to production waits for the household's "apply and merge". After the merge, go-live per member (spec 12.1) is its own step with the household: create the fund accounts and the Indian bank account with their balances, then `open_trade_history`.
