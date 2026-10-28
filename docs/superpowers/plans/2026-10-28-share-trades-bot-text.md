# Share trades: the bot records trades from text — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A member types "bought 10 ABC at 120.5", "sold 2 ABC at 150 on 24 Oct, brokerage 1", "Partner bought 3 XYZ at 600", "ABC split 10 for 1", "undo last trade" or "what did I make on ABC this year?". The bot asks only for what is missing, then shows one confirmation worked out by the database. Nothing is saved until the sender says yes.

**Architecture:**
- **Proposal flow.** Trades go through the existing proposal flow (`bot_proposals` + `apply_bot_proposal`), with two new kinds, `trade` and `trade_undo`, and one new status, `asking`. A trade that still needs an answer is an `asking` row that no "yes" can apply.
- **The database.** Every figure shown comes from the database: `preview_trade`, and two new previews that run the real save inside a block that is rolled back. Applying calls `record_trade` / `delete_trade`, which check the version.
- **The bot's code.** Pure helpers (matching, questions, messages) live in a new `telegram-webhook/trades.ts` with their own tests. `index.ts` only wires them into routing, answers and outcomes.

**Tech Stack:** Deno edge function (TypeScript), OpenRouter tool calls (`google/gemini-2.5-flash-lite`, the existing router), Postgres (plpgsql).

**Spec:** `docs/superpowers/specs/2026-10-27-share-trades-design.md`, sections 5.1, 5.4–5.6, 5.8 and 9. Linear SHR-370, done-when items 1, 3, 4, 5, 6, 8 and 10.

**Not in this plan:**
- Reading broker screenshots, the Indian-sale statement follow-up and brokerage-in-average per broker (SHR-370 items 2 and 7): they wait for the household's samples.
- Transfers between a bank account and a fund in two currencies (item 9): they change the transfer rules shared by the app and the bot, so they get their own plan.
- Choosing another fund than the holding's in reply to a confirmation (spec 5.5): the confirmation shows the fund, and the app's trade editor (step 4) changes it. A member who wants another fund says "no" and sends the trade again once the holding's fund is right.

## Global Constraints

- Public repository: generic fixtures only ("ABC", "Partner", round numbers).
- Plan A (`2026-10-28-share-trades-safe-saves.md`) is merged first. The bot must not record a trade while an editor can undo one.
- One migration, `supabase/migrations/20261029120000_bot_trades.sql`, renamed to production's version when applied. It replaces check constraints, so it is applied through the SQL Editor as in Plan A.
- Every figure in a confirmation comes from a database preview: never computed in TypeScript.
- Nothing is converted between currencies silently. A price in another currency is asked about.
- Questions one at a time, only for: which holding, units, price, the currency of a new holding.
- Copy is plain sentences, as the bot writes today. Money: `$1,234.50` for USD, `₹1,234.50` for INR, `AED 1,234.50`. Units as entered, with no trailing zeros.
- New test file `supabase/functions/telegram-webhook/trades.test.ts` is added to CI's "Handler tests" step and to CLAUDE.md's deno test command.

## Review Focus

1. **A trade message routed as an expense** ("bought 10 ABC at 120"): it must reach `log_trade`, never the Inbox. Test: the router receives a system prompt naming the trade exception, and a `log_trade` route never captures an intake row (Task 3).
2. **An answer that arrives twice**, when Telegram redelivers it after a failure mid-question: it fills its field once and never fills the next field with the same number (Task 4).
3. **A trade dated in the future** ("bought on 30 Nov"): refused before any preview, with "That date hasn't happened yet." (Task 3).
4. **Two members holding the same stock:** the sender's is matched unless the message names the other member. The confirmation names the owner when it is not the sender (Task 2, Task 5).
5. **A "yes" after the holding changed:** applying refuses as stale, and the bot sends a fresh confirmation rather than saving the old figures (Task 5).

---

### Task 1: Database — proposals for trades, new holdings, and previews that roll back

