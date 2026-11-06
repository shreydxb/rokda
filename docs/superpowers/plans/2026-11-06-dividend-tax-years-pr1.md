# Dividend tax years, part 1: records, functions and sums, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store each member's tax returns, what happened to their refunds, and the department's AIS and Form 26AS, through guarded functions, and work out each tax year's figures, statement check, surplus or shortfall, refund state and estimate in one pure file.

**Architecture:**
- **Database:** one migration adds four tables (`tax_returns`, `tax_return_events`, `tax_statements`, `tax_statement_lines`) and two columns on `holding_dividends`, all read by the household's members and written only by five `security definer` functions.
- **App sums:** `src/lib/dividendTax.js` takes the rows as the app will read them and returns each member's tax years. Part 2 (the screen) reads the rows and lays the result out; nothing here renders.
- **Money:** every sum is done in whole paise, so a difference is exact; results are rupees to two decimals.

**Tech Stack:** Supabase Postgres (plpgsql, RLS) with SQL tests and a concurrency script; plain JavaScript with Vitest.

**Spec:** `docs/superpowers/specs/2026-11-04-dividend-tax-years-design.md`: sections 3 (what is stored), 4 (the sums), 5 (recording), and the section 8 cases tested in SQL and unit. The screen and browser cases are part 2.

## Global Constraints

- **Public repository:** generic names and round figures in tests, fixtures, docs, commits and PR text ("ABC", "XYZ", "Partner", 1,000, 208). No PAN, acknowledgement number, account number or real figure anywhere.
- **One migration:** `supabase/migrations/20261106120000_dividend_tax_years.sql`, built up section by section across Tasks 1 to 4. It is applied to production only on "apply and merge", then renamed to the version production gives it.
- **Tax year:** an integer, the starting year: `2025` is FY 2025-26 (1 April 2025 to 31 March 2026), assessment year 2026-27.
- **Amounts:** rupees to the paisa, `numeric(16,2)`, never negative except a processing's `refund_determined` (negative is a demand). Null means unknown; zero means known to be zero.
- **Functions:** `security definer`, `set search_path = ''`, every reference schema-qualified; each returns `jsonb` `{ok: true, …}` or `{ok: false, error: <code>}`; execute revoked from `public, anon` (and from `authenticated` for private helpers and the import).
- **Error codes** (the only ones these functions return): `not_member`, `bad_input`, `bad_figures`, `stale`, `basis_needs_rate`, `filed_on_needed`, `not_filed`, `filed_before_year_end`, `in_future`, `identifier_in_text`, `events_on_later_revision`, `event_not_found`, `dividend_not_found`, `not_indian`, `year_too_far`, `unknown_share`, `duplicate_payer`, `older_than_held`.
- **Identifiers never stored:** a note or a payer is refused (`identifier_in_text`) when it contains PAN-shaped text (`[A-Za-z]{5}[0-9]{4}[A-Za-z]`) or a run of nine or more digits (account and acknowledgement numbers). Spec section 1 asks that none be stored; this is the guard.
- **Indian dividends:** those of holdings with `asset_class = 'india_equity'`. A share is `holdings.price_symbol`; a holding without one is its own share (`holding:<id>`).
- **Words:** "dividend tax surplus" or "shortfall", never "the dividend part of the refund"; "within rounding", never "matches"; explanations are possibilities.
- **Checks:** every check in `CLAUDE.md` passes before the PR, plus `npm run verify:concurrency`.

## Review Focus

