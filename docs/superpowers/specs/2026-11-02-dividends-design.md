# Dividends: what the shares pay, after withholding, as passive income

Design for SHR-366. Status: approved by the household on 2 November 2026, after two outside reviews. This repository is public: every figure, ticker and account below is a round example ("ABC", "the dollar broker's fund", "the Indian bank account"), never the household's.

## 1. What this is

Rokda knows each holding, its units from the trades and its price, but nothing about what the shares pay. The household wants to see dividends as passive income: what has come in, what is coming, which holdings pay and how often, and, over the years, whether dividends become a real share of what the household lives on.

**Done when:**

- dividends the feeds find after a holding's opening entry are attributed to their ex-dates at the units the trades say were held, on the share basis of that ex-date, catching up after any delay in the feeds;
- what a dividend is expected to pay (worked out) is kept apart from what was received (from evidence), in storage and on screen;
- a dividend received into a broker's fund moves that fund exactly once, across retries, fixes, deletions and balance check-ins; a dividend paid into a bank account never moves a balance;
- Wealth has a Dividends tab that keeps Earned, Expected and Received apart, says which periods each market covers, and never adds dividends to the Life plan a second time.

## 2. What the household decided

1. **A dividend is recorded, not only estimated.** Where the money lands is part of the record.
2. **Dividends are their own records, not income transactions.** Recorded income feeds the Life plan's monthly saving (`forecastInputs`), and the plan's return already includes dividends, so an income transaction would count each dividend twice. Transactions also never move a balance; a dividend paid into a broker's fund must, as a trade does.
3. **Three states, three words.** *Earned*: the ex-date has passed with units held, so the dividend is the household's. *Expected*: what it should pay, worked out from the units, the amount per share, the withholding rate and any fees. *Received*: what arrived, from evidence. The screen uses those three words.
4. **Only money into a broker's fund is confirmed.** The dollar broker pays US dividends into its fund (a Broker funds account); the bot asks, and a "yes" records the receipt and moves the fund. Indian companies pay straight into the bank account linked to the demat account. A bank balance is a snapshot confirmed at the monthly check-in, so nothing moves and nothing is asked.
5. **An Indian dividend is presumed received 30 days after its ex-date** (an Indian company must pay within 30 days of declaring, and declares before the record date). It counts as received, stored and shown as "presumed, not checked", at its expected figures. The companies' credit-intimation emails turn presumed receipts into checked ones: the import (section 7) runs once for the past and can run again every few months.
6. **The headline is cash received**, not earned: what the household has to live on.
7. **The Indian bank account is an account in Rokda** (a rupee bank account, added on 2 November 2026), so the money counts in net worth and each Indian dividend names where it went.
8. **Free data, checked live on 2 November 2026:**
   - Alpha Vantage's `DIVIDENDS` (free key, 25 requests a day on its support page; a 5-a-minute limit is reported by others, so calls are spaced anyway) returns every dividend of a share with ex-date, declaration date, record date, payment date and amount, including those declared but not yet paid. Its `SPLITS` returns a share's splits. It is the US source.
   - Yahoo's chart endpoint with `events=div,split` returns ex-date and amount for NSE symbols, and their splits (a bonus issue is a split), matching a company's own intimation for one checked payment. It lists a dividend only once its ex-date has passed and gives no payment date, so Indian dividends never appear before their ex-date. It is the Indian source. (Some companies publish payment dates on their own sites; reading them is out of scope.)
   - Yahoo adjusts past amounts for later splits (a share that split 10:1 shows a tenth of its pre-split dividend), and reports an ordinary and a special dividend on the same date as one combined amount. Both shape the rules below. Whether Alpha Vantage adjusts is settled in PR 1 from recorded responses.
   - Twelve Data (which prices the US holdings) puts dividends on a paid plan, EODHD's demo is refused and Nasdaq's covers Nasdaq-listed symbols only; none is used.
9. **Withholding is a default per holding, not a fact.** At the household's brokers, a US share's dividend has 30% withheld (the general rate for a non-resident without a treaty) and an Indian share's 20.8% (20% plus 4% cess, for a non-resident without a Tax Residency Certificate). A US-listed share of a foreign company (an ADR) is withheld by its home country and may carry depositary fees, so the rate is set on the holding and fees are their own figure. The product says "after withholding", never "after tax": the household's final tax is outside what Rokda knows.
10. **History before a holding's opening entry is imported, never estimated.** Units before it are unknown. Past Indian dividends come from the credit intimations, which state units, gross, tax, net, the record date and the credit date. Past US dividends are not estimated. A holding with no opening entry yet earns nothing; it appears only in projections, at its units today, labelled.
11. **Unpaid dividends are not in net worth.** Between an ex-date and the receipt, net worth is short by that dividend; the tab shows it as Earned, not yet received.

