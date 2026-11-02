# Dividends, PR 2: receipts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dividend paid into a broker fund is received once a member confirms it (in the bot or the app) and moves the fund exactly once, across fixes, skips, moves between funds and balance check-ins. A member can fix, skip, add and review dividends in the holding editor. The bot asks each morning and stops logging dividends as income.

**Architecture:** One migration adds a single private function, `private.dividend_change`, that works out and (when saving) applies every member change to a dividend: Record, Fix, Skip, Restore, Add. It works out each fund's movement from the receipt as it was and as it will be, against the fund's current confirmation, so nothing about a receipt's balance effect is stored. `preview_dividend` and `save_dividend` are its two public faces, and the bot's `apply_bot_proposal` saves a morning question's lines through it in one transaction. The bot gets a `dividends_received` proposal sent by the morning check, and a guard on income messages. The app gets a Dividends list and form in the holding editor; the Dividends tab is PR 3.

**Tech Stack:** Postgres (Supabase), plpgsql and SQL tests; Deno (the Telegram bot) with its handler tests; React/Vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-dividends-design.md`: sections 5.4–5.6, the PR 2 row of section 8 and its scenarios marked 2. PR 1 (`docs/superpowers/plans/2026-11-02-dividends-pr1-records-and-feed.md`, shreydxb/rokda#152) must be merged first. Start this branch from `main` after it is.

## Global Constraints

- The repository is public: generic names and round figures in tests, fixtures, docs, commits and PR text ("the dollar broker's fund", "ABC", 100, 7).
- One migration: `supabase/migrations/20261103120000_dividend_receipts.sql`. It is not applied to production until the household says "apply and merge".
- New behaviour cases are `D2-01` onwards in `supabase/test/migration-behaviour.test.sql`, reusing PR 1's fixtures and `pg_temp` helpers (`d1_holding`, `d1_trade`, `d1_events`). New callable functions get member and signed-out cases in `supabase/test/rls-policies.test.sql`.
- **The balance rule (spec 5.4).** A receipt contributes its `received_net` to a fund when, and only when:
  - its status is `received`;
  - its `paid_into_account_id` is a `broker_funds` account;
  - `private.trade_moves_fund(fund.balance_as_of, credited_on, null)` is true.

  Every change moves each fund by (what the receipt will contribute) − (what it contributes now), both against the fund's current `balance_as_of`, rounded to 2 places.
- **Lock order (spec 3.7):** the holdings concerned (id order), then the dividend rows, then the funds (`private.lock_funds`, id order). Each confirmation is read only after its fund is locked.
- **Figures:** received net is always worked out as gross − tax − fees, from what the client sends. A client's net is never taken.
- **Error codes,** returned as `{"ok": false, "error": <code>}` and never raised:
  - `not_member`, `dividend_not_found`, `holding_not_found`, `bad_input`, `bad_figures`;
  - `currency_mismatch`, `fund_archived`, `stale` (the dividend's version changed);
  - `fund_confirmed_since` (a fund's `balance_as_of` differs from the one previewed);
  - `needs_answer` (the receipt is dated on or before its fund's confirmation and `already_included` was not given);
  - `already_linked`, `wrong_status`.
- **Movements** go through `private.move_fund(fund, delta, source, member)` with source `app` or `bot`, so `account_balance_events` records them as trades' are.
- **Copy:** the bot's messages use the exact text in Task 5. The app's labels are in Tasks 7 and 8.

## Review Focus

1. **A fund whose balance was never confirmed** (`balance_as_of` null): every receipt into it moves it, and no "already in it?" question is asked. Pinned in Task 1 (`D2-03`).
2. **A received dividend whose fund was later archived:** fixing or skipping it refuses with `fund_archived` instead of moving a closed account. Pinned in Task 1 (`D2-09`).
3. **A shared holding** (no owner): every linked member is asked. The second "yes" saves nothing and says it was already recorded. Pinned in Task 6.
4. **A holding with no fund** (no destination): Record marks it received and moves nothing. Pinned in Task 1 (`D2-07`).
5. **An Indian dividend presumed received, then fixed with the email's figures:** it becomes received, its net takes the email's figures, and no balance moves. Pinned in Task 1 (`D2-07`).

---

### Task 1: Receipts and the balance rule

**Files:**
- Create: `supabase/migrations/20261103120000_dividend_receipts.sql`
- Test: `supabase/test/migration-behaviour.test.sql`, `supabase/test/rls-policies.test.sql` (append)

**Interfaces:**
- Produces:
  - `private.dividend_contribution(p_status text, p_net numeric, p_credited_on date, p_account_id uuid) returns numeric`: the balance rule above, reading the account as it now is.
  - `private.dividend_change(p_dividend_id uuid, p_change jsonb, p_member uuid, p_save boolean, p_expected_version integer, p_expected_confirmations jsonb, p_source text) returns jsonb`.
  - `public.preview_dividend(p_dividend_id uuid, p_change jsonb, p_member_id uuid default null) returns jsonb`.
  - `public.save_dividend(p_dividend_id uuid, p_change jsonb, p_expected_version integer, p_expected_confirmations jsonb, p_member_id uuid default null) returns jsonb`.
  - Both public functions are callable by `authenticated` (the caller must be a member of the dividend's household, through `private.trade_caller`) and by `service_role` (with `p_member_id`).
  - **`p_change`:**
    - `action`: one of `record`, `fix`, `skip`, `restore`, `add`.
    - Optional fields: `credited_on` (date), `received_gross`, `received_tax`, `received_fees` (numbers), `units`, `per_share`, `tax_pct`, `expected_fees`, `paid_into_account_id`, `already_included` (boolean), `note`.
    - For `add` only: `holding_id`, `ex_date`, `pay_date`, `record_date`.
    - Service role only: `evidence` (`intimation`) and `import_ref`.
  - **Returns** `{ok: true, ...}` with:
    - `dividend`: the row as it would be, or is, after the change;
    - `movements`: `[{account_id, account_name, currency, delta, balance_after}]`;
    - `confirmations`: `{<account_id>: <balance_as_of or null>}` for every fund touched;
    - `version`;
    - `asks`: `"already_included"` or null;
    - `warnings`.
- Behaviour of each action:
  - **record:** earned or presumed → `received`, evidence `member` (or `intimation` from the service role).
    - Received figures default to the expected ones.
    - `credited_on` defaults to `pay_date`, or today when there is none.
    - If the destination is a broker fund confirmed on or after `credited_on`'s moment, `asks` is `already_included`. A save then needs `already_included`: true keeps `credited_on` (no movement); false sets `credited_on` to today (moves).
  - **fix:** any status except skipped. Changes the fields given and sets `fixed = true`.
    - On an earned or presumed row, expected figures are worked out again from `units`, `per_share`, `tax_pct` and `expected_fees`.
    - Giving received figures on a presumed row turns it `received`, with evidence `member`.
  - **skip:** sets `status = 'skipped'`, reversing whatever it contributes.
  - **restore:** skipped → `earned`, with received figures and `credited_on` cleared. Nothing moves.
  - **add:** a new row with `source = 'app'` (or `import` with an `import_ref`) and `units_basis = 'stated'`.
    - It is `received` when `credited_on` is given, and `earned` otherwise. An earned add needs an `ex_date`.
    - A rerun with the same `import_ref` returns the existing row with `ok: true` and moves nothing.

- [ ] **Step 1: Write the failing behaviour cases.**

  Unless a case says otherwise: a dollar broker fund, balance 100, confirmed at the start of the 1st of last month; a USD holding with an earned dividend, net 7, pay date the 5th of last month, destination the fund. Every case asserts the fund's exact final balance.

  - `D2-01`: record, then save with the preview's version and confirmations: received; fund 107; one `account_balance_events` row of +7 with source `app`.
  - `D2-02` (the spec 5.4 table, one assertion per row):
    - fixed to 6.8 net → 106.8;
    - then the fund confirmed at 106.8 on the 10th, and fixed to 6.6 → 106.8 (no movement);
    - a receipt on the 5th whose credit date moves to the last day of the month before → −7;
    - a receipt moved to fund B (confirmed on the 6th) → A −7, B unchanged;
    - skip after the confirmation → −7, then restore → no movement;
    - skip when the fund was confirmed on the 7th → no movement.
  - `D2-03`: a fund never confirmed: record moves it, and `asks` is null.
  - `D2-04`: a fund confirmed on the pay date: the preview `asks` `already_included`. A save without the answer returns `needs_answer`. With `already_included: true` it ends at 100; with `false` (on a fresh row) at 107, `credited_on` today.
  - `D2-05`: a save at an older version returns `stale`; a save after the fund was confirmed since the preview returns `fund_confirmed_since`; in both, nothing changes.
  - `D2-06`: fix with received gross 10, tax 3, fees 0.5 stores net 6.5. Gross 10 with tax 11 returns `bad_figures`.
  - `D2-07`: a presumed INR dividend into a bank account, fixed with received figures, becomes received with evidence `member` and moves nothing. A holding with no fund records with no movement.
  - `D2-08`: `paid_into_account_id` in another currency returns `currency_mismatch` from the preview, and the save changes nothing.
  - `D2-09`: a received dividend whose fund is now archived: skip returns `fund_archived`.
  - `D2-10`: add with `credited_on` and figures creates a received row (source `app`, `units_basis` `stated`) and moves the fund. Add with neither `ex_date` nor `credited_on` returns `bad_input`. As the service role, add with `import_ref` `X1` twice gives one row and one movement.
- [ ] **Step 2: Write the failing RLS cases.** A member can `preview_dividend` and `save_dividend` their household's dividend; on another household's they get `not_member`; signed out (anon), calling either raises `insufficient_privilege`.
- [ ] **Step 3: Run the SQL test run** (as in PR 1's plan). Expected: FAIL at `D2-01` (function missing).
- [ ] **Step 4: Implement** the four functions.
  - **Locking:** lock the holding (`select … for update`), then the row, then `private.lock_funds(array[old destination, new destination])`. Only then compute the contributions.
  - **Preview:** runs the same code with `p_save = false` and writes nothing.
  - **Save:** compares the row's `version` with `p_expected_version`, and each touched fund's `balance_as_of::text` with `p_expected_confirmations`, before writing. It raises `version` by 1, and calls `private.move_fund` for each non-zero delta.
  - **Destination:** it must be in the row's currency (`currency_mismatch`). An archived fund refuses any non-zero movement (`fund_archived`).
- [ ] **Step 5: Run the SQL test run.** Expected: `D2-01` to `D2-10` and the new RLS case print `ok`, and every PR 1 case still passes.
- [ ] **Step 6: Commit** (`Dividends: receipts and the balance rule`).

### Task 2: Review and one-off answers

**Files:**
- Modify: `supabase/migrations/20261103120000_dividend_receipts.sql`
- Test: `supabase/test/migration-behaviour.test.sql`, `supabase/test/rls-policies.test.sql`

**Interfaces:**
- Consumes: PR 1's `review_baseline`, `review_reason`, `review_event_id`, `dividend_special_parts`, and `earn_dividends`.
- Produces:
  - `public.keep_dividend(p_dividend_id uuid, p_expected_version integer, p_member_id uuid default null) returns jsonb`.
    - Sets `review_baseline` to `{"per_share", "units", "ex_date"}` from the row as it stands now (the units as `private.units_on_ex_date` gives them, so a kept `trades_changed` is not raised again), plus `"not_duplicate_of": review_event_id` when the reason is `possible_duplicate`.
    - Clears `review_reason` and `review_event_id`, and raises the version.
  - `public.link_dividend(p_dividend_id uuid, p_event_id uuid, p_expected_version integer, p_member_id uuid default null) returns jsonb`.
    - For a `possible_duplicate`: sets `event_id` and keeps the row's figures.
    - Sets the baseline's `per_share` to the event's amount, and clears the flag.
    - Returns `already_linked` if the holding already has a row on that event.
  - `public.set_special_part(p_event_id uuid, p_special_per_share numeric, p_member_id uuid default null) returns jsonb`.
    - Upserts the household's answer; null deletes it.
    - The household comes from the member; the event must be one a holding of theirs has a row on.

- [ ] **Step 1: Write the failing cases:**
  - `D2-11`: a received row flagged `feed_changed`, then `keep_dividend`, then `earn_dividends()`: not flagged again. A `trades_changed` row kept, then `earn_dividends()`: not flagged again.
  - `D2-12`: a `possible_duplicate` kept: not raised again for the same event.
  - `D2-13`: `link_dividend` on a `possible_duplicate`: one row, linked; `earn_dividends()` makes no second row.
  - `D2-14`: `set_special_part` with 66 on an event of 76: stored. With 80: `bad_figures`. With null: removed. On an event no holding of the household has: `not_member`.
  - RLS: a member calls all three on their own household's rows, and gets `not_member` on another household's.
- [ ] **Step 2: Run the SQL test run.** Expected: FAIL at `D2-11`.
- [ ] **Step 3: Implement** the three functions, each locking the holding and then the row, and checking the version where it takes one.
- [ ] **Step 4: Run the SQL test run.** Expected: all `D2-*` and RLS cases `ok`.
- [ ] **Step 5: Commit** (`Dividends: review and one-off answers`).

### Task 3: The bot's proposal and its "yes"

**Files:**
- Modify: `supabase/migrations/20261103120000_dividend_receipts.sql`
- Test: `supabase/test/migration-behaviour.test.sql`

**Interfaces:**
- Consumes: `private.dividend_change` (Task 1).
- Produces:
  - `bot_proposals_kind_check` gains `dividends_received`.
  - `holding_dividends.asked_at timestamptz` (when the morning question about it went out).
  - `telegram_notification_prefs.dividends_enabled boolean not null default true`.
  - `public.mark_dividends_asked(p_ids uuid[], p_asked boolean default true) returns void`, service role only: sets `asked_at` to now, or clears it when `p_asked` is false (a question to send again).
  - **Payload of a `dividends_received` proposal:**
    - `fund_id`, `fund_name`, `currency`;
    - `confirmation`: the fund's `balance_as_of` when asked, or null;
    - `ask`: `"already_included"` or null;
    - `answer`: `"included"` or `"not_included"`, set by the bot before applying a reply to an `ask` question;
    - `lines`: `[{dividend_id, version, holding_name, units, per_share, gross, tax, fees, net, pay_date}]`;
    - `total`.
  - **`apply_bot_proposal`:** recreated whole, verbatim from `20261031092242_bot_trades.sql`, with one branch added after the `rokda.balance_source` lines.
    - For `dividends_received` it calls `private.apply_dividends_proposal(v_proposal)`.
    - It marks the proposal `applied` with `result = {kind, lines: [...saved figures], total, moved}`, or `expired` with `{kind, error}`.
    - It returns `outcome` `applied`, `stale` or `refused`, as the trade branch does.
  - **`private.apply_dividends_proposal(p_proposal public.bot_proposals) returns jsonb`:**
    - Locks the lines' holdings (id order), then the rows, then the fund.
    - Checks every line's version and the fund's `balance_as_of` against the payload. Any difference saves nothing and gives `{ok: false, error: 'stale'}`.
    - Otherwise saves each line through `private.dividend_change(..., p_save := true, p_source := 'bot')`, with `credited_on = pay_date` and `already_included = (answer = 'included')` when `ask` is set. All lines save in one subtransaction, so a refused line rolls every line back.

- [ ] **Step 1: Write the failing cases:**
  - `D2-15`: a proposal with two lines (nets 7 and 3.5) applied: both received; fund 110.5; status `applied`. Applied again: outcome `applied` from the stored result, still 110.5.
  - `D2-16`: one line's dividend fixed after the proposal was made: outcome `stale`; neither line received; fund 100.
  - `D2-17`: the fund confirmed after the proposal was made: outcome `stale`; nothing saved.
  - `D2-18`: an `ask` proposal answered `included`: received, `credited_on` the pay date, fund unchanged. Answered `not_included`: received, `credited_on` today, fund moved.
  - `D2-19`: `mark_dividends_asked` sets `asked_at`, and with `false` clears it; as `authenticated` it raises `insufficient_privilege`.
- [ ] **Step 2: Run the SQL test run.** Expected: FAIL at `D2-15`.
- [ ] **Step 3: Implement.** Extract the current `apply_bot_proposal` with a script, as PR 1 did for `schedule_all_jobs`, so its other branches stay byte-for-byte the same, and add the branch.
- [ ] **Step 4: Run the SQL test run.** Expected: all cases `ok`, including PR 1's and the existing `B3-*` proposal cases.
- [ ] **Step 5: Commit** (`Dividends: the bot's dividends proposal`).