1. **Figures typed as text in an import** (`"1,000.50"`, `10.005`): refused (`bad_input`, `bad_figures`) with the line's index, nothing stored. *Task 2.*
2. **A symbol in another case** (`abc.ns` for a holding's `ABC.NS`): matched, and stored in the holding's spelling, so the check pairs it with Rokda's dividends. *Task 2.*
3. **Many small rupee amounts** (0.10 + 0.20 + 0.30 against a statement's 0.60): "agrees", never a floating-point residue labelled "within rounding". *Task 5.*
4. **A holding that became shared after its dividends:** its past dividends move to "whose are these?", never stay with the old owner or vanish. *Task 5.*
5. **A refund event dated before the tax year ended** (processed on 1 March 2026 for FY 2025-26): refused (`bad_input`). *Task 3.*

---

### Task 1: The tables, the tax-year column and who reads them

**Files:**
- Create: `supabase/migrations/20261106120000_dividend_tax_years.sql`
- Test: `supabase/test/migration-behaviour.test.sql`, `supabase/test/rls-policies.test.sql`
- Create (workspace, git-ignored): `.superpowers/sdd/2026-11-06-dividend-tax-years-pr1/sqltest.sh`, a copy of `.superpowers/sdd/2026-11-02-dividends-pr2-receipts/sqltest.sh` with `W` set to this plan's workspace.

**Interfaces:**
- **Produces, in `private`:**
  - `private.financial_year_of(p_day date) returns integer`, immutable: the year of `p_day` less one when its month is before April.
  - `private.has_identifier(p_text text) returns boolean`, immutable: true for PAN-shaped text or nine or more digits in a row; false for null.
- **Produces the tables** (spec 3.1 to 3.4), each with `household_id uuid not null references households (id) on delete cascade`:
  - `tax_returns`: `id`, `household_id`, `member_id`, `financial_year integer` (2000 to 2100), `claim_basis` (`domestic`, `treaty`, `manual`), `claim_rate_pct numeric(5,2)` (0 to 100), `revision integer not null default 0` (≥ 0), `filed_on date`, `dividend_income`, `dividend_tax`, `dividend_tds_claimed`, `tds_claimed_total` (each `numeric(16,2)`, ≥ 0), `note`, `version integer not null default 1`, `created_at`, `updated_at`, `updated_by uuid`. Constraints:
    - `unique (member_id, financial_year)` and `unique (household_id, id)`;
    - `foreign key (household_id, member_id) references household_members (household_id, id)` with no cascade, so a member with returns cannot be removed but the household can still be deleted;
    - `tax_returns_basis_with_rate`: `claim_basis` and `claim_rate_pct` both set or both null;
    - `tax_returns_filed`: `(revision = 0) = (filed_on is null)`;
    - `tax_returns_figures_when_filed`: with `revision = 0`, the four figures are null;
    - `tax_returns_dividend_tds_within_total`: `dividend_tds_claimed <= tds_claimed_total` when both are set;
    - `tax_returns_note_has_no_identifier`: `not private.has_identifier(note)`, and `length(note) <= 500`.
  - `tax_return_events`: `id`, `household_id`, `return_id`, `revision integer` (≥ 1), `kind` (`processed`, `refund_credited`, `offset_against_demand`, `refund_failed`), `happened_on date not null`, `refund_determined`, `refund_interest`, `tds_allowed_total`, `amount` (each `numeric(16,2)`), `note`, `created_at`, `updated_at`, `updated_by`. Constraints:
    - `foreign key (household_id, return_id) references tax_returns (household_id, id) on delete cascade`;
    - `tax_return_events_figures_by_kind`: `processed` has `refund_determined` and `refund_interest` (≥ 0) set, `tds_allowed_total` null or ≥ 0, `amount` null; `refund_credited` and `offset_against_demand` have `amount > 0` and the other three null; `refund_failed` has the other three null and `amount` null or > 0;
    - the same note guard as `tax_returns`.
  - `tax_statements`: `id`, `household_id`, `member_id`, `financial_year`, `source` (`ais`, `26as`), `as_of date not null`, `imported_at timestamptz not null default now()`, `revision integer not null default 1`; `unique (member_id, financial_year, source)`, `unique (household_id, id)`, the member foreign key as `tax_returns`.
  - `tax_statement_lines`: `id`, `household_id`, `statement_id`, `symbol text`, `payer text not null` (1 to 200 characters after trimming, no identifier), `gross numeric(16,2) not null` (≥ 0), `tds numeric(16,2)` (≥ 0, at most `gross`); `foreign key (household_id, statement_id) references tax_statements (household_id, id) on delete cascade`; a unique index on `(statement_id, lower(btrim(payer)))`.
  - `holding_dividends.tax_financial_year integer` (2000 to 2100) and `holding_dividends.tax_year_basis text` (`declared`, `paid`, `statement`, `household`), with `holding_dividends_tax_year_with_basis`: both set or both null.
- Every foreign key gets an index led by its own columns (`tax_returns (household_id, member_id)`, `tax_return_events (household_id, return_id)`, `tax_statements (household_id, member_id)`, `tax_statement_lines (household_id, statement_id)`). `touch_updated_at` triggers on `tax_returns` and `tax_return_events`.
- **Access:** RLS on all four; one select policy each, `using (private.is_household_member(household_id))`; `revoke insert, update, delete … from anon, authenticated`.

- [ ] **Step 1: Write the failing cases** in `migration-behaviour.test.sql`, after `D3-01`, under a heading comment for dividend tax years. Fixture: a function `pg_temp.tx_holding(p_id uuid, p_symbol text, p_class text default 'india_equity')` inserting a holding in household `1111…` owned by member `2222…00b7`, not shared, with `price_symbol = p_symbol`. Cases, each raising `TX-nn FAILED: …` or noticing `TX-nn ok: …`:
  - `TX-01`: `private.financial_year_of('2026-03-31') = 2025`, `('2026-04-01') = 2026`, `('2025-12-31') = 2025`.
  - `TX-02`: each direct insert into `tax_returns` raises `check_violation`: revision 0 with a filed date; revision 1 without one; revision 0 with `dividend_tax = 100`; `claim_basis 'treaty'` without a rate; `dividend_tds_claimed 300` with `tds_claimed_total 200`. A second row for the same member and year raises `unique_violation`.
  - `TX-03`: `has_identifier` is true for `'ABCDE1234F'`, `'abcde1234f'` and `'ref 123456789012'`; false for `'Paid 1,20,000 on 5 Oct'`, `'Filed late'` and null. A note `'PAN ABCDE1234F'` on `tax_returns` and a payer `'ABC 123456789'` on a line raise `check_violation`.
  - `TX-04`: on `tax_return_events`, a `processed` row without `refund_determined`, a `refund_credited` row without `amount`, and a `refund_credited` row with `refund_interest` each raise `check_violation`; a `processed` row with `refund_determined -500` (a demand) and `refund_interest 0` is accepted.
  - `TX-05`: lines `'ABC Limited'` and `' abc limited '` in one statement raise `unique_violation`; a line with `gross -1`, or `tds 101` on `gross 100`, raises `check_violation`.
  - `TX-06`: updating a dividend to `tax_financial_year 2025` without a basis, or with `tax_year_basis 'other'`, raises `check_violation`.
  - `TX-07`: deleting member `2222…00b7` while it has a return raises `foreign_key_violation` (run it inside its own `begin … exception` block so the rest of the file goes on).
- [ ] **Step 2: Write the failing RLS case** in `rls-policies.test.sql`, after the dividend freshness case and before the household deletion. As superuser, for member `e1…0b` of household `d1…` and the same for member `e2…0a` of `d2…`: a 2025 return (revision 1, filed `'2026-07-20'`), a `processed` event on it (`'2026-09-01'`, determined 1000, interest 0), and a `26as` statement (`as_of '2026-06-15'`) with one line (symbol null, payer `'ABC Limited'`, gross 1000, tds 208). Signed in as `0b…`: each of the four tables shows exactly 1 row; an insert into `tax_returns`, an update of `tax_statement_lines` and a delete from `tax_return_events` each raise `insufficient_privilege`. Notice `tax years RLS ok: …`. (The household deletion that follows proves a household with tax rows can still be deleted.)
- [ ] **Step 3: Run** `bash .superpowers/sdd/2026-11-06-dividend-tax-years-pr1/sqltest.sh`. **Expected:** FAIL at `TX-01` (no function) and in the RLS case.
- [ ] **Step 4: Implement** section 1 of the migration: the two helpers, the tables, the columns, indexes, triggers, policies and revokes. A header comment says what the migration is for (SHR-366's tax years) and that nobody writes these tables directly.
- [ ] **Step 5: Run the same command.** **Expected:** all ok, earlier parts' cases included.
- [ ] **Step 6: Commit** (`Dividend tax years: the tables, the tax-year column and who reads them`).

### Task 2: Importing a statement

**Files:**
- Modify: `supabase/migrations/20261106120000_dividend_tax_years.sql`
- Test: `supabase/test/migration-behaviour.test.sql`, `supabase/test/rls-policies.test.sql`, `scripts/verify-concurrency.sh`

**Interfaces:**
- **Produces** `public.import_tax_statement(p_member_id uuid, p_financial_year integer, p_source text, p_as_of date, p_lines jsonb, p_expected_revision integer, p_replace_newer boolean default false) returns jsonb`, executable by `service_role` only.
  - **Caller:** `auth.uid()` null and `auth.role() = 'service_role'`, and `p_member_id` a member of some household (its household is the statement's); otherwise `not_member`.
  - **Input** (`bad_input` unless every one holds): `p_source` in (`ais`, `26as`); `p_financial_year` from 2000 to `financial_year_of(household_today())`; `p_as_of` from 1 April of the year to today; `p_expected_revision` not null and ≥ 0; `p_lines` a JSON array.
  - **Each line**, checked in order before anything is written, the refusal carrying `line` (0-based): an object with only the keys `symbol`, `payer`, `gross`, `tds` (`bad_input`); `gross` and `tds` JSON numbers, not strings (`bad_input`); `gross ≥ 0` with at most two decimals, `tds` the same and at most `gross`, `tds` present for `26as` (`bad_figures`); `payer` text, 1 to 200 characters after trimming (`bad_input`), with no identifier (`identifier_in_text`); `symbol` null, or the `price_symbol` of an `india_equity` holding of the household compared case-insensitively (`unknown_share`), stored in the holding's spelling; no payer twice, compared trimmed and lower-cased (`duplicate_payer`).
  - **Then:** takes `pg_advisory_xact_lock(hashtextextended('tax_statement:' || p_member_id || ':' || p_financial_year || ':' || p_source, 0))` and reads the held statement. If its `as_of` and lines (symbol, payer, gross, tds, ordered by payer) equal the call's: `{ok: true, statement_id, revision, lines, unchanged: true}`. Else, if its revision (0 when none) is not `p_expected_revision`: `stale`. Else, if `p_as_of` is before its `as_of` and not `p_replace_newer`: `older_than_held`. Else it inserts or updates the statement (`as_of`, `imported_at = now()`, `revision + 1` for an update), replaces the lines, and returns `{ok: true, statement_id, revision, lines, unchanged: false}`.

- [ ] **Step 1: Write the failing cases** (behaviour, as the service role, which the file already is by then). Fixture: holdings `TXA.NS` and `TXB.NS` (Task 1's `tx_holding`); `pg_temp.tx_import(p_source text, p_as_of date, p_lines jsonb, p_expected integer, p_replace boolean default false)` calling the import for member `2222…00b7`, year 2025.
  - `TX-08`: a `26as` import with lines `{symbol 'TXA.NS', payer 'TXA Limited', gross 1000, tds 208}` and `{symbol null, payer 'Old Co Limited', gross 500, tds 104}`, `as_of '2026-06-15'`, expected 0 → `ok`, `revision 1`, `lines 2`, `unchanged false`; the statement and both lines are stored, the second with a null symbol.
  - `TX-09`: the same call again with expected 0 → `ok`, `unchanged true`, `revision 1`; `imported_at` unchanged.
  - `TX-10`: TXA's `tds` changed to 210 with expected 1 → `revision 2`, 2 lines, TXA's `tds` 210. The same change to 212 with expected 1 → `stale`, TXA's `tds` still 210.
  - `TX-11`: `as_of '2026-05-01'` with expected 2 → `older_than_held`, nothing changed; with `p_replace_newer` → `ok`, `revision 3`.
  - `TX-12`: an `ais` import with `'[]'` → `ok`, `lines 0`; the statement exists with no lines.
  - `TX-13`: an `ais` import for 2024 with symbol `'txb.ns'` → `ok`, stored as `'TXB.NS'`. Then each of these against the held 2025 `26as` statement is refused and leaves it as it was: a third line with `gross -1` → `bad_figures`, `line 2`; `gross "1,000.50"` → `bad_input`; `gross 10.005` → `bad_figures`; symbol `'NOPE.NS'` → `unknown_share`; payers `'ABC Ltd'` and `'abc ltd '` → `duplicate_payer`; payer `'ABCDE1234F'` → `identifier_in_text`; a `26as` line without `tds` → `bad_figures`; `tds 101` on `gross 100` → `bad_figures`; a key `pan` → `bad_input`; year 2099 or `as_of` tomorrow → `bad_input`; a symbol held only by household `9999…` → `unknown_share`.
- [ ] **Step 2: Write the failing RLS case:** signed in as `0b…`, calling `import_tax_statement` for `e1…0b` raises `insufficient_privilege`.
- [ ] **Step 3: Write the failing race** in `scripts/verify-concurrency.sh`, before its final check, as "two imports of one statement at once": after the file's `seed`, for member `e1…0a`, year 2025, `26as`, one line with a null symbol (so no holding is needed); two sessions started together through the file's two-session pattern (pause 0.4 s, import as the service role with expected revision 0 and different `tds`, pause 0.6 s, commit). **Expected state:** one `"ok": true`, one `"error": "stale"`, one statement at revision 1 whose single line is the winner's.
- [ ] **Step 4: Run** the SQL script and `PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres npm run verify:concurrency`. **Expected:** FAIL at `TX-08`, in the RLS case and in the new race.
- [ ] **Step 5: Implement** section 2 of the migration.
- [ ] **Step 6: Run both commands.** **Expected:** all ok.
- [ ] **Step 7: Commit** (`Dividend tax years: importing the AIS and Form 26AS`).

### Task 3: Returns and what happened to them

**Files:**
- Modify: `supabase/migrations/20261106120000_dividend_tax_years.sql`
- Test: `supabase/test/migration-behaviour.test.sql`, `supabase/test/rls-policies.test.sql`

**Interfaces:**
- **Produces** `private.tax_caller(p_member_id uuid) returns jsonb`: `{household, member, actor}` or `{error: 'not_member'}`. The household is `p_member_id`'s; the actor is `private.trade_caller(household, p_member_id)` (a signed-in member of that household, or for the service role the member named). Any member may act on any member's return in their household.
- **Produces** `public.save_tax_return(p_member_id uuid, p_financial_year integer, p_change jsonb, p_expected_version integer) returns jsonb`, for `authenticated` and `service_role`:
  - `p_change` keys only from `claim_basis`, `claim_rate_pct`, `revision`, `filed_on`, `dividend_income`, `dividend_tax`, `dividend_tds_claimed`, `tds_claimed_total`, `note` (`bad_input`); a key present with null clears it; keys absent keep their value.
  - Locks the member's row for the year (`for update`). None held: `p_expected_version` must be 0 and it inserts (a `unique_violation` from a concurrent first save becomes `stale`); held: it must equal `version`.
  - Refusals, checked on the row as it would be, nothing saved: year outside 2000 to the current year (`bad_input`); basis without rate or rate without basis (`basis_needs_rate`); basis outside the list, revision below 0 or not an integer (`bad_input`); revision ≥ 1 without `filed_on` (`filed_on_needed`); any figure with revision 0 (`not_filed`); `filed_on` before 1 April of the following year (`filed_before_year_end`) or after today (`in_future`); a figure negative or with more than two decimals, or dividend tax credit claimed over the total (`bad_figures`); an identifier in the note (`identifier_in_text`); revision below the highest revision of the return's events (`events_on_later_revision`).
  - Saves with `version + 1` and `updated_by` = the actor; returns `{ok: true, id, version}`.
- **Produces** `public.save_tax_return_event(p_member_id uuid, p_financial_year integer, p_event jsonb, p_event_id uuid default null) returns jsonb`, same callers:
  - The member's return for the year must exist with revision ≥ 1 (`not_filed`). With `p_event_id`, that event must belong to it (`event_not_found`) and is replaced; without, one is added.
  - `p_event` keys only from `kind`, `revision`, `happened_on`, `refund_determined`, `refund_interest`, `tds_allowed_total`, `amount`, `note` (`bad_input`). `revision` defaults to the return's and must be 1 to the return's (`bad_input`). `happened_on` required, from 1 April of the following year (`bad_input`) to today (`in_future`). Figures as the table's kind rule, at most two decimals (`bad_figures`). Note guard as above.
  - Returns `{ok: true, id}`.
- **Produces** `public.remove_tax_return_event(p_member_id uuid, p_event_id uuid) returns jsonb`, same callers: the event must belong to a return of `p_member_id` (`event_not_found`); deletes it; `{ok: true}`.

- [ ] **Step 1: Write the failing cases** (behaviour, service role, member `2222…00b7`, year 2025 unless stated; each refusal asserts the row's `version` did not move):
  - `TX-14`: save `{claim_basis: 'treaty', claim_rate_pct: 10}` at 0 → `ok`, `version 1`, revision 0. Again at 0 → `stale`. At 1, `{revision: 1, filed_on: '2026-07-20', dividend_income: 10000, dividend_tax: 1000, dividend_tds_claimed: 2080, tds_claimed_total: 5000}` → `version 2`, the basis kept.
  - `TX-15`: each refused with its code: `{pan: 'x'}` → `bad_input`; `{claim_rate_pct: null}` (basis left) → `basis_needs_rate`; `{claim_basis: 'other'}` → `bad_input`; on a new year 2024, `{revision: 1}` → `filed_on_needed` and `{dividend_tax: 100}` → `not_filed`; `{filed_on: '2026-03-15'}` → `filed_before_year_end`; `{filed_on: <tomorrow>}` → `in_future`; year 2099 → `bad_input`; `{dividend_tax: -1}` and `{dividend_tax: 10.005}` → `bad_figures`; `{dividend_tds_claimed: 6000}` (total 5000) → `bad_figures`; `{note: 'ack 123456789012345'}` → `identifier_in_text`.
  - `TX-16`: on year 2024 not filed, a `processed` event → `not_filed`. On 2025: `{kind: 'processed', happened_on: '2026-09-01', refund_determined: 5000, refund_interest: 150, tds_allowed_total: 5000}` → `ok`, revision 1; `{kind: 'refund_credited', happened_on: '2026-09-20', amount: 5150}` → `ok`; `{kind: 'refund_credited', happened_on: '2026-09-20'}` → `bad_figures`; `{…, revision: 3}` → `bad_input`; `happened_on` tomorrow → `in_future`; `happened_on '2026-03-01'` → `bad_input`; replacing the credit by id with `amount 5100` → `ok`, one credit of 5100; removing it → `ok`; removing again → `event_not_found`; removing the processed event while naming member `9999…000a` (another household) or `2222…2222` (the same household, not the return's member) → `event_not_found`, and the event is still there.
  - `TX-17`: save `{revision: 2}` (a revised return) at the current version → `ok`, and the `processed` event keeps revision 1. Add a `refund_credited` event on revision 2 (`'2026-10-20'`, 100). Saving `{revision: 1}` → `events_on_later_revision`.
  - `TX-18`: `save_tax_return` with `p_member_id` null → `not_member`.
- [ ] **Step 2: Write the failing RLS case:** signed in as `0b…`: `save_tax_return` for `e1…0b` and for `e1…0a` (a partner in the same household) at version 0, year 2024 → `ok`; for `e2…0a` → `not_member`; `save_tax_return_event` on Task 1's fixture return → `ok`. Signed out (`set role anon`), `save_tax_return` raises `insufficient_privilege`.
- [ ] **Step 3: Run** the SQL script. **Expected:** FAIL at `TX-14` and in the new RLS case.
- [ ] **Step 4: Implement** section 3 of the migration.
- [ ] **Step 5: Run the same command.** **Expected:** all ok.
- [ ] **Step 6: Commit** (`Dividend tax years: returns, refunds and offsets`).

### Task 4: A dividend's own tax year

**Files:**
- Modify: `supabase/migrations/20261106120000_dividend_tax_years.sql`
- Test: `supabase/test/migration-behaviour.test.sql`, `supabase/test/rls-policies.test.sql`

**Interfaces:**
- **Consumes** `private.dividend_caller(p_dividend_id uuid, p_change jsonb, p_member_id uuid)` (part 2's), called with `'{}'::jsonb`.
- **Produces** `public.set_dividend_tax_year(p_dividend_id uuid, p_financial_year integer, p_basis text, p_expected_version integer, p_member_id uuid default null) returns jsonb`, for `authenticated` and `service_role`:
  - Caller and household from `dividend_caller` (`dividend_not_found`, `not_member`). Locks the holding, then the dividend, as `keep_dividend` does; `version` must equal `p_expected_version` (`stale`).
  - The holding is `india_equity` (`not_indian`). Year and basis both null (clears) or both set, basis in (`declared`, `paid`, `statement`, `household`) (`bad_input`). The year is from 2000 to the current year (`bad_input`) and within one of the financial year of `coalesce(credited_on, pay_date, ex_date)` when any is set (`year_too_far`).
  - Sets both columns, `version + 1`, `updated_by`; returns `{ok: true, version}`.

- [ ] **Step 1: Write the failing cases** (behaviour). Fixture, inserted directly: an Indian holding `TXD.NS` with a received dividend (10 units at 100, tax 20.8%: expected and received gross 1000, tax 208, net 792; evidence `intimation`, `credited_on '2026-04-10'`, ex-date `'2026-03-25'`, no destination), and a US holding (Task 1's `tx_holding` with `'us_equity'`) with an earned dividend.
  - `TX-19`: set 2025 `'declared'` at its version → `ok`, version + 1, both columns set; a sync of its holding (`private.sync_holding_dividends(holding, null)`) leaves them; set null, null → both cleared.
  - `TX-20`: the US dividend → `not_indian`; 2023 → `year_too_far`; `(2025, null)` and `(2025, 'other')` → `bad_input`; an old version → `stale`; an unknown id → `dividend_not_found`.
- [ ] **Step 2: Write the failing RLS case:** as superuser, an `india_equity` holding and a received dividend in each of `d1…` and `d2…`. Signed in as `0b…`: setting the year on `d1…`'s → `ok`; on `d2…`'s → `not_member`.
- [ ] **Step 3: Run** the SQL script. **Expected:** FAIL at `TX-19` and in the RLS case.
- [ ] **Step 4: Implement** section 4 of the migration.
- [ ] **Step 5: Run the same command.** **Expected:** all ok.
- [ ] **Step 6: Commit** (`Dividend tax years: a dividend's own tax year`).

### Task 5: Tax years from dividends, and the statement check

**Files:**
- Create: `src/lib/dividendTax.js`, `src/lib/dividendTax.test.js`

**Interfaces** (row shapes are the tables' columns, snake_case, as `supabase.from(...).select('*')` returns them):
- `financialYearOf(day: 'YYYY-MM-DD'): number`.
- `taxYearLabel(year: number): string`: below 2026, `'FY 2025-26 (AY 2026-27)'`; from 2026, `'tax year 2026-27'`.
- `dividendTaxYear(dividend): { year: number | null, provisional: boolean, basis: 'credit' | 'declared' | 'paid' | 'statement' | 'household' }`: the dividend's own year and basis when set (never provisional); else its `credited_on`'s year, basis `'credit'`, provisional when `credited_on_estimated`; year null without `credited_on`.
- `shareKey(holding): string`: `price_symbol`, else `'holding:' + id`. `lineKey(line): string`: `symbol`, else `'payer:' + payer` trimmed and lower-cased.
- `rokdaShareYears(holdings, dividends): { rows: ShareYear[], unassigned: Array<{ holdingId, name, count }> }`:
  - only Indian holdings' dividends with status `received` (confirmed, from `received_gross` and `received_tax`) or `presumed` (from `expected_gross` and `expected_tax`);
  - `ShareYear` = `{ memberId, year, key, name, provisional, confirmed: { count, gross, tax }, presumed: { count, gross, tax } }`, one per member, year and share, adding up holdings of the same share; `name` is the first holding's name by name;
  - a shared holding's, or one without an owner's, dividends go to `unassigned`, one entry per holding.
- `statementCheck({ shareYears, statements, lines }): ShareCheck[]`, one per member, year and share present in Rokda's rows or in a statement line of that member and year:
  - `ShareCheck` = `{ memberId, year, key, name, rokda: { confirmed, presumed, count }, ais: { gross, tds } | null, f26as: { gross, tds } | null, income: Comparison, tax: Comparison }`; `name` is Rokda's, else the line's payer;
  - `income` compares Rokda's gross (confirmed plus presumed) with the AIS line's `gross`; `tax` compares Rokda's tax with the 26AS line's `tds`. The AIS's `tds` and 26AS's `gross` are carried for display, never added to either;
  - `Comparison` = `{ difference: number | null, label, reasons: Reason[] }`, `difference` = statement minus Rokda, in rupees;
  - `label`: `'not_imported'` (no such statement for the member and year; difference null); `'only_in_statement'` (no Rokda dividends of that share that year); `'only_in_rokda'` (statement imported, no line for the share); `'agrees'` (0); `'within_rounding'` (at most ₹1 × Rokda's count of that share's dividends that year); else `'differs'` when there is a reason, `'unexplained'` when not;
  - `Reason` = `{ code: 'neighbouring_year', year }` when the same member, share and figure in the year before or after has a nonzero difference that offsets this one to within ₹1 × both years' counts; `{ code: 'extra_deduction' }` on `tax` when 26AS's `tds` is higher and its `gross` equals Rokda's within rounding; `{ code: 'presumed' }` when Rokda's figures include presumed dividends. Reasons go on `only_…`, `differs` and `unexplained` labels alike; never on `agrees`, `within_rounding` or `not_imported`.
- Sums: a private `paise(n) = Math.round(Number(n) * 100)`; every sum and difference in paise, returned as `paise / 100`.

- [ ] **Step 1: Write the failing tests**, with fixtures `IN_A` (`india_equity`, `price_symbol 'ABC.NS'`, owner `'m1'`, not shared), `IN_A2` (a second holding of `'ABC.NS'` for `'m1'`), `IN_S` (shared), `US` (`us_equity`) and a `div(holding, extra)` row builder:
  ```js
  expect(financialYearOf('2026-03-31')).toBe(2025);
  expect(financialYearOf('2026-04-01')).toBe(2026);
  expect(taxYearLabel(2025)).toBe('FY 2025-26 (AY 2026-27)');
  expect(taxYearLabel(2026)).toBe('tax year 2026-27');
  // A final declared on 30 March and paid on 10 April.
  expect(dividendTaxYear({ credited_on: '2026-04-10', credited_on_estimated: false })).toEqual({ year: 2026, provisional: false, basis: 'credit' });
  expect(dividendTaxYear({ credited_on: '2026-04-10', tax_financial_year: 2025, tax_year_basis: 'declared' })).toEqual({ year: 2025, provisional: false, basis: 'declared' });
  // A presumed dividend near 31 March.
  expect(dividendTaxYear({ credited_on: '2026-03-30', credited_on_estimated: true })).toEqual({ year: 2025, provisional: true, basis: 'credit' });
  ```
  - `'two holdings of the same share are one share'`: a received dividend on each of `IN_A` and `IN_A2` (gross 500, tax 104) → one row for `'ABC.NS'`, `confirmed { count: 2, gross: 1000, tax: 208 }`.
  - `'presumed figures are kept apart'`: one received (1000 / 208) and one presumed (expected 500 / 104) → `confirmed.gross 1000`, `presumed { count: 1, gross: 500, tax: 104 }`.
  - `'only Indian dividends counted as received'`: an earned, a skipped and a US received dividend add nothing.
  - `'a shared holding is listed apart'`: `IN_S`'s received dividend → `unassigned [{ holdingId: IN_S.id, name: IN_S.name, count: 1 }]`, no row.
  - `'a holding that became shared takes its past dividends along'` (Review Focus 4): the same dividend with `IN_A` changed to `is_shared: true` → in `unassigned`, not under `'m1'`.
  - `'a sold holding still makes a year'`: `IN_A` with `quantity: 0` → its row is there.
  - `'AIS income and 26AS gross are compared apart'`: Rokda 1000 / 208; AIS line gross 1000 tds 200; 26AS line gross 1000 tds 208 → `income { difference: 0, label: 'agrees' }`, `tax { difference: 0, label: 'agrees' }`, `ais.tds 200`.
  - `'within rounding over three dividends'`: three dividends, tax 100 each; 26AS tds 300.40 → `tax { difference: 0.4, label: 'within_rounding' }`.
  - `'small amounts add up exactly'` (Review Focus 3): taxes 0.10, 0.20, 0.30 against 0.60 → `'agrees'`.
  - `'tax higher with gross equal is a possible extra deduction'`: Rokda 1000 / 208; 26AS 1000 / 250 → `{ difference: 42, label: 'differs', reasons: [{ code: 'extra_deduction' }] }`.
  - `'counted in the neighbouring year'`: `'m1'`, ABC: 2025 AIS line gross 1000 and no Rokda dividend; 2026 Rokda dividend gross 1000 (credited 2026-04-10) and an AIS for 2026 without ABC → 2025 `income { label: 'only_in_statement', difference: 1000, reasons: [{ code: 'neighbouring_year', year: 2026 }] }`; 2026 `income { label: 'only_in_rokda', difference: -1000, reasons: [{ code: 'neighbouring_year', year: 2025 }] }`.
  - `'a share sold before our records is only in the statement'`: 26AS line `{ symbol: null, payer: 'Old Co Limited', gross: 500, tds: 104 }` → a check with key `'payer:old co limited'`, name `'Old Co Limited'`, `tax.label 'only_in_statement'`.
  - `'an empty statement is imported, not missing'`: a 26AS statement with no lines and a Rokda dividend → `tax.label 'only_in_rokda'`; no 26AS statement → `'not_imported'`, `difference: null`.
  - `'a difference with no explanation says so'`: Rokda 1000 / 208 confirmed; 26AS 1000 / 150 → `{ difference: -58, label: 'unexplained', reasons: [] }`.
  - `'presumed figures are offered as the possible cause'`: Rokda presumed only, 1000 / 208; 26AS 900 / 187.20 → `tax { difference: -20.8, label: 'differs', reasons: [{ code: 'presumed' }] }`.
- [ ] **Step 2: Run** `npx vitest run src/lib/dividendTax.test.js`. **Expected:** FAIL (no module).
- [ ] **Step 3: Implement** these exports in `src/lib/dividendTax.js`, with a header comment naming the spec and the paise rule.
- [ ] **Step 4: Run the same command.** **Expected:** PASS.
- [ ] **Step 5: Commit** (`Dividend tax years: tax years from dividends, and the statement check`).

### Task 6: Surplus, refund, estimate, and each member's years

**Files:**
- Modify: `src/lib/dividendTax.js`, `src/lib/dividendTax.test.js`

**Interfaces:**
- **Consumes** Task 5's exports.
- `dividendTaxSurplus({ taxReturn, f26asTds }): { amount: number | null, missing: Array<'return' | '26as'> }`: `amount = f26asTds − taxReturn.dividend_tax` when the return is filed (revision ≥ 1) with `dividend_tax` set and `f26asTds` is a number (26AS imported); else null, with what is missing.
- `refundState(taxReturn, events): { stage, determined, interest, credited, offset, unexplained }`:
  - `stage`: `'not_filed'` (no return or revision 0); `'filed'` (no `processed` event); `'demand'` (the latest processing's `refund_determined < 0`); `'no_refund'` (determined plus interest is 0); `'refund_due'` (nothing credited or offset); `'partly_settled'`; `'settled'` (credited plus offset at least determined plus interest);
  - the latest processing is the `processed` event with the highest revision, then the latest `happened_on`, then the latest `created_at`; it records the return's totals to date;
  - `credited` and `offset` add every `refund_credited` and `offset_against_demand` event of every revision; `refund_failed` adds nothing;
  - `unexplained` = determined + interest − credited − offset once processed with a refund (null otherwise), nonzero values included whatever their sign.
- `refundEstimate({ taxReturn, f26as, rokda }): null | { amount, presumedPart, claimBasis, ratePct, from: '26as' | 'rokda' }`: null unless the return has its own `claim_basis` and is not filed. With `f26as` (`{ gross, tds }`): `amount = tds − gross × rate / 100`, `presumedPart` null. Otherwise from `rokda` (`{ confirmed: { gross, tax }, presumed: { gross, tax } }`, the year's totals): `amount` = (confirmed plus presumed tax) − (confirmed plus presumed gross) × rate / 100, `presumedPart = presumed.tax − presumed.gross × rate / 100`. Rounded to the paisa.
- `taxRefusalMessage(code: string): string`: one sentence per error code (Global Constraints), exactly:
  - `not_member`: "This isn't someone in your household."
  - `bad_input`: "Something in this form isn't a valid year, date, choice or number."
  - `bad_figures`: "An amount is below zero, has more than two decimals, or is more than its total."
  - `stale`: "This changed since you opened it. Check it again."
  - `basis_needs_rate`: "Give the rate with the basis, or clear both."
  - `filed_on_needed`: "A filed return needs the date it was filed."
  - `not_filed`: "Mark the return filed before adding its figures or what happened to it."
  - `filed_before_year_end`: "A return can only be filed after its tax year has ended."
  - `in_future`: "That date is after today."
  - `identifier_in_text`: "Leave out PAN, account and acknowledgement numbers."
  - `events_on_later_revision`: "Something is recorded against a later revision. Remove it first."
  - `event_not_found`: "This is no longer there."
  - `dividend_not_found`: "This dividend is no longer there."
  - `not_indian`: "Only Indian dividends have a tax year here."
  - `year_too_far`: "A dividend can only move to the year next to the one it was credited in."
  - `unknown_share`: "That share isn't one of the household's Indian holdings."
  - `duplicate_payer`: "The same company is listed twice."
  - `older_than_held`: "A newer statement is already saved."
  - anything else: "That could not be saved. Nothing was changed."
- `taxYears({ holdings, dividends, statements, lines, returns, events }): { years: TaxYear[], unassigned }`:
  - one `TaxYear` per member and year that has a Rokda share-year, a statement or a return, sorted newest year first, then by member id;
  - `TaxYear` = `{ memberId, year, label, provisional, rokda: { confirmed, presumed }, statements: { ais: StatementInfo | null, f26as: StatementInfo | null }, shares: ShareCheck[], taxReturn: row | null, surplus, refund, estimate, basisReference }`;
  - `StatementInfo` = `{ revision, asOf, importedAt, lineCount, gross, tds }`, the totals over all its lines;
  - `provisional` when any of its share-years is; `shares` sorted by name;
  - `surplus` from 26AS's `tds` total; `refund` from the return's events; `estimate` from 26AS's totals when imported, else Rokda's;
  - `basisReference` = `{ year, claimBasis, ratePct }` from the year before's return when this year's has no basis and that one has; else null.

- [ ] **Step 1: Write the failing tests:**
  - `'the surplus is signed and needs both sides'`: return filed, `dividend_tax 1000`, 26AS tds 2080 → `{ amount: 1080, missing: [] }`; tds 800 → `amount -200`; no 26AS → `{ amount: null, missing: ['26as'] }`; revision 0 → `missing: ['return']`.
  - `'a surplus larger than the whole refund stays whole'`: a 26AS tds of 6000 against `dividend_tax 1000`, with a processing determining 3000 and a credit of 3000 → `surplus.amount 5000`, `refund { stage: 'settled', determined: 3000, unexplained: 0 }`: the surplus never makes the refund look short.
  - `'a zero refund is no refund'`: processed, determined 0, interest 0 → `stage 'no_refund'`, `unexplained null`.
  - `'interest and an offset'`: determined 10000, interest 300, offset 2000, credited 8000 → `'partly_settled'`, `unexplained 300`; with credited 8300 → `'settled'`, `unexplained 0`.
  - `'a revised return keeps the earlier credit'`: processed rev 1 determined 5000; credited rev 1 5000; return revision 2; processed rev 2 determined 5500 → `determined 5500`, `credited 5000`, `unexplained 500`, `'partly_settled'`.
  - `'a failed refund counts as nothing'`: processed 5000, `refund_failed`, credited 5000 → `'settled'`, `credited 5000`.
  - `'a demand'`: determined -500 → `stage 'demand'`, `unexplained null`.
  - `'no estimate without this year's basis'`: 2025 return treaty 10 filed; 2026 Rokda dividends, no return → 2026's `estimate null`, `basisReference { year: 2025, claimBasis: 'treaty', ratePct: 10 }`.
  - `'the estimate from Rokda shows the presumed part'`: 2026 return `{ claim_basis: 'treaty', claim_rate_pct: 10, revision: 0 }`; Rokda confirmed 8000 / 1664, presumed 2000 / 416 → `{ amount: 1080, presumedPart: 216, from: 'rokda' }`; with a 26AS of gross 10000 tds 2080 → `{ amount: 1080, presumedPart: null, from: '26as' }`; once filed → `null`.
  - `'a year appears for a return or a statement alone'`: a return for 2024 and nothing else → a 2024 year with no shares, `statements { ais: null, f26as: null }`.
  - `'years are newest first, and say they are provisional'`: a presumed dividend credited `'2026-03-30'` (estimated) and a received one in 2026 → years `[2026, 2025]`, 2025 `provisional true`.
  - `'every error code has a sentence'`: for each code in Global Constraints, `taxRefusalMessage(code)` is not the fallback; `taxRefusalMessage('nope')` is.
- [ ] **Step 2: Run** `npx vitest run src/lib/dividendTax.test.js`. **Expected:** FAIL on the new tests.
- [ ] **Step 3: Implement** the exports.
- [ ] **Step 4: Run the same command, then `npx vitest run` and `npx eslint src e2e`.** **Expected:** all pass.
- [ ] **Step 5: Commit** (`Dividend tax years: surplus, refund, estimate and each member's years`).

### Task 7: Decisions, checks, review and the pull request

**Files:**
- Modify: `docs/decisions.md`

- [ ] **Step 1: Add** `## Dividend tax years`, after "Dividends are their own records": a short section in the file's voice on what part 1 decided and why. That the AIS is for income and Form 26AS for tax credit. That the claim basis is per year and the estimate needs it. That the surplus or shortfall is apart from the refund. That a refund's principal is not income and its interest is. That a processing records the return's totals to date, while credits and offsets add up across revisions. That shares, not holdings, are compared. That a member with tax records cannot be removed. That PAN-shaped text and long numbers are refused in notes and payers. And that the documents are read in a working session and never kept.
- [ ] **Step 2: Run every check** in `CLAUDE.md` (lint, `npx vitest run`, the build, Playwright, the SQL script) and `npm run verify:concurrency`. **Expected:** all pass; a failure already on `main` (the flaky "overview: empty household" on the phone) is named, not hidden.
- [ ] **Step 3: Commit** (`Dividend tax years: the decisions behind part 1`), push, and run the final whole-branch review on the most capable model, then its fix pass.
- [ ] **Step 4: Open the pull request** "Dividend tax years, part 1: records, functions and sums", with a summary, the migration's new objects, the tests, and that it is not yet applied to production.