## 3. What is stored

### 3.1 `dividend_events`: what each share pays

Reference data from the feeds, the same for every household, like `fx_rate_history`.

| Column | Meaning |
|---|---|
| `id` | stable identity; household records point here |
| `symbol` | the holding's `price_symbol` (`ABC` for a US share, `ABC.NS` for an Indian one) |
| `ex_date` | in the exchange's own calendar |
| `amount` | numeric(18,6), per share **on the share basis of the ex-date**, in `currency` (3.1.1) |
| `source_amount`, `source_factor`, `source_fetched_on` | the amount as the source last gave it, the split factor applied to it, and the day of that fetch |
| `currency` | the currency the dividend is paid in, as the source states; the share's currency when the source says nothing |
| `pay_date`, `record_date`, `declared_on` | where the source gives them |
| `source` | `alphavantage` or `yahoo` |
| `first_seen_at`, `last_seen_at` | the first and the latest successful fetch that listed it |
| `superseded_by` | the event that replaced it after a moved ex-date (5.2), or null |

Unique `(symbol, ex_date)`. An event is **listed** when the latest successful fetch of its symbol listed it (`last_seen_at` equals the symbol's `last_success_at`, 3.4). Every fetch returns the symbol's whole history (5.1). One answer that leaves an event out changes nothing; `missed_checks` counts successful fetches in a row that have not listed it, and only two count as the source dropping it. An event listed again has `missed_checks` 0 and is no longer superseded. A failed fetch changes nothing; an answer with an unreadable item, or with no dividends for a symbol that has listed ones, is a failure. Two items on one ex-date are one event of both amounts, and two splits on one date one split of both ratios. Events are never deleted.

RLS: any signed-in member reads; only the service role writes.

#### 3.1.1 The share basis

A split multiplies the units and divides the per-share amounts after it. A dividend's entitlement is the units on its ex-date times its amount per share **as of that ex-date**. Sources that adjust past amounts for later splits give a smaller figure after a split, so each event stores `amount = source_amount × source_factor`, where `source_factor` is, for a source that adjusts, the product of the ratios of every split in `dividend_splits` (3.2) effective after the ex-date and before the day of the fetch that gave `source_amount` (`source_fetched_on`), and 1 for a source that does not. A split the source had not yet applied when it gave the amount is therefore never applied to it, and one learnt of later is applied as soon as it is known. It is recomputed whenever splits or the event are recorded, so an event's `amount` stays the same on its ex-date's basis however many splits follow. A split effective on the ex-date itself is ambiguous: such an event is not earned automatically and goes to review.

For projections the app wants the amount per share **today**, which is `amount` divided by the ratios of every split after the ex-date (4.3).

### 3.2 `dividend_splits`: each share's splits

`symbol`, `effective_date`, `ratio` (new units per old unit, numeric(18,8) > 0), `source`, `first_seen_at`, `last_seen_at`; unique `(symbol, effective_date)`. From Yahoo's `split` events for Indian shares, and Alpha Vantage's `SPLITS` for US shares. Reference data with the same RLS as 3.1. These are the market's splits; a holding's own split trades are what its units follow (4.1). A split the feed reports that the holding's trades do not show is not applied to the holding: the existing large-move question asks about it, and the tab lists it under items needing a member.

### 3.3 `dividend_special_parts`: a member's answer about the one-off part

Sources combine an ordinary and a special dividend on the same date into one amount. Which part is a one-off matters only to projections and frequency, which the app works out (4.3). This table holds a member's answer for one event: `household_id`, `event_id` (unique together), `special_per_share` (from 0, "not a one-off", to the event's amount, on the ex-date's basis), `updated_at`, `updated_by`. Members read and write their household's rows through a function. Received and earned totals always include the whole amount.

### 3.4 `dividend_feed_state`: what the feed last checked

`symbol`, `provider`, `kind` (`dividends` or `splits`), `last_attempt_at`, `last_success_at`, `last_failure_at`, `fail_count`, `last_error`, `covered_from` (the earliest date the source's history reached in the latest success). Service role only; the tab reads a summary per symbol through a function.

### 3.5 `holding_dividends`: what the household earned and received

One row per holding per dividend. Written only by the dividend functions (section 5); members read their own household's.

| Column | Meaning |
|---|---|
| `id`, `household_id`, `holding_id` | `(household_id, holding_id)` references `holdings (household_id, id)` |
| `event_id` | the event it was earned from; null for one added in the app or imported without a matching event |
| `ex_date` | from the event, or stated; null only for an added or imported receipt whose ex-date is unknown, which then counts as received but never as earned |
| `record_date`, `pay_date` | as the source or the evidence states them; may be null |
| `currency` | the dividend's currency; must equal the destination account's |
| `units`, `units_basis` | units held on the ex-date; `trades` (from the replay) or `stated` (typed or imported) |
| `per_share` | on the ex-date's basis; from the event while the row follows it (5.2) |
| `tax_pct` | the withholding rate used for the expected figures |
| `expected_gross`, `expected_tax`, `expected_fees`, `expected_net` | numeric(16,4), worked out: gross = units × per share, tax = gross × rate, fees = units × the holding's fee per share, net = gross − tax − fees |
| `received_gross`, `received_tax`, `received_fees`, `received_net` | numeric(16,4), from evidence; null until received; `received_fees` holds fees and any other deduction, so net = gross − tax − fees always holds |
| `status` | `earned`, `received`, `presumed` or `skipped` |
| `evidence` | for `received`: `member` (a confirmation in the bot or app) or `intimation` (an imported credit intimation) |
| `credited_on`, `credited_on_estimated` | the day the money arrived (for `presumed`, estimated as in 5.2) |
| `paid_into_account_id` | where the money went |
| `review_reason` | null, or why a member is asked to look: `trades_changed`, `feed_changed`, `split_on_ex_date`, `possible_duplicate`, `moved_ex_date` |
| `review_baseline` | jsonb: the per-share amount, units and ex-date a member last kept; a review is raised again only when these change (5.6) |
| `fixed` | true once a member has fixed it; the feed and the trades then flag instead of changing it |
| `source` | `feed`, `app`, `bot` or `import` |
| `import_ref` | the evidence's own reference (an intimation's advice number with the company); unique per household when set |
| `proposal_id` | the bot proposal that received it, not unique: one proposal can receive several dividends |
| `version` | integer, raised by every save; saves are checked against it |
| `note`, `created_at`, `updated_at`, `updated_by` | |

Dirham figures are not stored. The app converts when it reads (4.2), as "Profit on sales" does.

A receipt's effect on its fund is not stored either: it is worked out, as a trade's is, from its received net, its credit date and the fund's current confirmation (5.4).

Constraints (each gets a case in `migration-behaviour.test.sql`):

- unique `(holding_id, event_id)` when `event_id` is set, and unique `(holding_id, ex_date)` when `ex_date` is set;
- expected and received figures each satisfy net = gross − tax − fees, every figure ≥ 0, tax plus fees ≤ gross;
- received figures and `evidence` are set exactly when `status = 'received'`; `credited_on` is set exactly when `status` is `received` or `presumed`;
- `paid_into_account_id` belongs to the household and has the row's currency;
- `currency` equals the holding's.

That a row made by the feed is dated on or after its holding's opening entry is a condition of making it (5.2), not a constraint, so a later change to a holding's history flags existing rows instead of invalidating them.

### 3.6 Changes to `holdings` and `accounts`

- `holdings.dividend_tax_pct` numeric(5,2), 0–100, and `holdings.dividend_fee_per_share` numeric(18,6), default 0. The migration fills the rate from the asset class (Indian equity 20.8, US and international equity 30, others null) and a trigger does the same for new holdings; both are editable in the holding editor ("Withholding on dividends", "Fees per share"). A change applies to dividends earned afterwards and to `earned` rows not yet fixed; it never rewrites a received, presumed or fixed one.
- `accounts.dividends_into_account_id`, on a Broker funds account only: where its holdings' dividends are paid. Null means the fund itself. It must name an open account of the household in the fund's currency. The rupee broker's fund points at the Indian bank account; the dollar broker's fund stays null. Editable in the account editor for a Broker funds account.
- A holding's dividends go where its fund says, or to the fund itself once the account it names is closed (closing it never stops the fund's trades or balance). An `earned` row not fixed follows a change of destination at the next run of 5.2; received, presumed and fixed rows keep theirs. A holding with no fund has no destination: its dividends are earned, never moved, presumed received like a bank's, and the tab says where they went is not set.