### Task 4: Races

**Files:**
- Modify: `scripts/verify-concurrency.sh`

**Interfaces:**
- Consumes: `save_dividend` and `apply_bot_proposal`.

- [ ] **Step 1: Add two races**, in the style of the existing ones, both on a fund confirmed at 100 with an earned dividend of net 7:
  - **Two members save the same dividend at once:** both call `save_dividend` with the same version. Expected: one succeeds, the other returns `stale`; fund `107.00`; one balance event.
  - **A receipt against a check-in that already includes it:**
    - session one previews before the check-in, then saves after it;
    - session two confirms the fund at 107 as of the credit day (an `update accounts set balance = 107, balance_as_of = …`).

    Expected: the save returns `fund_confirmed_since`, and the fund ends at `107.00`. Run once with each session first.
- [ ] **Step 2: Run** `PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres bash scripts/verify-concurrency.sh`. Expected: every race `ok`.
- [ ] **Step 3: Commit** (`Dividends: races for receipts`).

### Task 5: The bot's messages

**Files:**
- Create: `supabase/functions/telegram-webhook/dividends.ts`, `supabase/functions/telegram-webhook/dividends.test.ts`

**Interfaces:**
- Consumes: `formatMoney(amount: number, currency: string): string` from `./trades.ts`.
- Produces:
  - `type DividendLine = { holding_name: string; units: number; per_share: number; gross: number; tax: number; fees: number; net: number; pay_date: string }`.
  - `dividendsQuestion(fundName: string, currency: string, lines: DividendLine[], ask: { confirmedOn: string } | null): string`.
  - `dividendsSavedMessage(result: { lines: Array<DividendLine & { moved: number }>; total: number }, repeat: boolean): string`.
  - `dividendsDropSummary(payload: { fund_name: string; currency: string; total: number; lines: unknown[] }): string`.
  - `readsAsDividend(text: string | null | undefined): boolean`.
  - `DIVIDEND_GUARD_REPLY: string`.

