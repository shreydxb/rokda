# Share trades: editors never undo a trade, and three guards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before the bot records any trade, make sure nothing in the app can undo a trade's effect, and close three gaps the step-1 review left open.

**Architecture:** One migration redefines `record_trade`, `delete_trade`, `open_trade_history` and `private.trade_effect` and widens one foreign key. The two editors stop sending figures a trade owns. The price feed's filter follows the new version rule. No new tables.

**Tech Stack:** Postgres (Supabase migration, plpgsql), React (Vite, Vitest + Testing Library), Deno edge function (price-refresh).

**Spec:** `docs/superpowers/specs/2026-10-27-share-trades-design.md` (sections 3, 9). Findings from the step-1 review, as recorded in Linear SHR-368 and SHR-370: I5, M2, M3, M5.

## Global Constraints

- Public repository: generic fixtures only ("Partner", round numbers), no household figures.
- One migration file, `supabase/migrations/20261028120000_trade_guards.sql`, renamed to production's version when applied.
- Applying: the migration drops and re-adds a foreign key, so Supabase's MCP asks for a confirmation this session cannot show. Apply it through the Supabase SQL Editor and record its history row with LF line endings, as for #145 (`docs/applied-migrations.json`, `npm run compare:migrations -- --strict`).
- Every new constraint, trigger rule or function behaviour gets a case in `supabase/test/migration-behaviour.test.sql`; every access rule a case in `supabase/test/rls-policies.test.sql`.
- Error codes are returned as `{"ok": false, "error": <code>}`, never raised, as in step 1.
- Comments explain why, in full sentences; match the surrounding density.

## Review Focus

1. An editor opened before go-live and saved after it: the save is refused like any other stale save, not applied over the opening entry.
2. A holding whose fresh start was undone and redone: a bot confirmation shown before the undo is refused (stale), never applied to the reopened holding.
3. Deleting an account that money moved through: the editor says to close it instead; it never shows a database error.
4. A signed-in member calling `record_trade` directly with `p_source => 'bot'` or a proposal id: refused, so only the bot can mark a trade as the bot's.
5. A traded, auto-priced holding renamed in a tab opened before the nightly price run: today's value and value point stay the feed's.

---

### Task 1: The database guards (M5, M2, M3)

**Files:**
- Create: `supabase/migrations/20261028120000_trade_guards.sql`
- Modify: `supabase/functions/price-refresh/index.ts` (the holdings filter, ~line 256)
- Test: `supabase/test/migration-behaviour.test.sql`, `supabase/test/rls-policies.test.sql`, `supabase/functions/_shared/scheduledCallers.test.ts`

**Interfaces:**
- Consumes: the step-1 functions in `supabase/migrations/20261028054814_holding_trades.sql`; each one this task changes is redefined whole with `create or replace`, its body otherwise unchanged.
- Produces:
  - `record_trade` returns `{"ok": false, "error": "not_allowed"}` when `auth.uid()` is set and `p_source <> 'app'` or `p_proposal_id is not null`.
  - The version rule: `trades_version > 0` means traded. A holding whose lone opening entry was deleted keeps its last version as a negative number, and going live again sets `abs(trades_version) + 1`. Every "untraded" test is `trades_version <= 0`.
  - `holdings_funds_account_fk` is `on delete set null (funds_account_id)`.

- [ ] **Step 1: Write the failing behaviour cases**, after B2-08:
  - **B2-60 (M2):**
    1. Open a fresh holding with `open_trade_history`, so its version is 1.
    2. `delete_trade` its opening entry: the version is `-1`, and its units can be edited by hand.
    3. `open_trade_history` again: the version is `2`.
    4. `record_trade(..., p_expected_version => 1)` returns `error = 'stale'`.
  - **B2-61 (M3):**
    - Deleting a broker funds account that is only a holding's default succeeds, and leaves that holding's `funds_account_id` null.
    - Deleting a fund with a buy recorded through it raises `foreign_key_violation`.
  - **Price-feed filter:** the existing test "price-refresh skips only holdings their trades have closed" expects `["(quantity.is.null,quantity.gt.0,trades_version.lte.0)"]`.
- [ ] **Step 2: Write the failing RLS case (M5)**, beside "trade functions ok". A signed-in member of the holding's household calls `record_trade`:
  - with `p_source => 'bot'`: `error = 'not_allowed'`;
  - with `p_source => 'app'` and any `p_proposal_id`: `error = 'not_allowed'`;
  - with `p_source => 'app'` and no proposal: `ok`.
- [ ] **Step 3: Run them to see them fail.**
  - Run: `bash scripts/verify-migrations.sh`, then the behaviour and RLS files as in CLAUDE.md, then the deno handler tests.
  - Expected: B2-60, B2-61 and the M5 case raise their FAILED messages; the price-feed test fails on the filter string.
- [ ] **Step 4: Write the migration.**
  - **M5:** in `record_trade`, right after the member check, return `not_allowed` for a signed-in caller passing another source or a proposal id.
  - **M2:**
    - `delete_trade`'s lone-opening branch sets `trades_version = -trades_version`, inside the `rokda.trade_replay` flag.
    - `open_trade_history` selects `h.trades_version <= 0` and sets `trades_version = abs(trades_version) + 1`. Its `shared_left` count uses `<= 0`.
    - `private.trade_effect` returns `no_opening` when `p_holding.trades_version <= 0`.
    - Update `comment on column holdings.trades_version` to say what a negative version means.
  - **M3:** drop `holdings_funds_account_fk` and add it again with `on delete set null (funds_account_id)`.
  - **Price feed:** change its filter to `.or("quantity.is.null,quantity.gt.0,trades_version.lte.0")`, with its comment.