### 3.7 Locks: the holding first

A holding's dividend rows are written only by a transaction that holds that holding's row lock, and every writer locks in one order: holdings (in id order), then dividend rows, then funds (in id order).

- The trade functions already lock their holding first and its funds after. They re-work dividends through a trigger on `holding_trades` (5.3), which runs inside them, under that holding lock, so they need no change.
- The dividend functions (section 5), a bot proposal that receives dividends, and `earn_dividends()` lock the holdings concerned first, in id order, then their dividend rows, then any funds.
- A balance confirmed in the app locks only its account's row, and every writer above locks that row before reading the confirmation, so a confirmation and a save are ordered by that row lock (5.4).

So two writers on one holding wait for each other at the holding, two on different holdings never share a dividend row, and no two writers can wait on each other. (An outside review proposed a household-wide lock taken first by every writer; this gives the same guarantee without rewriting the trade functions.)

## 4. The sums

All pure logic lives in `src/lib/dividends.js`, with `dividends.test.js` beside it. The database works out what was earned and what moved; the app works out dirhams, projections and summaries.

### 4.1 Units on the ex-date

- An opening entry is the units held at the start of its date.
- The units on an ex-date are the opening units plus every entry whose market day is before the ex-date, from the same replay the trades use (`private.holding_entries`, `private.replay_entries`). An entry's market day is its `traded_at` in the exchange's time zone when set (a US trade confirmed after midnight in Dubai belongs to the previous New York day), otherwise its `trade_date`.
- A trade on the ex-date itself does not count: a buyer on the ex-date is not paid. An ex-date on the opening date counts the opening units.
- A split, a bonus issue included, is an entry like any other, so units on a later ex-date are on that ex-date's basis, matching the event's amount (3.1.1).
- No row is made when the units are zero, or when the holding has no opening entry on or before the ex-date.