- [ ] **Step 1: Write the failing tests:**
  - **`dividendsQuestion`, plain:**
    - for two lines it is exactly:

      ```
      Dividends due in Dollar funds today:
      ABC: 40 × $0.25 = $10.00, $3.00 withheld, $7.00
      XYZ: 10 × $0.50 = $5.00, $1.50 withheld, $3.50
      Reply "yes" (or react 👍) once they are in the fund to add $10.50, or "no" to leave them for the app.
      ```
    - a line with fees adds `, $0.20 fees` before its net.
  - **`dividendsQuestion`, with `ask`:** the last line is instead:

    ```
    Your fund's balance was confirmed on 12 Nov. Was this already in it? Reply "yes" if it was (nothing is added), or "no" if it arrived after (adds $10.50).
    ```
  - **`dividendsSavedMessage`:**
    - `Recorded: $10.50 into Dollar funds.` followed by each line;
    - when nothing moved, `Recorded as already in the fund's balance: $10.50.`;
    - with `repeat`, starts `Already recorded:`.
  - **`readsAsDividend`:**
    - true for `"ABC dividend credit"`, `"DIVIDEND"` and `"div credit ABC"`;
    - false for `"salary"`, `"divine pizza"` and `"individual"`;
    - a `\bdividends?\b` or a `\bdiv\b` match.
  - **`DIVIDEND_GUARD_REPLY`** is exactly: `That looks like a dividend. Rokda records dividends from your shares' own records, so I haven't logged it as income. You'll find it on the holding, under Wealth → Investments.`