**Files:**
- Create: `supabase/migrations/20261029120000_bot_trades.sql`
- Test: `supabase/test/migration-behaviour.test.sql` (cases B3-01 to B3-12), `supabase/test/rls-policies.test.sql`

**Interfaces:**
- Consumes: `record_trade`, `delete_trade`, `private.trade_effect`, `private.trade_caller` (step 1 and Plan A).
- Produces:
  - **`bot_proposals`:** `kind` also accepts `'trade'` and `'trade_undo'`; `status` also accepts `'asking'`.
  - **Units check:** `holding_trades.units` check becomes `units > 0 or (kind = 'opening' and units = 0)`. A holding bought new starts from an empty opening entry.
  - **`private.create_trade_holding(p_new jsonb, p_trade_date date) returns public.holdings`:**
    - `p_new` keys: `owner_member_id`, `name`, `asset_class`, `currency`, `price_symbol`, `price_provider`, `sector`, `funds_account_id`.
    - It inserts the holding with `quantity 0`, `avg_price null`, `value_aed 0` and `is_shared false`, under the household of `owner_member_id`.
    - It adds a 0-unit, price-0 opening entry on `p_trade_date` and sets `trades_version = 1` inside the replay flag.
    - It raises if the owner is not a member or the name is blank.
  - **`public.preview_new_holding_trade(p_new_holding jsonb, p_trade_date date, p_units numeric, p_price numeric, p_fees numeric default 0, p_traded_at timestamptz default null, p_funds_account_id uuid default null, p_member_id uuid default null) returns jsonb`:**
    - It returns `private.trade_effect` for a buy on the holding `create_trade_holding` would make, plus `"new_holding": true`.
    - It runs inside `begin … raise … exception … end`, so nothing it wrote survives. Local variables keep the effect.
  - **`public.record_new_holding_trade(p_new_holding jsonb, p_trade_date date, p_units numeric, p_price numeric, p_fees numeric default 0, p_traded_at timestamptz default null, p_funds_account_id uuid default null, p_source text default 'app', p_proposal_id uuid default null, p_member_id uuid default null, p_note text default null) returns jsonb`:**
    - It creates the holding and records the buy with `p_expected_version 1`, returning `record_trade`'s result plus `holding_id`.
    - If the buy is refused, the holding is rolled back, so no empty holding is left.
  - **`public.preview_delete_trade(p_trade_id uuid, p_member_id uuid default null) returns jsonb`:** what `delete_trade` returns, plus `units_before` / `avg_before`, inside a rolled-back block.
  - **`apply_bot_proposal`:** redefined from `20261016160000_bot_transfers.sql` with two more branches.
    - **`'trade'`:** payload keys `holding_id` or `new_holding`, `kind`, `trade_date`, `traded_at`, `units`, `price`, `fees`, `tax_withheld`, `tax_to_confirm`, `funds_account_id`, `expected_version`.
      - It calls `record_trade` or `record_new_holding_trade` with `p_source 'bot'`, `p_proposal_id` = the proposal and `p_member_id` = the proposal's member.
    - **`'trade_undo'`:** payload `trade_id`, `expected_version`. It calls `delete_trade`.
    - **Outcomes, for both:**
      - Ok: `{outcome: 'applied', kind, effect}` and status `applied`.
      - Error `stale`: `{outcome: 'stale'}` and status `expired`.
      - Any other error: `{outcome: 'refused', error}` and status `expired`.
    - Grants are unchanged.
  - **Grants for the three new public functions:** `authenticated, service_role`. Plan A's `not_allowed` source rule applies to `record_new_holding_trade` too.