### 4.2 Dirhams

Converted when read, never stored:

- dollars at the peg (3.6725);
- rupees at the household's rate for the day from `fx_rate_history`, or the household's stored rate when that day has none, the rule "Profit on sales" uses; a rupee figure with no rate at all is unknown, never guessed;
- earned and expected figures at the ex-date's rate; received figures at the credit date's;
- projections at today's rate, and the tab says so. There is no FX forecast.

### 4.3 Today's basis, one-offs and frequency

- **Today's basis.** A past amount per share today is its `amount` divided by the ratios of every split in `dividend_splits` after its ex-date. Comparisons and projections use it.
- **One-offs.** A payment more than twice the median of the same share's payments over the previous 24 months (on today's basis, at least three of them) is a candidate one-off. The tab asks a member about it once ("looks like a one-off: is it?"), and until answered its excess over that median is left out of projections and frequency, labelled. A member's answer (3.3) replaces the rule for that event, either way. With fewer than three earlier payments, the share is "too new to tell one-offs", and nothing is left out.
- **Ordinary part**: the amount less the special part (the member's, or the candidate's excess).
- **Frequency**: ordinary payments in the last 24 months, halved: about 1 a year is yearly, 2 half-yearly, 4 quarterly, 12 monthly, anything else irregular. With less than 24 months of source history (`covered_from`), it is worked over what there is, and fewer than two payments is "too new to say". The usual interval is 12 months divided by that count.

### 4.4 Expected receipts over the next twelve months

A cash forecast, labelled as one. For each holding still held, and each holding with a dividend earned but not received:

| Situation | What is counted |
|---|---|
| Earned, not yet received | its expected net, on its pay date, or in the month of its ex-date plus the share's usual gap |
| Declared, ex-date to come (a listed event) | today's units × the full declared amount, less withholding and fees, on its pay date; it assumes the units are still held on the ex-date |
| Not yet declared, share paying regularly | for each ordinary payment of the last twelve months, the same ordinary amount (today's basis) one year later at today's units; shown by month, not day |
| Irregular payer | the average ordinary amount a year over the last 24 months, shown as "irregular", with no month |
| Too little history (under twelve months covered and fewer than two payments) | "not enough history", never zero |
| Stopped paying (no ordinary payment for 1.5 times its usual interval, nothing declared) | left out, flagged "may have stopped paying" |

**A declaration replaces one projected payment.** Each declared dividend is matched to at most one projected payment of the same share: the nearest by ex-date, within half the share's usual interval. That projected payment is dropped; any others stand.

The usual gap from ex-date to payment is the median of the share's known gaps, or 30 days with none. Withholding and fees are the holding's current defaults. Special parts are never extrapolated; a declared special counts in full, since it is declared. A newly bought share is projected from the share's own history, not from the household's receipts.

Yield on value is the next twelve months' ordinary amount per share (declared or extrapolated, before withholding) over today's price; yield on cost is the same over the holding's average price, which for the opening entry is the broker's average. Neither is shown without a price, an average or units.

### 4.5 Spending equivalent

"Equivalent to X% of recorded spending", in the screen's scope, against spending as the Life plan counts it (`closedMonths`: refunds netted, transfers excluded):

- once received dividends cover a full twelve months: received over the last twelve closed months ÷ spending over the same months;
- before that: expected receipts over the next twelve months ÷ (average monthly spending over the last twelve closed months × 12), labelled "expected".

Not shown with fewer than three closed months or no spending.

## 5. Recording

### 5.1 The feed: `dividend-refresh`

A new Edge Function, separate from `price-refresh` so a dividend failure never stops prices. A new job, `daily-dividend-refresh`, runs it at 01:30 UTC, before the morning check, with the vault's scheduler secret (the same caller rules as `fd-accrual`).

A symbol is followed while any holding with it is held or has a dividend earned and not yet received, and, at a lower priority, for twelve months after its last units were sold, checked weekly.

Every fetch asks for the symbol's **whole history**, so a gap of any length is caught up in one success, and "listed" (3.1) means what the source has now.

1. **Indian symbols** (priced by Yahoo): Yahoo's chart endpoint with `events=div,split`, a monthly interval and the longest range it gives; dividends and splits from one call.
2. **US symbols** (US and international equity): at most five Alpha Vantage calls a run, twelve seconds apart. First `DIVIDENDS`, in this order: symbols with an event whose ex-date has passed since their last success (so it can be earned the next morning), then symbols never checked, then held symbols longest since their last success, then sold ones due their weekly check. Then, with any calls left, `SPLITS`: first for a symbol whose stored past amounts just changed (the mark of a split), then the longest unchecked. Without an `ALPHAVANTAGE_API_KEY` secret the US side is skipped and the tab says so.
3. A response is a success only if it parses as the source's list; Alpha Vantage's notes and limit messages arrive as HTTP 200 and count as failures. A failure changes no event and records the failure.
4. Upsert the splits (3.2), then the events, recomputing each `amount` from the splits known (3.1.1); record the check (3.4); then call `public.earn_dividends()`.

PR 1 settles, against recorded responses for shares that split, whether each source adjusts past amounts, and sets `source_factor` accordingly.

### 5.2 Earned: `earn_dividends()`

Service role only, idempotent, safe to run any number of times. Holding by holding, in id order, each under its row lock (3.7) and in its own subtransaction: a holding that cannot be done is reported in the result and the others are still earned.

1. **Moved ex-dates.** Decided once per symbol, before any holding is locked: an event with rows that two checks in a row have not listed is superseded (`superseded_by`) by the one listed event of the same symbol within 15 days of it, when there is exactly one. Then, per holding, each `earned` row not fixed on a superseded event moves to its replacement, with units and figures worked out again, unless the holding already has a row on the replacement or its ex-date; any other row on a dropped or superseded event is flagged `moved_ex_date`, and is not presumed received. A superseded event is never earned again unless it is listed again.
2. **New rows.** For every listed event whose ex-date has passed, with no pay date before its ex-date and no split effective on its ex-date, not superseded, and every holding with that symbol whose units on the ex-date (4.1) are above zero and whose opening entry is on or before the ex-date:
   - if the holding has a row for that event, nothing;
   - else if it has a row with no event for **the same ex-date**, that row is linked to the event and keeps its figures, flagged `feed_changed` if its per-share amount differs;
   - else if it has a row with no event within 10 days of the ex-date or pay date, nothing is made: that row is flagged `possible_duplicate` with the event named, for a member to link or reject;
   - else a row is made: `earned`, `per_share` from the event, expected figures from the holding's rate and fee, `paid_into_account_id` from 3.6, source `feed`. A destination in another currency cannot arise (a holding's fund has its currency, by the trades' rule, and 3.6 holds the fund's destination to the same); the function refuses one anyway.

   An event with a pay date before its ex-date (some large special distributions) or a split on its ex-date is listed under items needing a member, to add by hand.
3. **Feed changes.** When a listed event's `amount` or dates differ from a row that follows it: a row still `earned` and not fixed takes them and its expected figures are worked out again; any other row is flagged `feed_changed`, unless the new figures match its `review_baseline`.
4. **Presumed.** A row still `earned` whose destination is not a Broker funds account becomes `presumed` 30 days after its ex-date, or once its pay date has passed when it has one, whichever is later, with `credited_on` set to that day and marked estimated.

### 5.3 Trades change what was earned

A trigger on `holding_trades` (after a trade is inserted or deleted, or its date, time, units or kind change) re-works, in the same transaction and under the holding's lock (and never refusing the trade if the re-work fails; the nightly run then tries again), the holding's dividends with an ex-date on or after the earliest date the change touches:

- an `earned` row not fixed takes its new units and expected figures, and is removed if its units are now zero;
- a `received`, `presumed` or fixed row whose units would change keeps its figures and is flagged `trades_changed`, unless the new units match its `review_baseline`;
- an event that now has units where it had none gets its row at once, by the rules of 5.2.

So a backdated buy, a sale fixed to an earlier date, or a split recorded late reaches the dividends without waiting for the feed.