- [ ] **Step 2: Run** `cd supabase/functions && deno test --node-modules-dir=none --allow-read telegram-webhook/dividends.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `dividends.ts`. Dates are shown as day and short month, as `trades.ts` shows them.
- [ ] **Step 4: Run the same command.** Expected: PASS. Delete `deno.lock`.
- [ ] **Step 5: Commit** (`Dividends: the bot's messages`).

### Task 6: The bot asks, applies and guards

**Files:**
- Modify: `supabase/functions/telegram-webhook/index.ts`, `supabase/functions/telegram-webhook/index.test.ts`
- Modify: `CLAUDE.md` and `.github/workflows/ci.yml` (add `telegram-webhook/dividends.test.ts` to the Deno test lists)

**Interfaces:**
- Consumes: Task 3's payload and RPCs, and Task 5's exports.
- Produces:
  - **`runDividendCheck(): Promise<{ checked: number; asked: number }>`**, added to the `run_recurring_check` list and its JSON response as `dividends`, and switched off by `dividends_enabled`. For each `earned` dividend with `asked_at` null, `pay_date` on or before today and a destination of type `broker_funds`:
    - **who is asked:** the holding's owner, or for a shared holding (owner null) every member with a linked Telegram;
    - **grouping:** one proposal per member per fund. Lines with a `pay_date` after the fund's `balance_as_of` Dubai date go in a plain proposal; the rest go in an `ask` proposal;
    - **dedupe key:** `source_ref` `dividends:<member>:<fund>:<today>:<plain|ask>`;
    - **sending:** after a message is sent, `prompt_message_id` is set and `mark_dividends_asked` is called. A message that fails to send leaves nothing asked, and the proposal is discarded as `askAutopay` does.
  - **Decisions:** `decideProposal` handles `dividends_received`:
    - **plain proposal:** "yes" or 👍 applies; "no" cancels with `Left for the app: <dividendsDropSummary>. Nothing was recorded.`;
    - **`ask` proposal:** "yes" sets `payload.answer = 'included'` then applies; "no" sets `'not_included'` then applies (both record);
    - **result:** `applied` replies `dividendsSavedMessage`. `stale` replies `Something changed since I asked, so nothing was recorded. Here it is again:` and re-asks those lines (it clears their `asked_at` through `mark_dividends_asked(…, false)`); `refused` gives the reason.
  - **The guard:** in the capture loop, an item of kind `income` where `readsAsDividend(item.merchant) || readsAsDividend(rawText)` writes no intake for that item. If it was the message's only item, its intake row is set `rejected` and the reply is `DIVIDEND_GUARD_REPLY`. Other items in the message are captured as before.