- [ ] **Step 1: Write the failing behaviour cases:**
  - **B3-01:** a 0-unit opening is accepted; a 0-unit buy is refused.
  - **B3-02:** `preview_new_holding_trade` for 10 at 50 with fees 1 returns `holding_units_after 10`, `holding_avg_after 50`, `funds_delta -501.00`. Afterwards no holding with that name exists.
  - **B3-03:** `record_new_holding_trade` with the same input:
    - creates one holding at 10 / 50, version 2;
    - creates two entries, opening (0 units) and buy;
    - moves the fund by −501.
  - **B3-04:** `record_new_holding_trade` through a rupee fund for a dollar holding returns `currency_mismatch`, and leaves no holding behind.
  - **B3-05:** `preview_delete_trade` on a sale returns `units_before` and the units after the undo. The sale and the fund's balance are unchanged afterwards.
  - **B3-06:** a `trade` proposal applied twice records one trade and returns the first result again.
  - **B3-07:** a `trade` proposal whose `expected_version` is old returns `outcome 'stale'`, records nothing and leaves the proposal `expired`.
  - **B3-08:** a `trade` proposal for a sale of more than is held returns `outcome 'refused'`, `error 'exceeds_units'`.
  - **B3-09:** a `trade_undo` proposal deletes the trade and reverses its money once.
  - **B3-10:** an `asking` proposal cannot be applied: `outcome 'asking'`, nothing changes.
  - **B3-11:** a `trade` proposal confirmed by a member other than its sender returns `not_yours`.
  - **B3-12:** the new kinds and status pass their checks, and an unknown kind is refused.
- [ ] **Step 2: Write the failing RLS cases:**
  - signed out, the three new functions cannot be called;
  - a member of another household gets `not_member`;
  - a signed-in member passing `p_source => 'bot'` to `record_new_holding_trade` gets `not_allowed`.
- [ ] **Step 3: Run them to see them fail.**
  - Run: verify-migrations, the behaviour and RLS files.
  - Expected: each B3 case raises its FAILED message, or the function does not exist.
- [ ] **Step 4: Write the migration.** Comment each part with why.
- [ ] **Step 5: Run every SQL check.**
  - Run: verify-migrations, both files, verify-concurrency.
  - Expected: all ok.
- [ ] **Step 6: Commit.** "Bot trades: proposals for trades and undos, new holdings, and previews that save nothing".

### Task 2: The pure trade helpers

**Files:**
- Create: `supabase/functions/telegram-webhook/trades.ts`, `supabase/functions/telegram-webhook/trades.test.ts`
- Modify: `.github/workflows/ci.yml` (Handler tests step), `CLAUDE.md` (deno test command)

**Interfaces:**
- Consumes: nothing from earlier tasks (pure).
- Produces, all exported from `trades.ts`:
  - **Types:**
    - `HoldingLite = { id: string; name: string; currency: string; asset_class: string; price_symbol: string | null; price_provider: string | null; owner_member_id: string | null; funds_account_id: string | null; trades_version: number; quantity: number | null; current_price: number | null }`
    - `TradeDraft = { side: "buy" | "sell" | "split"; stock: string; units: number | null; price: number | null; priceCurrency: string | null; ratio: number | null; tradeDate: string; tradedAt: string | null; fees: number; tax: number | null; ownerMemberId: string; holdingId: string | null; candidates: string[]; newHolding: NewHolding | null; awaiting: Field | null; lastUpdateId: number | null }`
    - `Field = "holding" | "units" | "price" | "currency"`
    - `NewHolding = { owner_member_id; name; asset_class; currency; price_symbol; price_provider; sector: null; funds_account_id: string | null }`
  - **Functions:**
    - `normaliseSymbol(s: string): string`
    - `matchHoldings(holdings: HoldingLite[], ownerMemberId: string, stock: string): HoldingLite[]`
    - `draftFromArgs(args: Record<string, unknown>, ctx: { senderId: string; members: Array<{ id: string; display_name: string }>; today: string }): TradeDraft | { error: "future_date" | "no_stock" | "unknown_member" }`
    - `nextQuestion(draft: TradeDraft, holdings: HoldingLite[]): { field: Field; text: string } | null`
    - `applyAnswer(draft: TradeDraft, text: string, holdings: HoldingLite[]): TradeDraft | null` (`null` means not understood)
    - `newHoldingFor(stock: string, currency: string, ownerMemberId: string, funds: Array<{ id: string; currency: string; owner_member_id: string | null; archived_at: string | null }>): NewHolding`
    - `tradeConfirmation(draft: TradeDraft, effect: Record<string, unknown>, ctx: { holdingName: string; ownerName: string | null; fundName: string; currency: string; newHolding: NewHolding | null }): string`
    - `undoConfirmation(trade: { kind: string; units: number; price: number | null; trade_date: string; currency: string; holding_name: string }, effect: Record<string, unknown>, fundName: string | null): string`
    - `tradeRefusal(error: string, ctx: { holdingName: string; units?: number }): string`
    - `formatMoney(amount: number, currency: string): string`