### 5.4 Received into a broker's fund

**The balance rule.** A fund's balance is its last confirmed figure plus every movement dated after that confirmation: trades' cash and dividends received. A receipt's contribution is its received net if its credit date is after the fund's `balance_as_of` by the trades' rule (`private.trade_moves_fund`: a credit date with no time counts at the end of its day in Dubai), and nothing otherwise. A confirmation made in the app is dated at the start of its day, so a credit on that day counts as after it; a confirmation from the bot is dated at its moment. Nothing about the contribution is stored: it is worked out whenever it is needed, from the receipt and the fund as they are.

**Every change follows the rule**, in one transaction: work out what the receipt contributes now (from its old figures, old credit date and old fund, against that fund's current confirmation), work out what it will contribute (new figures, date and fund), and move each fund by the difference. So:

| Starting point | Change | Movement |
|---|---|---|
| Fund confirmed at 100 on the 1st; $70 received on the 5th (fund 170) | fixed to $68 on the 8th | −2 (fund 168) |
| As above, then the fund confirmed at 168 on the 10th | fixed to $66 on the 12th | none: the receipt is before the confirmation, which holds the real figure |
| Fund confirmed on the 1st; $70 received on the 5th | credit date changed to the 31st of the month before | −70: now before the confirmation |
| $70 received on the 5th into fund A (confirmed on the 1st); fund B confirmed on the 6th | moved to fund B | A −70; B none, since the 5th is before B's confirmation |
| $70 received on the 5th, after the confirmation | skipped | −70; restoring it to `earned` moves nothing until it is received again |
| As above, but the fund confirmed on the 7th | skipped | none |

Bank destinations are refused any movement by the function itself.

**Concurrency.** Each save locks the holdings concerned (3.7), then the dividend rows, then every fund it touches in id order, and only then reads the funds' confirmations. A confirmation in the app on the same fund either commits first, and the save reads it, or waits for the save's lock, and replaces the balance after it. Each save states the dividend `version` it was shown, and the fund confirmation it was shown (`balance_as_of`): either different, and nothing is saved. Balance changes are written to `account_balance_events` as trades' are.

### 5.5 The bot

Once a day, in the morning check, each member whose broker-fund dividends have reached their pay date and are still `earned` gets one message for all of them, as a new proposal kind `dividends_received`:

> Dividends due in the dollar broker's fund today:
> ABC: 40 × $0.25 = $10.00, $3.00 withheld, **$7.00**
> XYZ: 10 × $0.50 = $5.00, $1.50 withheld, **$3.50**
> Reply "yes" (or react 👍) once they are in the fund to add $10.50, or "no" to leave them for the app.

- The proposal stores, for each line, the dividend's `version`, and the fund's `balance_as_of` as shown. A "yes" records every line as received with the expected figures, evidence `member`, credit date the pay date, through `apply_bot_proposal`, in one transaction, at the versions shown. The proposal itself is applied once.
- **When the fund was confirmed on or after the pay date**, the credit date decides whether the fund moves, so the message asks instead: "Your fund's balance was confirmed on 12 Nov. Was this already in it?" "Yes" records the pay date as the credit date and moves nothing; "no" records the day of the answer and moves the fund. The movement is shown before it is confirmed.
- If any line's version, or the fund's confirmation, changed since the message, nothing is saved and the message is sent again with today's figures.
- A figure that differs is fixed in the app; the bot does not take corrections. Each dividend is asked about once; an unanswered or declined one stays under "To record" in the app. Switchable in Settings → Telegram like the other nudges.

**Not logged twice.** An income message that reads as a dividend ("ABC dividend credit") is not logged as income: the bot says dividends are recorded on their own and points to the tab, so a dividend never reaches the Life plan as saving.

### 5.6 The app

Every member write goes through a function that checks, at save time, that the member belongs to the household and that the holding, the dividend and the destination account all belong to it, in the dividend's currency. Figures are worked out on the server; the client's are never taken as given. As trades do, `preview_dividend` returns the figures, the movement and any warning, and `save_dividend` saves exactly that at the dividend version and fund confirmation previewed; if either changed, nothing is saved and the form asks to check again.

- **Record**: an earned broker-fund dividend as received, with the credit date (the pay date unless changed) and, if different, the received figures. When the fund was confirmed on or after the credit date, the form asks, as the bot does, whether the receipt was already in that balance: "yes" keeps the credit date and moves nothing, "no" sets the credit date to today and moves the fund.
- **Fix**: units, per share, withholding, fees, received figures, credit date, or where it was paid. For an Indian dividend, this is where the email's exact figures go, turning presumed into received with evidence `member`.
- **One-off**: answer "looks like a one-off" for an event (3.3), or set its special part.
- **Skip** or **restore**.
- **Add**: a dividend the feed missed, or an older receipt (`source = 'app'`, `units_basis = 'stated'`), with or without an ex-date.
- **Review**: a flagged row shows what changed; "keep" stores the current figures as its `review_baseline` and clears the flag, and "fix" opens Fix; a `possible_duplicate` is linked to the named event or kept apart.

The feed job is the one writer outside this contract: it writes reference data and earned rows as the service role (5.1, 5.2), under each holding's lock.

## 6. The Dividends tab

A fifth tab on Wealth, after Investments, in the screen's scope (household, or one member). Layout follows the `design-taste-frontend` app-screen checklist; look follows `design/` and Rokda's palette. On a phone, rows are two lines and nothing scrolls sideways.

1. **Headline**: received over the last twelve months (or "since" the start of coverage, when shorter), with the presumed part said ("of which ₹… presumed, not checked"); expected over the next twelve months and its monthly equivalent; and the spending equivalent (4.5). The Indian market and the US market each as a smaller figure beneath, each with the period it covers.
2. **Coming up**: declared dividends with their dates, expected net and destination; earned dividends not yet received; broker-fund ones carry "Record". Then **Needs you**: flagged rows, candidate one-offs, possible duplicates, splits the trades do not show, and events to add by hand.
3. **By month**: received per month for up to 24 months (presumed receipts shaded apart), the next twelve months expected in a lighter shade, and a total per year. A switch shows Earned by ex-date month instead; receipts with no known ex-date are left out of that view, and it says how many.
4. **By holding**: each holding with dividends found, with its frequency, last ordinary amount per share, received over the last twelve months, expected over the next twelve, yield on value and on cost, and the next date (a day if declared, a month if projected). Sorted by expected. Holdings with none are folded under "No dividends found since <date>", the start of that symbol's checked history, kept apart from symbols whose checks are failing. A holding opens its dividends, each with its status, its figures and Fix, Skip or Record.
5. **Where it comes from**: by listing market (Indian, US), each with its withholding, and by sector with an "Unknown" bar, both on expected receipts over the next twelve months, as short bars like the concentration line. When the two markets cover different periods, the section says so.
6. **Freshness and honesty**: per market, the last successful check, any failing symbols and since when; the dates covered; that units before a holding's opening entry are unknown; that a projection is one; that unpaid dividends are not in net worth; and that the Life plan already counts dividends in its return, so this tab is cash flow, not a second return.

States: loading; a load failure that says what did not load (never "None"); no holdings that pay; feeds not yet run; one market failing while the other works.

## 7. Past dividends

A data task, not code, after PR 2 and again every few months: the credit-intimation emails are read, matched to holdings, and shown as a worksheet; nothing is saved before the household's "go". Each becomes a `received` row with evidence `intimation`, source `import`, its stated units and figures, its record date, its credit date, and its `import_ref` (the intimation's advice number with the company), through the same function as Add or Fix:

- a rerun finds the `import_ref` and changes nothing;
- the ex-date is the matching event's when exactly one event of that share has an ex-date in the five business days up to the record date, and unknown otherwise (before the move to T+1 settlement the two differed);
- a matching earned or presumed row (same holding and ex-date) is completed rather than duplicated; a near match goes to review.

Nothing about the emails or their figures enters the repository.

## 8. Build order

| PR | What | Done when |
|---|---|---|
| **1. Records and feed** | 3.1–3.7 with their constraints and RLS, the trigger that re-works dividends when trades change, `earn_dividends()`, 5.3, `dividend-refresh` and its job, the withholding, fee and "paid into" fields in the editors | the event, entitlement, supersession and trade rules are proved in SQL tests before ingestion is built; parsers pass on recorded responses for both sources, including errors, a split and a combined special; the scenarios below marked 1 pass |
| **2. Receipts** | 5.4–5.6: the functions, the morning message, the bot's dividend guard, Record / Fix / One-off / Skip / Add / Review | the scenarios below marked 2 pass, with exact balances, in both transaction orders where two writers meet |
| **3. The tab** | section 6 and `src/lib/dividends.js` | the sums in section 4 and the tab's states are tested; a browser test on a phone covers long holding names, unknown dates, one market failing, and Record and Fix |
| **Data task** | section 7 | the worksheet is approved; imported rows reconcile with it; a rerun changes nothing |
| **Later** | a tax-year panel (withholding per market, for the return), a dividend income goal in Planning, dividend growth per holding | each its own issue |