- [ ] **Step 1: Write the failing handler tests** in `index.test.ts`, extending its fake backend with `holding_dividends`, `holdings`, `accounts` rows and the `mark_dividends_asked` and `apply_bot_proposal` RPCs:
  - the morning check asks the owner once about an earned dividend due today, with the exact plain text, and sets `asked_at`; a second run asks nothing;
  - a shared holding's dividend is asked of both linked members;
  - a dividend not yet due, or into a bank account, is not asked about;
  - with `dividends_enabled` false, nothing is asked;
  - a fund confirmed after the pay date gets the `ask` text;
  - "yes" applies and replies `Recorded: …`; on an `ask` proposal, "no" applies with `answer: not_included`;
  - a `stale` outcome re-asks with the lead line;
  - `"ABC dividend credit 700"`, read by the fake model as one income item, writes no pending intake, sets the row `rejected`, and replies with `DIVIDEND_GUARD_REPLY`; `"salary 7000"` is captured as before.
- [ ] **Step 2: Run** the bot test command from `CLAUDE.md`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the check, the decision handling and the guard.
- [ ] **Step 4: Run** `deno check --node-modules-dir=none telegram-webhook/index.ts` and the bot test command. Expected: all pass. Delete `deno.lock`.
- [ ] **Step 5: Commit** (`Dividends: the morning question and the income guard`).