- [ ] **Step 1: Write the failing tests** in `trades.test.ts`:
  - **Symbols:** `normaliseSymbol("abc.ns") === "ABC"`, `normaliseSymbol("NSE:ABC") === "ABC"`, `normaliseSymbol("A.B.C") === "ABC"`.
  - **Matching:**
    - `matchHoldings` finds the owner's ABC by symbol, by name (case-insensitive) and when closed (`quantity 0`).
    - It returns both lots when the owner has two ABC holdings.
    - It never returns another member's ABC.
  - **Reading the message:**
    - `draftFromArgs({side:"sell", stock:"ABC", units:2, price:150, trade_date:"2026-10-24", brokerage:1}, …)` gives `fees 1`, `tradeDate "2026-10-24"`, `ownerMemberId` = sender.
    - With `member:"Partner"` the owner is the partner.
    - A date after today returns `{error:"future_date"}`.
    - `"ABC split 10 for 1"` args (`side:"split", ratio:10`) give `ratio 10`, `units null`, `price null`.
  - **Questions:**
    - `nextQuestion` with two candidates asks `"holding"` first, listing them "1." and "2.". With units missing it asks `"How many ABC did you buy?"`.
    - With price missing: `"At what price per share, in dollars?"`.
    - With `priceCurrency "AED"` on a dollar holding: `"ABC trades in dollars. What was the price per share in dollars?"`.
  - **Answers:**
    - `applyAnswer` for `"units"` reads `"10"`, `"2.5"`, `"1,000"`; returns `null` for `"lunch"`.
    - For `"holding"` it reads `"2"` as the second candidate.
    - For `"price"` it reads `"$150"` and `"150.5"`.
  - **New holdings:**
    - `newHoldingFor("XYZ","INR",…)` gives `asset_class "india_equity"`, `price_symbol "XYZ.NS"`, `price_provider "yahoo"`, and the owner's one INR broker fund.
    - For USD it gives `us_equity`, `"XYZ"`, `"twelvedata"`.
  - **The confirmation**, for the spec's worked sale (15 → 9 at average 110, profit 239, fund +899, fees 1), equals exactly:
    ```
    Sell 6 ABC at $150 on 27 Oct, brokerage $1
    ABC: 15 → 9 shares, average stays $110
    Profit $239 · Dollar broker funds +$899
    ```
    followed by the existing answer hint.
  - **Warnings:** each adds its line.
    - `possible_duplicate`: "This looks like a trade already saved: same stock, units and price within two days. Save it again?"
    - `fund_below_zero`: "Dollar broker funds would go to −$120. If you added money, record that too; reply yes to save the trade anyway."
    - `price_off_market`: "Check the price: ABC was last $150."
    - `fund_confirmed_after`: "Dollar broker funds is not moved: its balance was confirmed after this trade."
  - **Other lines:**
    - A sale by Partner on their holding begins "Partner's ABC:".
    - An Indian sale with no tax adds "Tax: to confirm from the broker's statement."
  - **Refusals:** `tradeRefusal` has one line per error code returned by `trade_effect` / `record_trade` (`exceeds_units`, `no_opening`, `whole_units_only`, `fund_required`, `not_broker_funds`, `currency_mismatch`, `fund_archived`, `before_opening`, `bad_input`). Each says nothing was saved.
- [ ] **Step 2: Run them to see them fail.**
  - Run: `deno test --node-modules-dir=none --allow-env --allow-read telegram-webhook/trades.test.ts` (from `supabase/functions`)
  - Expected: FAIL, module not found.
