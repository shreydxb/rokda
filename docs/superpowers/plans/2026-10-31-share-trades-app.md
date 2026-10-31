# Share trades in the app (SHR-371) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A holding's trades can be seen, recorded, fixed and deleted in the app, Investments shows what sales made this year and keeps sold-out holdings apart, and Broker funds have their own group in Accounts.

**Architecture:** No database change. The app reads `holding_trades` (members already can, through RLS) and calls the existing functions: `preview_trade`, `record_trade`, `fix_trade`, `preview_delete_trade`, `delete_trade`. Every figure a trade produces (units and average after, profit, the fund's movement, warnings) comes from the database's preview and is only formatted here. Pure formatting and sums live in a new `src/lib/trades.js`; two new components, `HoldingTrades.jsx` (the list) and `TradeForm.jsx` (record and fix), sit inside the existing holding editor.

**Tech Stack:** React 18 + Vite, supabase-js, Vitest + Testing Library, Playwright (desktop and phone projects).

**Spec:** `docs/superpowers/specs/2026-10-27-share-trades-design.md` (sections 3.2, 3.3, 4, 6, 9). The done-when list is SHR-371's.

## Global Constraints

- **Public repository:** fixtures use generic names and round numbers ("Partner", "ABC", "XYZ", "Dollar broker funds", 10 at 100). Nothing from the household's real holdings, here or in commits or the PR.
- **No database change.** If a task finds it needs one, stop: it needs a migration, its tests and a production apply on the user's word.
- **The app never works out a trade's figures.** Units and average after, profit, cash and warnings come from `preview_trade` / `preview_delete_trade`. A save always passes `p_expected_version`, the `trades_version` the preview was worked on.
- **A member's trade is the app's:** `record_trade` is called without `p_source` and without `p_proposal_id`; the database refuses anything else from a member (`not_allowed`).
- Money is shown with 2 decimals. Units are shown in full, up to 8 decimals, with no trailing zeros (`55.51771719`, `10`).
- A refusal says why in plain words and ends with "Nothing was saved."
- Plain JavaScript/JSX, single quotes, long lines, no Prettier. Comments explain why, in full sentences, as densely as the surrounding code.
- Pure logic in `src/lib/*.js` with a `*.test.js` beside it; screens get `*.test.jsx`.
- Layout: use `.claude/skills/design-taste-frontend/references/app-screens.md` as a checklist for placement, lists, forms, states and the phone. `design/` and the existing classes (`te-*`, `mn-row*`, `ov-*`, `wl-*`) decide the look; take no style or palette from the skill. On a phone (≤ 720px) rows are two lines and every control is at least 44px tall.
- Every product decision gets a short section in `docs/decisions.md` (Task 6 writes it).
- Checks before pushing are the ones in `CLAUDE.md` (eslint, vitest, build, Playwright).

## Review Focus

1. **The holding changes between Check and Save** (a trade from Telegram lands meanwhile): the save is refused as stale, the person is told plainly, the preview is cleared, and Check works again on the fresh version. Test: Task 4, `refuses a save the holding moved under, and asks to check again`.
2. **Unsaved holding edits and a trade at once:** recording, fixing or deleting a trade reloads the holding, which would drop typed edits or make the next holding save stale. Trade buttons are disabled while the holding form has unsaved changes, with the reason shown. Test: Task 3, `disables trade actions while the holding has unsaved changes`.
3. **A fund whose balance was never confirmed** (both go-live funds are at 0, unconfirmed): every buy would warn "would go below zero". The warning says instead that the fund has no confirmed balance yet. Test: Task 1, `warns about an unconfirmed fund without calling it overdrawn`.
4. **A rupee sale with no exchange rate on or before its date:** its profit in AED is unknown, not zero and not guessed at today's rate unless the household's rate is the stated fallback. Test: Task 1, `leaves the year's profit unknown when a rupee sale has no rate`.
5. **A holding sold out and then bought again** (the database reopens it): it leaves Sold and comes back to the holdings table on the next load. Test: Task 2, `moves a holding bought again from Sold back to the table`.

---

### Task 1: Trades data and the pure helpers

**Files:**
- Create: `src/lib/trades.js`, `src/lib/trades.test.js`
- Modify: `src/lib/holdings.js` (add `isClosedHolding`), `src/lib/holdings.test.js`
- Modify: `src/screens/useOverviewData.js` (new source), `src/lib/loadState.js` (its name), `src/screens/useOverviewData.test.jsx` if it pins the source list

**Interfaces:**
- Produces, in `src/lib/trades.js`:
  - `TRADE_KIND_LABELS = { opening: 'Opening', buy: 'Buy', sell: 'Sell', split: 'Split' }`
  - `tradesOfHolding(trades: Trade[], holdingId: string): Trade[]`: that holding's trades, newest first: the exact reverse of the replay's order (trade date; on one day the opening first; then `traded_at`, missing last; then `created_at`; then `id`).
  - `hasBuysOrSales(trades: Trade[], holdingId: string): boolean`
  - `formatUnits(n: number|string): string`
  - `tradeRow(trade: Trade, currency: string): { title: string, detail: string }`: the two lines a trade shows.
  - `salesProfit(trades, holdings, { from?: 'YYYY-MM-DD'|null, to?: 'YYYY-MM-DD'|null, scopeMemberId: string|null, fxHistory, inrPerAed }): { available: boolean, profitAed: number, taxAed: number, sales: number, taxToConfirm: number }`: sells with `from <= trade_date < to` (either bound optional) on the holdings given. Each sale's `realised` and `tax_withheld` are converted with `estimateAed` from `src/lib/fxHistory.js` at the sale's date (dollars at the peg, rupees at that day's rate, else the household's rate). Each is then scoped with `scopedValue` from `src/lib/scope.js`, like every other figure on Investments. `available` is false when any sale cannot be valued.
  - `refusalMessage(result: { error: string, entry_id?: string }, ctx: { holdingName: string, currency: string, trades: Trade[], formDate?: string }): string`: the date of the trade `entry_id` names comes from `ctx.trades` (or `formDate` when it is `'new'`), and the opening date from the holding's opening entry there.
  - `warningLines(effect, ctx: { holdingName: string, fundName: string, fundConfirmed: boolean, currency: string, lastPrice: number|null }): string[]`
  - `tradeArgs(form: { kind, trade_date, units, price, fees, tax_withheld, funds_account_id }, holding): { errors: Record<string,string>, args: object|null }`: what `preview_trade` / `record_trade` / `fix_trade` take, or field errors. An `opening` (only ever fixed) carries units and price, no fees, tax or fund.
- Produces, in `src/lib/holdings.js`: `isClosedHolding(h): boolean` (`trades_version > 0` and units exactly 0). It is app-only, so the bot's `applib/holdings.js` mirror is untouched (the parity test compares only what the mirror declares).
- Produces: `data.holdingTrades` from `useOverviewData` (query: `holding_trades`, `select('*')`, `eq('household_id', id)`, ordered by `trade_date`, `created_at`, `id`; failure name `'trades'`).

- [ ] **Step 1: Write the failing tests** in `src/lib/trades.test.js` and `src/lib/holdings.test.js`. Fixtures: holding `ABC` (USD, owner `ME`, trades_version 3), holding `XYZ` (INR), opening 10 at 100 on `2026-10-27`, buy 5 at 130 on `2026-10-28`, sell 6 at 150 fees 1 realised 239 on `2026-10-29`.

```js
it('lists a holding\'s trades newest first, the opening last on its day', ...)
  // same-day opening and buy: buy first; then by date descending
it('shows fractional units in full and whole units bare', () => {
  expect(formatUnits(55.51771719)).toBe('55.51771719');
  expect(formatUnits('10.00000000')).toBe('10');
  expect(formatUnits(1234.5)).toBe('1,234.5');
});
it('describes a sale with its brokerage, tax and profit', () => {
  expect(tradeRow({ kind: 'sell', units: 6, price: 150, fees: 1, tax_withheld: 2, realised: 239, trade_date: '2026-10-29' }, 'USD'))
    .toEqual({ title: 'Sell 6 at USD 150.00', detail: '29 Oct 2026 · brokerage 1.00 · tax 2.00 · profit 239.00' });
});
it('describes a loss, a split and an Indian sale awaiting its tax', () => {
  // realised -40 → '… · loss 40.00'; split units 10 → title 'Split 10 for 1', detail '29 Oct 2026';
  // sell with tax_to_confirm true → detail ends '· tax to confirm'
});
it('counts this year\'s sales in AED, a rupee sale at its own day\'s rate', () => {
  // USD realised 100 → 367.25; INR realised 2,300 on a day whose rate is 23 → 100; total 467.25, sales 2
});
it('leaves the year\'s profit unknown when a rupee sale has no rate', () => {
  // no history on or before the day, inrPerAed null → available false
});
it('halves a shared holding\'s sale in one member\'s view', ...)
it('counts an Indian sale whose tax is still to confirm', ...)   // taxToConfirm 1
it('says which date a sale would oversell on, from the trade the database names', () => {
  expect(refusalMessage({ error: 'exceeds_units', entry_id: SELL_ID }, { holdingName: 'ABC', currency: 'USD', trades }))
    .toBe('This would sell more ABC than was held on 29 Oct. Nothing was saved.');
  // entry_id 'new' → the form's date
});
it('words every refusal the database gives', () => {
  // before_opening → 'That date is before ABC\'s trade history starts on 27 Oct. Nothing was saved.'
  // whole_units_only → 'Indian shares trade in whole units. Nothing was saved.'
  // fund_required → 'There is no USD Broker funds account for this trade. Add one in Accounts. Nothing was saved.'
  // stale → 'ABC changed since you checked this trade. Check it again. Nothing was saved.'
  // currency_mismatch, not_broker_funds, fund_archived, trade_not_found, unknown code → one plain line each, ending 'Nothing was saved.'
});
it('warns about an unconfirmed fund without calling it overdrawn', () => {
  expect(warningLines({ warnings: ['fund_below_zero'], funds_balance_after: -500 }, { holdingName: 'ABC', fundName: 'Dollar broker funds', fundConfirmed: false, currency: 'USD', lastPrice: null }))
    .toEqual(['Dollar broker funds has no confirmed balance yet, so it would show USD -500.00 until you set it.']);
  // fundConfirmed true → 'Dollar broker funds would go to USD -500.00. If you added money, record that too.'
});
it('words the other warnings', ...)  // possible_duplicate, price_off_market (with lastPrice), fund_confirmed_after
it('turns the form into the database\'s arguments, or says what is missing', () => {
  // buy: units '5', price '130', fees '' → args { p_kind: 'buy', p_units: 5, p_price: 130, p_fees: 0, p_tax_withheld: 0, … }
  // split: price ignored → p_price null, p_fees 0
  // sell in INR with tax '' → args.p_tax_to_confirm true; with tax '20' → false
  // units '' → errors.units 'Enter the units.'; units '0' → 'Units must be above 0.'; buy without price → errors.price 'Enter the price.'
  // a date after today → errors.trade_date 'A trade can\'t be in the future.'
  // opening → p_price set, p_fees 0, p_tax_withheld 0, p_funds_account_id null
});
// holdings.test.js
it('calls a traded holding at zero units closed, and nothing else', ...)  // trades_version 0 with 0 units is not closed
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/trades.test.js src/lib/holdings.test.js`
Expected: FAIL, `trades.js` missing and `isClosedHolding` not exported.

- [ ] **Step 3: Implement** `src/lib/trades.js` and `isClosedHolding` with the signatures above. Dates are shown as `toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })` in refusals and with the year in `tradeRow`. `tradeArgs` checks today with `householdToday()` from `src/lib/day.js`. Add the `holdingTrades` source and its failure name `trades` to `src/lib/loadState.js`.

- [ ] **Step 4: Run them to see them pass, then the whole suite**

Run: `npx vitest run src/lib/trades.test.js src/lib/holdings.test.js && npx vitest run`
Expected: PASS; the full suite still green (a source-list test, if one pins the sources, is updated to include `holdingTrades`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/trades.js src/lib/trades.test.js src/lib/holdings.js src/lib/holdings.test.js src/screens/useOverviewData.js src/lib/loadState.js
git commit -m "Trades in the app: load trades, and the helpers that word and sum them"
```

---

### Task 2: Investments: sold-out holdings apart, and profit on sales this year

**Files:**
- Modify: `src/screens/wealth/Investments.jsx`, `src/screens/Wealth.css` (only if the fold needs a rule the existing classes lack)
- Test: `src/screens/wealth/Investments.test.jsx`

**Interfaces:**
- Consumes: `isClosedHolding`, `salesProfit`, `formatUnits` (Task 1); `data.holdingTrades`, `data.fxRateHistory`, `household.inr_per_aed`.
- Produces: nothing new for later tasks.

Decisions this task carries (Task 6 writes them up):
- The holdings table and every total above it show **open** holdings. Sold-out ones sit in a **Sold** fold below the table: a button "Sold (N)" with `aria-expanded`, closed by default. Each row shows the holding's name, the owner, "Sold out on 29 Oct 2026" (its last sale) and its profit on all its sales in AED (`salesProfit` with no bounds). Clicking a row opens the holding editor, which shows its trades.
- The stats row gains **"Profit on sales this year"** (`salesProfit` from 1 Jan of the household's year): the signed AED figure, then "after tax AED X" when any tax was withheld, then "N sale(s) awaiting the broker's tax" when any is to confirm. It shows "None this year" when there were no sales, and "Not known: a rupee sale has no exchange rate" when it is unavailable.
- "Profit and loss to date" is renamed **"Profit not yet taken"**, because sales now have their own figure and the old name read as the whole of it.
- The "No holdings" empty state shows when there are no **open** holdings. The Sold fold still shows beneath it.

- [ ] **Step 1: Write the failing tests** in `Investments.test.jsx`, extending its existing fixtures (`holdingTrades: []` and `fxRateHistory: []` added to its data):

```js
it('puts a sold-out holding under Sold, not in the holdings table', ...)
  // ABC trades_version 4, quantity 0 → not in the table rows; 'Sold (1)' button; expanded shows 'ABC' and 'Sold out on 29 Oct 2026'
it('moves a holding bought again from Sold back to the table', ...)
  // same ABC with quantity 4 → in the table, no Sold button
it('shows what sales made this year in AED beside the profit not yet taken', ...)
  // one USD sale realised 100 this year → 'Profit on sales this year' and 'AED 367.25'; 'Profit not yet taken' label present
it('leaves out a sale from last year', ...)
it('says when this year\'s profit on sales is not known', ...)
it('shows the Sold fold even when every holding is sold', ...)
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/screens/wealth/Investments.test.jsx`
Expected: FAIL on the new cases only.

- [ ] **Step 3: Implement** in `Investments.jsx`: `rows` excludes `isClosedHolding`, `sold` is `visibleHoldings(holdings, scopeMemberId, 'All').filter(isClosedHolding)`, the stat and the fold as decided above. Use the screen's `money.fmt` / `money.fmtSigned`, and the existing `wl-invstats`, `mn-list` and `mn-row` patterns. On a phone the fold's rows are two lines (`mn-row-main` above, figure beside) and 44px tall.

- [ ] **Step 4: Run to pass, then the suite**

Run: `npx vitest run src/screens/wealth/Investments.test.jsx && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/screens/wealth/Investments.jsx src/screens/wealth/Investments.test.jsx src/screens/Wealth.css
git commit -m "Investments: sold-out holdings in their own fold, and what sales made this year"
```

---

### Task 3: The trades list in the holding editor

**Files:**
- Create: `src/screens/wealth/HoldingTrades.jsx`
- Modify: `src/screens/wealth/HoldingEditor.jsx`, `src/screens/wealth/Investments.jsx`
- Test: `src/screens/wealth/HoldingEditor.test.jsx`

**Interfaces:**
- Consumes: `tradesOfHolding`, `tradeRow`, `hasBuysOrSales`, `TRADE_KIND_LABELS` (Task 1).
- Produces:
  - `HoldingTrades({ holding, trades, accounts, disabledReason: string|null, onChanged: () => Promise<void> })`. It renders the "Trades" section: a "Record a trade" button, then one row per trade (title and detail from `tradeRow`) with "Fix" and, except on the opening entry, "Delete". Task 4 wires Record, Task 5 wires Fix and Delete; in this task those buttons render but open nothing.
  - `HoldingEditor` takes two new props, `trades` (all of `data.holdingTrades`) and `accounts` (all of `data.accounts`), plus `onTradesChanged`.
  - Investments keeps the **id** being edited, not the row. It reads the holding from the freshly loaded `holdings`, and keys the editor `${id}:${trades_version}`, so a reload after a trade remounts the editor on the new figures while it stays open.

Decisions:
- The section shows when `holding.trades_version > 0` (traded or sold out). An untraded holding's editor is unchanged.
- While the holding form is dirty, `disabledReason` is "Save or discard your changes to the holding first." The trade buttons are disabled, and that line is shown above them.
- A holding with buys or sales has no "Delete" button. In its place: "A holding with buys or sales can't be deleted. Delete its trades first, or keep it: sold to zero, it moves to Sold." (The database refuses the delete anyway; this replaces its raw error.)

- [ ] **Step 1: Write the failing tests** in `HoldingEditor.test.jsx`:

```js
it('lists a traded holding\'s trades newest first, with brokerage, tax and profit', ...)
  // rows in order: 'Sell 6 at USD 150.00' / '29 Oct 2026 · brokerage 1.00 · profit 239.00', 'Buy 5 at USD 130.00', 'Opening 10 at USD 100.00'
it('shows no trades section for a holding without a trade history', ...)
it('offers no Delete on the opening entry', ...)
it('disables trade actions while the holding has unsaved changes', ...)
  // type in the name field → 'Record a trade' and each 'Fix' disabled; reason text shown
it('replaces Delete with the reason on a holding with buys or sales', ...)
```

And in `Investments.test.jsx`:

```js
it('keeps the editor open on the reloaded holding after its trades change', ...)
  // open ABC (version 3); reload returns ABC version 4 with new units → editor still open, units field shows the new units
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/screens/wealth/HoldingEditor.test.jsx src/screens/wealth/Investments.test.jsx`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement** `HoldingTrades.jsx` and the editor and Investments changes above. The rows use `mn-row` markup inside the drawer, two lines on every width, with buttons of class `om-btn` and a 44px minimum height on a phone.

- [ ] **Step 4: Run to pass, then the suite**

Run: `npx vitest run src/screens/wealth && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/screens/wealth/HoldingTrades.jsx src/screens/wealth/HoldingEditor.jsx src/screens/wealth/Investments.jsx src/screens/wealth/HoldingEditor.test.jsx src/screens/wealth/Investments.test.jsx
git commit -m "Holding editor: a traded holding lists its trades"
```

---

### Task 4: Record a trade: check, then save exactly what was checked

**Files:**
- Create: `src/screens/wealth/TradeForm.jsx`
- Modify: `src/screens/wealth/HoldingTrades.jsx`
- Test: `src/screens/wealth/TradeForm.test.jsx`

**Interfaces:**
- Consumes: `tradeArgs`, `refusalMessage`, `warningLines`, `formatUnits`, `tradesOfHolding` (Task 1); `HoldingTrades` (Task 3).
- Produces: `TradeForm({ holding, trade: Trade|null, trades, accounts, onCancel: () => void, onSaved: () => Promise<void> })`. `trade` null records a new trade; Task 5 passes one to fix it.

Behaviour:
- **Fields:** kind (Buy, Sell, Split as a segmented control); date (default today, `max` today); units, or "New units per old unit" for a split; price in the holding's currency (not for a split); brokerage (not for a split); tax withheld (sells only, labelled "Tax withheld (leave blank if not known yet)" for a rupee holding); fund.
- **The fund:** a select of Broker funds accounts in the holding's currency that are not closed, defaulting to `holding.funds_account_id`. If there are none, the form shows "There is no USD Broker funds account. Add one in Accounts." and Check stays disabled.
- **"Check"** calls `preview_trade` with `tradeArgs`. On `ok` it shows:
  - "ABC: 15 → 9 shares, average USD 110.00" (or "→ USD 112.00" when the average moves);
  - on a sale, "Profit USD 239.00" or "Loss USD 40.00";
  - "Dollar broker funds +USD 899.00" when the fund moves;
  - "Tax: to confirm from the broker's statement." on a rupee sale with no tax;
  - then each line of `warningLines`.
  On a refusal it shows `refusalMessage`. Changing any field clears the preview.
- **"Save trade"** is enabled only while a preview is shown. It calls `record_trade` with the same arguments plus `p_expected_version` = the preview's `trades_version` and `p_tax_to_confirm`, then `onSaved()`. A `stale` answer shows `refusalMessage`'s stale line, clears the preview and calls `onSaved()` to reload. The editor then remounts on the new version (Task 3), so the person checks again on fresh figures.

- [ ] **Step 1: Write the failing tests** in `TradeForm.test.jsx`, with `supabase.rpc` mocked per function name:

```js
it('checks a sale with the database and shows what it would do', ...)
  // rpc('preview_trade', { p_holding_id: ABC, p_kind: 'sell', p_trade_date: today, p_units: 6, p_price: 150, p_fees: 1, p_tax_withheld: 0, p_traded_at: null, p_funds_account_id: FUND, p_replace_trade_id: null })
  // shows 'ABC: 15 → 9 shares, average USD 110.00', 'Profit USD 239.00', 'Dollar broker funds +USD 899.00'
it('saves exactly the checked trade, on the version it was checked against', ...)
  // rpc('record_trade', { …same args minus p_replace_trade_id, p_expected_version: 3, p_tax_to_confirm: false }); no p_source, no p_proposal_id; onSaved called
it('clears the check when a figure changes, and will not save until checked again', ...)
it('says which date a sale would oversell on', ...)
  // preview → { ok: false, error: 'exceeds_units', entry_id: 'new' } with date 24 Oct → 'This would sell more ABC than was held on 24 Oct. Nothing was saved.'
it('refuses a save the holding moved under, and asks to check again', ...)
  // record_trade → { ok: false, error: 'stale', trades_version: 4 } → message, preview gone, onSaved called once
it('marks a rupee sale with no tax as to confirm', ...)
  // XYZ (INR) sell, tax blank → preview shows the tax line; record_trade gets p_tax_to_confirm: true
it('offers only open Broker funds in the holding\'s currency, the holding\'s own first', ...)
it('says when there is no fund to trade through', ...)
it('records a split with no price or brokerage', ...)
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/screens/wealth/TradeForm.test.jsx`
Expected: FAIL, the component missing.

- [ ] **Step 3: Implement** `TradeForm.jsx` with the behaviour above, and open it from "Record a trade" in `HoldingTrades.jsx`, in place of the list while it is open. Field markup reuses `te-fieldgrid`, `te-fieldcell`, `te-fieldlabel`, `te-fieldvalue`; the preview sits in one block above the actions; the actions are "Cancel", "Check" and "Save trade" (primary).

- [ ] **Step 4: Run to pass, then the suite**

Run: `npx vitest run src/screens/wealth && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/screens/wealth/TradeForm.jsx src/screens/wealth/TradeForm.test.jsx src/screens/wealth/HoldingTrades.jsx
git commit -m "Holding editor: record a trade, checked by the database before it is saved"
```

---

### Task 5: Fix and delete a trade

**Files:**
- Modify: `src/screens/wealth/TradeForm.jsx`, `src/screens/wealth/HoldingTrades.jsx`
- Test: `src/screens/wealth/TradeForm.test.jsx`, `src/screens/wealth/HoldingEditor.test.jsx`

**Interfaces:**
- Consumes: `TradeForm` (Task 4), `HoldingTrades` (Task 3), `refusalMessage` (Task 1).
- Produces: nothing new.

Behaviour:
- **"Fix"** opens `TradeForm` with the trade's figures and its kind fixed.
  - Check calls `preview_trade` with `p_replace_trade_id` = the trade's id.
  - Save calls `fix_trade(p_trade_id, p_trade_date, p_units, p_price, p_fees, p_tax_withheld, p_traded_at, p_funds_account_id, p_tax_to_confirm, p_note, p_expected_version)`. It keeps the trade's own `traded_at` and `note`, which the form does not show.
  - On an opening entry only units and price can be changed; the date is shown read-only.
- **"Delete"** (not on the opening entry) first calls `preview_delete_trade(p_trade_id)`, then asks in the row:
  - "Delete Sell 6 at USD 150.00 on 29 Oct? ABC: 9 → 15 shares · Dollar broker funds −USD 899.00";
  - the fund part is left out when `funds_delta` is 0;
  - the choices are "Delete trade" and "Keep it".
  Confirming calls `delete_trade(p_trade_id, p_expected_version)` with the holding's current `trades_version`, then `onChanged()`. A refusal (for example `exceeds_units`, when deleting a buy that a later sale needed) shows `refusalMessage`, naming the sale's date.

- [ ] **Step 1: Write the failing tests**

```js
// TradeForm.test.jsx
it('fixes a trade through the database, keeping its time and note', ...)
  // preview_trade with p_replace_trade_id: BUY_ID; fix_trade with p_traded_at and p_note from the trade, p_expected_version 3
it('lets an opening entry change its units and price, not its date', ...)
it('names the sale a fix would oversell', ...)
  // moving the buy after the sale → preview { ok: false, error: 'exceeds_units', entry_id: SELL_ID } → 'This would sell more ABC than was held on 29 Oct. Nothing was saved.'
// HoldingEditor.test.jsx
it('asks before deleting a trade, with what it would undo', ...)
  // preview_delete_trade → { ok: true, holding_units_after: 15, units_before: 9, funds_delta: -899 } → the question above; 'Keep it' closes it without a call
it('deletes a trade on the version shown and reloads', ...)
  // delete_trade({ p_trade_id: SELL_ID, p_expected_version: 3 }); onTradesChanged called
it('says why a trade cannot be deleted', ...)
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/screens/wealth/TradeForm.test.jsx src/screens/wealth/HoldingEditor.test.jsx`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement** the fix path in `TradeForm.jsx` (driven by its `trade` prop) and the delete question in `HoldingTrades.jsx`.

- [ ] **Step 4: Run to pass, then the suite**

Run: `npx vitest run src/screens/wealth && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/screens/wealth/TradeForm.jsx src/screens/wealth/HoldingTrades.jsx src/screens/wealth/TradeForm.test.jsx src/screens/wealth/HoldingEditor.test.jsx
git commit -m "Holding editor: fix or delete a trade, refused in plain words when the history would not add up"
```

---

### Task 6: Broker funds in Accounts, the browser tests, docs and the pull request

**Files:**
- Test: `src/screens/wealth/Accounts.test.jsx`
- Modify: `e2e/fixtures.js` (an `rpc` option on `stubSupabase`, `holding_trades` in `data`)
- Create: `e2e/trades.spec.js`
- Modify: `docs/decisions.md`, `docs/features.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `stubSupabase(page, { rpc: { [name]: json } })`. An rpc listed there is answered with its JSON, and any other rpc keeps answering `null`.

- [ ] **Step 1: Pin the Broker funds group.** In `Accounts.test.jsx`, add `it('shows Broker funds in their own group', ...)`: a `broker_funds` account appears under the heading "Broker funds", apart from Checking and Savings. Grouping by type already uses `ACCOUNT_TYPE_LABELS`, which has the label, so this is expected to pass at once. Note that in the ledger. If it fails, fix `groupAccounts` so it does.

Run: `npx vitest run src/screens/wealth/Accounts.test.jsx`
Expected: PASS.

- [ ] **Step 2: Write the browser test** `e2e/trades.spec.js`. It runs in both the desktop and the mobile projects. Fixtures:
  - a USD holding ABC (trades_version 3, 9 units at 110, priced);
  - its opening, buy and sell trades;
  - a USD `broker_funds` account "Dollar broker funds", confirmed;
  - `rpc: { preview_trade: <ok effect: 9 → 6, realised 119, funds_delta 539, trades_version 3, warnings []> , record_trade: <same + trade_id> }`.

```js
test('a traded holding shows its trades, and a sale is checked before it is saved', async ({ page }) => {
  // Wealth → Investments → ABC: 'Trades' shows three rows, newest first
  // Record a trade → Sell, units 3, price 150, brokerage 1 → Check → '9 → 6 shares' and 'Profit USD 119.00' visible
  // Save trade → the record_trade request body has p_expected_version 3 and no p_source
  // no horizontal overflow (the suite's existing overflow check); on mobile every trade button's box is ≥ 44px tall
});
```

Run: `npx vitest run && VITE_SUPABASE_URL=https://e2e.supabase.test VITE_SUPABASE_PUBLISHABLE_KEY=e2e-key npm run build && CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npx playwright test e2e/trades.spec.js`
Expected: FAIL first only if the `rpc` option is missing. Add it to `stubSupabase`, then PASS on both projects.

- [ ] **Step 3: Docs.**
  - `docs/decisions.md` gets a section, "Trades in the app", one bullet per decision:
    - Check, then save exactly what was checked, on the same version;
    - trade buttons wait for unsaved holding edits;
    - an opening entry can be fixed but not deleted in the app;
    - no Delete on a holding with buys or sales;
    - the Sold fold, and "Profit not yet taken";
    - profit on sales is scoped like the screen's other figures, a rupee sale at its day's rate, and unknown when there is no rate;
    - the unconfirmed-fund warning.
  - `docs/features.md`: Wealth → Investments and the holding editor describe trades, Sold, and profit on sales.

- [ ] **Step 4: Every check in `CLAUDE.md`**

Run: `npx eslint src e2e && npx vitest run && VITE_SUPABASE_URL=https://e2e.supabase.test VITE_SUPABASE_PUBLISHABLE_KEY=e2e-key npm run build && CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npx playwright test`
Expected: all green. Each command is run on its own, never piped through `tail`.

- [ ] **Step 5: Commit, push, PR**

```bash
git add src/screens/wealth/Accounts.test.jsx e2e/fixtures.js e2e/trades.spec.js docs/decisions.md docs/features.md
git commit -m "Trades in the app: browser tests on desktop and phone, and the decisions behind them"
git push -u origin claude/vibrant-turing-45j3sn
```

Open the PR: "Share trades, part 4: trades in the app (SHR-371)". The body lists the done-when items, each with its test; it says no database change; it ends with the attribution lines. Comment on SHR-371 with the PR link.

## Out of scope

- Changing a fund's "brokerage in the average" from the app. Switching it after trades exist would re-average past buys on the next replay. It stays a one-off database setting, made once the broker samples settle it.
- A trade's time of day and its note in the form. Both are kept as they are on a fix.
- Undoing a holding's fresh start (deleting a lone opening entry) from the app.