### Task 7: The app's dividend helpers

**Files:**
- Create: `src/lib/dividends.js`, `src/lib/dividends.test.js`

**Interfaces:**
- Produces (PR 3 extends this file):
  - `dividendsOfHolding(rows, holdingId)`: that holding's rows, newest first by `coalesce(ex_date, credited_on)`.
  - `dividendStatusText(row)`: `Earned`, `Received`, `Presumed received, not checked`, or `Skipped`.
  - `reviewText(row)`, exactly:
    - `trades_changed`: `A trade changed the units held on the ex-date after this was recorded.`
    - `feed_changed`: `The feed's amount per share has changed since this was recorded.`
    - `moved_ex_date`: `The feed no longer lists this dividend on this date.`
    - `possible_duplicate`: `The feed has a dividend close to this date. Is it this one?`
    - `split_on_ex_date`: `A split took effect on this ex-date, so its units may be on the wrong basis.`
    - none: null.
  - `canRecord(row)`: true when the status is `earned` or `presumed` (a presumed one is recorded to mark it checked).
  - `dividendRefusalMessage(code)`: one sentence for each Global Constraints error code, for example `stale` → `This dividend changed since you opened it. Check it again.`, `fund_confirmed_since` → `The fund's balance was confirmed since you checked. Check again.`, `needs_answer` → `Say whether this was already in the fund's confirmed balance.` A code with no sentence gets `That could not be saved. Nothing was changed.`
- [ ] **Step 1: Write the failing tests** for each export, with the exact strings above.
- [ ] **Step 2: Run** `npx vitest run src/lib/dividends.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** (`Dividends: the app's dividend helpers`).

### Task 8: Dividends in the holding editor, and the Telegram switch