- [ ] **Step 3: Implement `trades.ts`.** Pure functions only; no Supabase, no fetch.
- [ ] **Step 4: Run them to see them pass**, then add the file to CI and CLAUDE.md.
  - Run: the same command, then the full handler-test command.
  - Expected: all pass.
- [ ] **Step 5: Commit.** "Bot trades: matching, questions and confirmations as pure helpers".

### Task 3: The router learns trades

**Files:**
- Modify: `supabase/functions/telegram-webhook/index.ts`:
  - `QUESTION_TOOLS` (~556)
  - `TOOLS_BASE` (~1439)
  - the `classifyAndRoute` system prompt (~2205)
  - the tool dispatch (~3976)
- Test: `supabase/functions/telegram-webhook/index.test.ts`

**Interfaces:**
- Consumes: Task 2's `draftFromArgs`, `matchHoldings`, `nextQuestion`.
- Produces:
  - **Tools:**
    - `log_trade` (args `side`, `stock`, `units`, `price`, `currency`, `trade_date`, `traded_at`, `brokerage`, `tax`, `member`, `ratio`);
    - `undo_last_trade` (no args);
    - `get_trade_profit` (args `stock`, `year`, `scope`).
  - **`handleTradeMessage(chatId: number, member: { id; household_id }, args: Record<string, unknown>, updateId: unknown): Promise<void>`**, used by Task 4. It builds the draft and replies with the first question, or hands over to Task 5's `proposeTrade`.

- [ ] **Step 1: Write the failing handler tests**, with the fake router set to `log_trade`:
  - "bought 10 ABC at 120" with ABC held by the sender reaches `preview_trade` and captures no intake row.
  - A future date replies "That date hasn't happened yet." and saves nothing.
  - "sold 2 XYZ at 50" with no XYZ held replies "You don't hold XYZ, so nothing was saved."
  - The router's system prompt contains "call log_trade".
- [ ] **Step 2: Run them to see them fail.**
  - Run: the handler tests.
  - Expected: the new cases FAIL.
- [ ] **Step 3: Implement.**
  - The three tool definitions.
  - One EXCEPTION sentence in the system prompt: buying, selling or a split of a share, fund or ETF is `log_trade`, never `log_expense`. "undo last trade" is `undo_last_trade`.
  - Dispatch to `handleTradeMessage`.
- [ ] **Step 4: Run the handler tests.**
  - Expected: all pass.
- [ ] **Step 5: Commit.** "Bot trades: the router sends trades, undos and profit questions to their own tools".

### Task 4: Questions, one at a time

**Files:**
- Modify: `supabase/functions/telegram-webhook/index.ts`:
  - a new `asking` path beside `sendProposal` (~1148);
  - the text flow before routing (~3760);
  - `openProposals` must keep ignoring `asking` rows.
- Test: `supabase/functions/telegram-webhook/index.test.ts`

**Interfaces:**
- Consumes: Task 2's `nextQuestion`, `applyAnswer`; Task 3's `handleTradeMessage`.
- Produces:
  - **`askTradeQuestion(chatId, member, draft: TradeDraft, question: { field: Field; text: string }, updateId): Promise<void>`:** inserts or updates the member's `asking` row with `kind 'trade'`, payload `{ draft }` and the question's message id.
  - **`answerTradeQuestion(chatId, member, text: string, repliedTo: number | null, updateId: number): Promise<boolean>`:** `true` when the text was the answer.

- [ ] **Step 1: Write the failing handler tests:**
  - **Units:** "bought ABC at 120" asks "How many ABC did you buy?". The reply "10" sends the confirmation, and exactly one `trade` proposal exists, status `proposed`.
  - **Price:** "bought 10 ABC" asks for the price; "120" completes it.
  - **Which holding:** two ABC lots asks which. "2" picks the second.
  - **Price in another currency:** a price in AED for a dollar holding asks for dollars; "130" completes it with price 130.
  - **Not an answer:**
    - Not a reply, after the question: "spent 40 on lunch" is captured as an expense and the draft stays `asking`.
    - A reply to the question: "lunch" gets "I need a number, like 10 or 2.5."
  - **Redelivered answer (Review Focus 2):** the same answer update delivered twice fills units once. The second delivery re-sends the current question and never fills price with 10.
  - **Unasked:** a bare "yes" while a draft is asking answers as today (nothing open), and applies nothing.