Required scenarios (balances in the fund's currency, the fund confirmed at 100 on the 1st unless stated):

| Scenario | Required result | PR |
|---|---|---|
| An ex-date moves before the first check after it | one earned row, on the new date | 1 |
| An ex-date moves after the row was earned | the unfixed row moves to the new event; one row, never two | 1 |
| An ex-date moves after the row was received | the row stays, flagged `moved_ex_date`; the new event earns nothing for that holding | 1 |
| The first fetch after a dividend comes after a 10:1 split, with the source's amount adjusted | `amount` on the ex-date's basis; the row's gross is units on the ex-date × that amount | 1 |
| A split effective on an ex-date | not earned; listed for review | 1 |
| A dividend added by hand on the same ex-date is later found by the feed | one row, linked, flagged if the figures differ | 1 |
| A dividend added by hand eight days from a feed event | no second row; flagged `possible_duplicate` | 1 |
| A holding sold after the ex-date | its dividend stays earned and comes in | 1 |
| A backdated buy, sale or split | earned rows re-worked; received ones flagged, unchanged | 1 |
| A flagged row kept, then the same feed figures again | not flagged again | 1, 2 |
| A holding without an opening entry | no earned rows | 1 |
| An Indian dividend with no evidence | presumed after 30 days, labelled, never moves a balance | 1 |
| A destination in another currency | refused | 1, 2 |
| An outage longer than any fetch window, then one success | every dividend in the gap found and earned | 1 |
| Two members confirm the same dividend at once | one receipt; fund 107 | 2 |
| A receipt of 7 credited on the 5th, previewed before a confirmation at 107 on the 5th that already includes it, saved after | the save is refused (the confirmation changed); asked again, "already in it" ends at 107; saved before the confirmation, 107 too; never 114 | 2 |
| The rows of section 5.4's table | the movements and balances it states | 2 |
| A batch "yes" for two dividends, then the same "yes" again | both received once; the second applies nothing | 2 |
| A "yes" after the fund was confirmed past the pay date | the bot asks whether it was already included; nothing moves until answered | 2 |
| A "yes" after any line or the fund's confirmation changed | nothing saved; the message is sent again | 2 |
| One declaration among monthly projections | exactly one projected payment replaced | 3 |
| A candidate one-off, then a member's answer | its excess left out until answered; the answer then rules | 3 |
| One market's history covers less than the other's | the tab says so | 3 |
| An import is rerun | no duplicate receipt, no movement | data task |

Each PR updates `docs/features.md` and a "Dividends" section in `docs/decisions.md`, and changes the "A broker's cash is an account" bullet that says dividends move a fund without a trade. PR 1 adds `dividend-refresh`'s tests to the bot test command in `CLAUDE.md`. New tables get RLS cases in `rls-policies.test.sql`; new constraints and triggers get cases in `migration-behaviour.test.sql`.

## 9. What could go wrong, and what stops it

| Risk | What stops it |
|---|---|
| A dividend counted twice in a fund | the balance rule (5.4), worked out from the receipt and the fund as they are, on every save, under the holding's and the fund's locks, at a checked version and confirmation |
| Two writers waiting on each other | holdings locked first, then dividend rows, then funds, by every writer (3.7) |
| Counted twice in the Life plan | dividends are not income transactions, and the bot does not log one as income |
| Wrong units, or the wrong share basis | units from the trade replay on the ex-date's basis; amounts normalised to that basis from the source's splits; re-worked when trades change; nothing before an opening entry |
| A feed misreads, moves or withdraws a dividend | whole-history fetches; only listed events are earned; moved dates supersede, never duplicate; changes to received rows are flagged, never applied; every broker-fund figure is seen before a fund moves |
| A presumed Indian receipt never arrived | labelled "presumed, not checked" everywhere it counts; the import or a fix checks it; Skip removes it |
| A one-off inflates the forecast | candidates asked about, their excess left out until answered; special parts never extrapolated |
| Yahoo (unofficial) changes or blocks | Indian events stop, the tab says since when, dividends can be added by hand |
| Alpha Vantage's allowance | at most five calls a run, a fifth of the free allowance; a refusal is a failure like any other |
| The wrong withholding rate, fees or currency | per holding, editable; each dividend's figures editable and kept as received; a destination in another currency refused |

Not changed here: a balance confirmed in the app with a past date replaces the balance, so a trade dated between that date and the moment of confirming is lost from it. That affects trades today and is its own issue.

## 10. Out of scope

Reinvested dividends (DRIP), tax owed in the UAE (none), reclaiming withheld tax, the household's final tax position, mutual-fund distributions, interest on cash, payment dates from company websites, analyst forecasts, converting a dividend into another currency, and estimating dividends from before a holding's opening entry.