**Files:**
- Create: `src/screens/wealth/HoldingDividends.jsx`, `src/screens/wealth/HoldingDividends.test.jsx`, `src/screens/wealth/DividendForm.jsx`, `src/screens/wealth/DividendForm.test.jsx`
- Modify: `src/screens/useOverviewData.js` (load `holding_dividends` and `dividend_special_parts` for the household, as `holdingDividends` and `dividendSpecialParts`), `src/screens/wealth/Investments.jsx` and `src/screens/wealth/HoldingEditor.jsx` (pass and show them), `src/screens/settings/Telegram.jsx` and its test (the `dividends_enabled` switch).

**Interfaces:**
- Consumes: Task 1's and Task 2's RPCs, and Task 7's helpers.
- Produces:
  - **`HoldingDividends({ holding, dividends, specialParts, accounts, failed, disabledReason, onChanged, onFormOpen })`.**
    - A section "Dividends", shown for any holding that `paysDividends`, under the trades section, in its markup and styles (`HoldingTrades.css`).
    - Each row shows its date, status (`dividendStatusText`), units × per share, net, and destination, with `reviewText` when flagged.
    - Its actions:
      - `Record` when `canRecord`;
      - `Fix`;
      - `Skip`, or `Restore` when skipped;
      - for a flagged row, `Keep as it is` (`keep_dividend`), and for a possible duplicate, `It's this one` (`link_dividend`);
      - for a row with an event, `Part was a one-off…`, which asks the one-off amount per share and calls `set_special_part`.
    - Under the list, `Add a dividend`.
    - Every action is off while the holding has unsaved changes (`disabledReason`, as trades are).
  - **`DividendForm({ holding, dividend, action, accounts, onCancel, onSaved })`.**
    - Fields for the action: credit date, received gross/withheld/fees for `record` and `fix`, plus units, per share and withholding for `fix` and `add`, and ex-date for `add`.
    - `Check` calls `preview_dividend` and shows the net, each movement (`Adds $7.00 to Dollar funds`, `Takes $2.00 from Dollar funds`, or `Moves no balance`) and, when `asks` is `already_included`, a required choice: `Already in the balance confirmed on <date>` / `Arrived after it`.
    - `Save` calls `save_dividend` with the preview's `version` and `confirmations`. Changing any field clears the check.
    - A refusal shows `dividendRefusalMessage` and keeps what was typed.
- [ ] **Step 1: Write the failing tests:**
  - **HoldingDividends:**
    - an earned broker-fund row shows `Record`; a presumed bank row shows `Presumed received, not checked` and `Record`; a skipped row shows `Restore`;
    - a `possible_duplicate` row shows its review text and `It's this one`;
    - actions are disabled with the reason when `disabledReason` is set;
    - `failed` shows `Couldn't load this holding's dividends.` and no actions.
  - **DividendForm:**
    - `Check` sends the change and shows `Adds $7.00 to Dollar funds`;
    - an `asks` answer must be chosen before `Save` is enabled;
    - `Save` sends `p_expected_version` and `p_expected_confirmations` from the preview;
    - changing a field after `Check` disables `Save`;
    - a `stale` answer shows its sentence and keeps the fields.
  - **Telegram settings:** the `Dividends` switch saves `dividends_enabled`, with the note `Each morning, asks about dividends paid into a broker fund that day; reply "yes" once they're in`.
- [ ] **Step 2: Run** `npx vitest run src/screens/wealth/HoldingDividends.test.jsx src/screens/wealth/DividendForm.test.jsx src/screens/settings/Telegram.test.jsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** Layout follows the `design-taste-frontend` app-screen checklist (`references/app-screens.md`) for the list, the form, its states and the phone. Look follows `design/` and the holding editor's existing trade section.
- [ ] **Step 4: Run** the same tests, then `npx eslint src e2e` and `npx vitest run`. Expected: all pass.
- [ ] **Step 5: Commit** (`Dividends: recording and fixing them in the holding editor`).

### Task 9: Docs, checks and the pull request

**Files:**
- Modify: `docs/decisions.md` (the "Dividends are their own records" section: receipts, the balance rule as it applies to dividends, the morning question, the guard), `docs/features.md` (the holding editor's dividends, the bot's question, the switch).

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run every check in `CLAUDE.md`:**
  - eslint, vitest, the build, Playwright;
  - the Deno check and tests;
  - the migrations, the SQL tests and `verify-concurrency.sh`;
  - `npm run compare:migrations`.

  Expected: all pass. Note any that cannot run here, and why.
- [ ] **Step 3: Commit, push, open the pull request.** The description says the migration is not applied, and that `dividends_enabled` defaults to on.