- [ ] **Step 2: Run them to see them fail.**
  - Run: the handler tests.
  - Expected: the new cases FAIL.
- [ ] **Step 3: Implement.**
  - An answer counts when it replies to the question's message, or when it is the member's next message within `PENDING_WINDOW_MS` and `applyAnswer` reads it.
  - The draft stores `lastUpdateId`. An update equal to it re-sends the question.
- [ ] **Step 4: Run the handler tests.**
  - Expected: all pass.
- [ ] **Step 5: Commit.** "Bot trades: ask for what is missing, one question at a time".

### Task 5: The confirmation, saving, and stale or expired answers

**Files:**
- Modify: `supabase/functions/telegram-webhook/index.ts`:
  - `sendProposal`'s kind union;
  - `proposalOutcomeMessage`, `proposalSummary`, `decideProposal` (~1234–1356);
  - the fake backend's `rpc` and `applyProposal` in `index.test.ts`.
- Test: `supabase/functions/telegram-webhook/index.test.ts`

**Interfaces:**
- Consumes:
  - Task 1's `preview_trade`, `preview_new_holding_trade`, and `apply_bot_proposal` outcomes `applied | stale | refused | expired`;
  - Task 2's `tradeConfirmation`, `tradeRefusal`, `newHoldingFor`.
- Produces: **`proposeTrade(chatId, member, draft: TradeDraft, updateId): Promise<void>`:**
  - It previews, then sends a `kind 'trade'` proposal: the payload as Task 1 lists, plus the draft, so it can be re-previewed.
  - It replies with `tradeRefusal` when the preview is refused.

- [ ] **Step 1: Write the failing handler tests:**
  - **The three trades** (SHR-370 item 1). With the fake previews answering the spec's figures, each confirmation text equals Task 2's format:
    - "bought 10 ABC at 182.5";
    - "sold 2 ABC at 430 on 24 Oct, brokerage 1";
    - "Partner bought 3 XYZ at 690".
  - **Yes:** "yes" calls `apply_bot_proposal` once and replies "Saved: Sell 6 ABC at $150 on 27 Oct. ABC now 9 shares; Dollar broker funds +$899." A second "yes" replies "Already saved: …".
  - **No:** "no" replies "Dropped the sale of 6 ABC at $150. Nothing was saved."
  - **Stale:** `outcome 'stale'` replies "ABC changed since I asked, so nothing was saved. Here it is again with today's figures:", then sends a new proposal (Review Focus 5).
  - **Expired:** `outcome 'expired'` on a trade sends a fresh proposal the same way.
  - **Refused:** `outcome 'refused'` with `exceeds_units` replies `tradeRefusal`'s line.
  - **New holding:** a buy of an unheld XYZ previews through `preview_new_holding_trade`. Its confirmation shows "New holding: XYZ (US equity, priced by Twelve Data as XYZ), paid from Dollar broker funds".
  - **No fund:** with no matching broker fund it replies `tradeRefusal("fund_required")`.
- [ ] **Step 2: Run them to see them fail.**
  - Run: the handler tests.
  - Expected: the new cases FAIL.
- [ ] **Step 3: Implement.** Keep the `kind === "trade"` branches inside the existing functions.
- [ ] **Step 4: Run the handler tests.**
  - Expected: all pass.
- [ ] **Step 5: Commit.** "Bot trades: confirm with the database's figures, save on yes, and ask again when the holding changed".

### Task 6: Undo, splits, and the split question

**Files:**
- Modify: `supabase/functions/telegram-webhook/index.ts`:
  - `undo_last_trade` dispatch;
  - `split` drafts;
  - a new `runSplitCheck()` added to the daily `run_recurring_check` list (~3544).