- [ ] **Step 5: Run everything to see it pass.**
  - Run: verify-migrations, both SQL files, `scripts/verify-concurrency.sh`, the deno tests.
  - Expected: all ok, and no earlier B2 case changed outcome. Any earlier case that expected version 0 after deleting a lone opening now expects its negative; say so in the commit message.
- [ ] **Step 6: Commit.** "Trade guards: only the bot marks a trade as the bot's, versions never repeat, a fund that is only a default can be deleted".

### Task 2: The holding editor never undoes a trade (I5)

**Files:**
- Modify: `src/screens/wealth/HoldingEditor.jsx` (`handleSave`, ~lines 108–216)
- Test: `src/screens/wealth/HoldingEditor.test.jsx`

**Interfaces:**
- Consumes: `holding.trades_version` (Task 1's rule).
- Produces: nothing other tasks use.

- [ ] **Step 1: Extend the test's supabase mock.**
  - `update(row)` returns a builder whose `.eq(field, value)` calls accumulate filters.
  - Its `.select()` resolves to `{ data: [...rows updated], error: null }`, updating only rows that match every filter.
  - `upsert` keeps its current behaviour.
- [ ] **Step 2: Write the failing tests**, in the "a traded holding" describe:
  - **"refuses a save from before a trade, and writes nothing":**
    1. Seed a stored row with `trades_version: 2`.
    2. Render the editor with `trades_version: 1`, rename and submit.
    3. Expect the stored name unchanged, no history point, and on screen: "This holding changed after you opened it: a trade was recorded or it went live. Close it and open it again."
  - **"a traded, auto-priced holding's value is left to the price feed":**
    1. Seed `{ trades_version: 1, price_provider: 'twelvedata', price_symbol: 'ABC', quantity: 10, value_aed: 5000 }`.
    2. Render it with `value_aed: 4000` loaded, rename and submit.
    3. Expect the stored `value_aed` still 5000, the stored name changed, and `db.histories` empty.
  - **"an untraded holding still saves its value as before"** (the existing manual-value path, unchanged).
- [ ] **Step 3: Run them to see them fail.**
  - Run: `npx vitest run src/screens/wealth/HoldingEditor.test.jsx`
  - Expected: the two new cases FAIL; the old ones pass.
- [ ] **Step 4: Implement.**
  - **Existing holding:** update with `.eq('id', holding.id).eq('trades_version', holding.trades_version ?? 0).select('id')`. No row back: show the message above and write nothing else.
  - **Traded and `autoValued`:** remove `value_aed` from the payload and write no history point; the database values it under the holding's lock.
  - New holdings keep the upsert path.
- [ ] **Step 5: Run the editor tests and the whole suite.**
  - Run: `npx vitest run`
  - Expected: all pass.
- [ ] **Step 6: Commit.** "Holding editor: a save from before a trade is refused, and a traded holding's value is the feed's".

### Task 3: The account editor never undoes a fund movement, and explains a refused delete (I5, M3)

**Files:**
- Modify: `src/screens/wealth/AccountEditor.jsx` (`handleSave` ~line 98, `handleClose` ~line 148)
- Test: `src/screens/wealth/AccountEditor.test.jsx`

**Interfaces:**
- Consumes: Task 1's `on delete set null`. A fund with trades still fails with code `23503`.
- Produces: nothing other tasks use.

- [ ] **Step 1: Extend the mock** with `update(row).eq()` (records `{ table, row }` in `calls.updates`) and `delete().eq()` (resolves to a per-test result, default `{ error: null }`).
- [ ] **Step 2: Write the failing tests:**
  - **"renaming an account does not send its balance":** render an existing broker funds account, change only the name, submit. Expect the update row has no `balance` key.
  - **"changing the balance still sends it":** type a new balance and submit. Expect `balance` set to it.
  - **"an account money moved through is closed, not deleted, and says why":**
    1. Make the delete resolve `{ error: { code: '23503', message: 'violates foreign key' } }` and click through delete.
    2. Expect on screen: "Money moved through this account in recorded trades, so it can't be deleted. Close it instead: everything recorded through it stays."
    3. Expect the action button now closes (archives) the account.
    4. Expect the raw message not shown.
- [ ] **Step 3: Run them to see them fail.**
  - Run: `npx vitest run src/screens/wealth/AccountEditor.test.jsx`
  - Expected: the three new cases FAIL.
- [ ] **Step 4: Implement.**
  - **Save:** for an existing account, include `balance` only when the field differs from what the editor opened with (`initialForm(account).balance`). A new account always includes it.
  - **Delete:** on a `23503` error, switch the closure plan to archive and show the message above. Any other error shows as today.
- [ ] **Step 5: Run the whole suite.**
  - Run: `npx vitest run`
  - Expected: all pass.
- [ ] **Step 6: Commit.** "Account editor: a rename keeps a fund's balance, and a fund with trades is closed rather than deleted".

### Task 4: Docs, every check, the pull request

**Files:**
- Modify: `docs/decisions.md` (the two share-trades sections)

- [ ] **Step 1: Update the decisions doc.**
  - "Trades are the record of a holding": a version never repeats (negative after a fresh start is undone); only the bot marks a trade as the bot's.
  - "A broker's cash is an account": an editor never sends a balance or value it was not asked to change; a fund that is only a holding's default can be deleted; one with trades is closed.
- [ ] **Step 2: Run every check in CLAUDE.md.**
  - Run: eslint, vitest, the build, Playwright, deno check and test, verify-migrations, both SQL files, verify-concurrency.
  - Expected: all green.
- [ ] **Step 3: Open the PR** "Share trades: editors never undo a trade, and three guards". Name SHR-370's must-fix, and say that applying it goes through the SQL Editor.