- Modify: `supabase/migrations/20261029120000_bot_trades.sql` (Task 1's file): add `holdings.split_asked_for date`, with its comment.
- Test: `supabase/functions/telegram-webhook/index.test.ts`, `supabase/test/migration-behaviour.test.sql` (B3-13)

**Interfaces:**
- Consumes: Task 1's `preview_delete_trade` and the `trade_undo` kind; Task 2's `undoConfirmation`; Task 5's `proposeTrade`.
- Produces: **`runSplitCheck(): Promise<{ checked: number; asked: number }>`**.

- [ ] **Step 1: Write the failing tests:**
  - **Undo:** "undo last trade" previews the sender's most recent trade (by `created_at`, `created_by` = sender, not an opening). It sends a `trade_undo` proposal whose text is `undoConfirmation`'s. "yes" saves it.
  - **Nothing to undo:** replies "You have no trades to undo."
  - **Split:** "ABC split 10 for 1" sends a split confirmation: "Split ABC 10 for 1 on 28 Oct / ABC: 9 → 90 shares, average $110 → $11". No money line.
  - **Split question:** the daily run, given a traded holding with units and `day_change_pct -50` whose `split_asked_for` is not today's price day, sends its owner once:
    "ABC moved −50% on its last price. If it split, tell me, e.g. "ABC split 2 for 1". If not, ignore this."
    A second run the same day sends nothing.
  - **B3-13:** `split_asked_for` can be set without touching the trade guards.
- [ ] **Step 2: Run them to see them fail.**
  - Expected: the new cases FAIL.
- [ ] **Step 3: Implement.** The split check asks when `abs(day_change_pct) > 40`, `trades_version > 0` and `quantity > 0`. It records `split_asked_for = priced_at`'s day after a delivered message.
- [ ] **Step 4: Run the handler tests and the SQL files.**
  - Expected: all pass.
- [ ] **Step 5: Commit.** "Bot trades: undo the last trade, record splits, and ask after a large one-day move".

### Task 7: "What did I make on ABC this year?"

**Files:**
- Modify: `supabase/functions/telegram-webhook/index.ts` (a new `toolGetTradeProfit` beside `toolGetHoldings`, ~1876; the `get_trade_profit` case in the question switch)
- Test: `supabase/functions/telegram-webhook/index.test.ts`

**Interfaces:**
- Consumes: `holding_trades` (read with `allRowsOf`), `_shared/applib/fxHistory.js` `estimateAed`, `fx_rate_history`.
- Produces: **`toolGetTradeProfit(householdId: string, scopeMemberId: string | null, args): Promise<{ year: number; holdings: Array<{ name; currency; profit; tax_withheld; sales; profit_aed }>; total_aed: number } | { error: string; available?: string[] }>`**

- [ ] **Step 1: Write the failing handler tests:**
  - With two sales of ABC this year and one last year, the phrase prompt's data has `sales 2`, the year's `profit` sum, and `profit_aed` at the peg for dollars.
  - A rupee sale uses the rate on its trade date.
  - "ABC" not held returns `error` with the available names.
  - A failed read answers `figuresUnavailableMessage()`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.** Read through `allRowsOf`, so a failed or truncated read is never summed.
- [ ] **Step 4: Run the handler tests.**
  - Expected: all pass.
- [ ] **Step 5: Commit.** "Bot trades: answer what a stock made this year from the recorded sales".

### Task 8: Docs, every check, the pull request

**Files:**
- Modify: `docs/decisions.md` (new section "The bot records trades"), `docs/features.md` (the bot's list)

- [ ] **Step 1: Write the decision.**
  - A trade is confirmed with the database's own figures, and saved only on the sender's yes.
  - Questions come one at a time; a price is never converted.
  - A new stock starts as a new holding from an empty opening entry.
  - Undo applies to the sender's last trade.
  - A large one-day move asks about a split.
- [ ] **Step 2: Run every check in CLAUDE.md.**
  - Expected: all green.
- [ ] **Step 3: Open the PR** "Share trades, part 3: the bot records trades from text". List what waits for the samples, and the transfers plan.
