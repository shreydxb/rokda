# Dividends: what the shares pay, after withholding, as passive income

Design for SHR-366. Status: second draft for the household's review, 2 November 2026, revised after an outside review of the first. This repository is public: every figure, ticker and account below is a round example ("ABC", "the dollar broker's fund", "the Indian bank account"), never the household's.

## 1. What this is

Rokda knows each holding, its units from the trades and its price, but nothing about what the shares pay. The household wants to see dividends as passive income: what has come in, what is coming, which holdings pay and how often, and, over the years, whether dividends become a real share of what the household lives on.

**Done when:**

- dividends the feeds find after a holding's opening entry are attributed to their ex-dates at the units the trades say were held, catching up after any delay in the feeds;
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
   - Alpha Vantage's `DIVIDENDS` (free key, 25 requests a day on its support page; a 5-a-minute limit is reported by others, so calls are spaced anyway) returns ex-date, declaration date, record date, payment date and amount, including dividends declared but not yet paid. It is the US source.
   - Yahoo's chart endpoint with `events=div` returns ex-date and amount for NSE symbols, matching a company's own intimation for one checked payment. It lists a dividend only once its ex-date has passed and gives no payment date, so Indian dividends never appear before their ex-date. It is the Indian source. (Some companies publish payment dates on their own sites; reading them is out of scope.)
   - Yahoo adjusts past amounts for later splits (a share that split 10:1 now shows a tenth of its pre-split dividend), and reports an ordinary and a special dividend on the same date as one combined amount. Both shape the rules below.
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
| `amount` | numeric(18,6), per share, in `currency`, as the source last gave it (adjusted for later splits where the source adjusts) |
| `currency` | the currency the dividend is paid in, as the source states; the share's currency when the source says nothing |
| `pay_date`, `record_date`, `declared_on` | where the source gives them |
| `source` | `alphavantage` or `yahoo` |
| `first_seen_at`, `last_seen_at` | the first and the latest successful fetch that listed it |

Unique `(symbol, ex_date)`. A moved ex-date arrives as a new event; the old one is never deleted, simply no longer listed. An event is **listed** when its `last_seen_at` is at or after its symbol's last successful check (3.4). Only listed events show as declared, and only an event listed by a check made after its ex-date is ever earned (5.2), so a moved or withdrawn dividend is never earned from its old date. Nothing is inferred from a single missing response: a failed check changes nothing.

RLS: any signed-in member reads; only the service role writes.

### 3.2 `dividend_special_parts`: a member's word on the one-off part

Sources combine an ordinary and a special dividend on the same date into one amount. Which part is a one-off matters only to projections and frequency, which the app works out (4.3); this table holds a member's override of that rule for one event, and nothing else.

| Column | Meaning |
|---|---|
| `household_id`, `event_id` | unique together |
| `special_per_share` | numeric(18,6), from 0 to the event's amount |
| `updated_at`, `updated_by` | |

Members read and write their household's rows through a function; RLS as for any household table. Received and earned totals always include the whole amount, special part and all.

### 3.3 `holding_dividends`: what the household earned and received

One row per holding per dividend. Written only by the dividend functions (section 5); members read their own household's.

| Column | Meaning |
|---|---|
| `id`, `household_id`, `holding_id` | `(household_id, holding_id)` references `holdings (household_id, id)` |
| `event_id` | the event it was earned from; null for one added in the app or imported without a matching event |
| `ex_date` | from the event, or stated; may be null only for an imported or added receipt whose ex-date is unknown, which then counts as received but never as earned |
| `pay_date` | scheduled, from the event or stated; may be null |
| `units`, `units_basis` | units held on the ex-date; `trades` (from the replay) or `stated` (typed or imported) |
| `per_share` | frozen when the row is made; a later feed figure never changes it (5.2) |
| `tax_pct` | the withholding rate used for the expected figures, kept for the record |
| `expected_gross`, `expected_tax`, `expected_fees`, `expected_net` | numeric(16,4), worked out: gross = units × per share, tax = gross × rate, fees 0 unless the holding states a fee per share, net = gross − tax − fees |
| `received_gross`, `received_tax`, `received_fees`, `received_net` | numeric(16,4), from evidence; null until received; `received_fees` holds fees and any other deduction, so net = gross − tax − fees always holds |
| `status` | `earned`, `received`, `presumed` or `skipped` |
| `evidence` | for `received`: `member` (a confirmation in the bot or app) or `intimation` (an imported credit intimation) |
| `credited_on`, `credited_on_estimated` | the day the money arrived (for `presumed`, the ex-date plus 30 days, estimated) |
| `paid_into_account_id` | where the money went |
| `fund_moved` | numeric(16,2), what this receipt moved its fund by and still contributes (0 when nothing moved) |
| `aed_rate`, `aed_rate_on` | the rate used for its dirham figures and the date it was taken from (4.2) |
| `review_reason` | null, `trades_changed` or `feed_changed`: set when something changed under a received or fixed row that is not applied automatically |
| `fixed` | true once a member has fixed it; the feed and the trades then flag instead of changing it |
| `source` | `feed`, `app`, `bot` or `import` |
| `proposal_id` | the bot proposal that received it; unique when set |
| `version` | integer, raised by every save; saves are checked against it |
| `note`, `created_at`, `updated_at`, `updated_by` | |

Constraints (each gets a case in `migration-behaviour.test.sql`):

- unique `(holding_id, event_id)` when `event_id` is set, and unique `(holding_id, ex_date)` when `ex_date` is set;
- expected and received figures each satisfy net = gross − tax − fees, every figure ≥ 0, tax and fees ≤ gross;
- received figures and `evidence` are set exactly when `status = 'received'`; `credited_on` is set exactly when `status` is `received` or `presumed`;
- `fund_moved` is 0 unless `paid_into_account_id` is a Broker funds account and the status is `received`;
- a `feed` row's ex-date is on or after its holding's opening entry date; only `app` and `import` rows may be earlier;
- `paid_into_account_id` belongs to the household.

### 3.4 `dividend_feed_state`: what the feed last checked

`symbol`, `provider`, `last_attempt_at`, `last_success_at`, `last_failure_at`, `fail_count`, `last_error`, `covered_from` (the earliest date the source's history reaches for the symbol). Service role only; the tab reads a summary per symbol through a function.

### 3.5 Changes to `holdings` and `accounts`

- `holdings.dividend_tax_pct` numeric(5,2), 0–100, and `holdings.dividend_fee_per_share` numeric(18,6), default 0. The migration fills the rate from the asset class (Indian equity 20.8, US and international equity 30, others null) and a trigger does the same for new holdings; both are editable in the holding editor ("Withholding on dividends", "Fees per share"). A change applies to dividends earned afterwards and to `earned` rows not yet fixed; it never rewrites a received, presumed or fixed one.
- `accounts.dividends_into_account_id`, on a Broker funds account only: where its holdings' dividends are paid. Null means the fund itself. The rupee broker's fund points at the Indian bank account; the dollar broker's fund stays null. Editable in the account editor for a Broker funds account.
- A holding's dividends go where its fund says. A holding with no fund has no destination: its dividends are earned, never moved, presumed received like a bank's, and the tab says where they went is not set.

## 4. The sums

All pure logic lives in `src/lib/dividends.js`, with `dividends.test.js` beside it. The database works out what was earned and what moved; the app works out projections and summaries.

### 4.1 Units on the ex-date

- An opening entry is the units held at the start of its date.
- The units on an ex-date are the opening units plus every entry whose market day is before the ex-date, from the same replay the trades use (`private.holding_entries`, `private.replay_entries`). An entry's market day is its `traded_at` in the exchange's time zone when set (a US trade confirmed after midnight in Dubai belongs to the previous New York day), otherwise its `trade_date`.
- A trade on the ex-date itself does not count: a buyer on the ex-date is not paid. An ex-date on the opening date counts the opening units.
- No row is made when the units are zero, or when the holding has no opening entry on or before the ex-date.
- A split, a bonus issue included, is an entry like any other, so it changes the units of every later ex-date; 5.2 says how existing rows follow it.

### 4.2 Dirhams

- Dollars at the peg (3.6725).
- Rupees at the household's rate for the day from `fx_rate_history`, or the household's stored rate when that day has none, the rule "Profit on sales" uses. A rupee figure with no rate at all is unknown, never guessed.
- Earned and expected figures use the ex-date's rate; received figures use the credit date's. The rate used and its date are stored on the row (`aed_rate`, `aed_rate_on`).
- Projections use today's rate and say so; there is no FX forecast.

### 4.3 Ordinary and special, and frequency

- **Special part** (`auto`): for an event whose amount is more than twice the median of the same share's ordinary amounts over the previous 24 months, with at least three of them, the special part is the amount less that median. With fewer than three, the special part is 0 and the share is marked "too new to tell one-offs". A member can set the special part of any event (`member`), from none to all of it.
- **Ordinary part**: the amount less the special part.
- **Frequency**: ordinary payments in the last 24 months, halved: about 1 a year is yearly, 2 half-yearly, 4 quarterly, 12 monthly, anything else irregular. With less than 24 months of source history (`covered_from`), it is worked over what there is, and fewer than two payments is "too new to say".

### 4.4 Expected receipts over the next twelve months

A cash forecast, labelled as one. For each holding still held, and each holding with a dividend earned but not received:

| Situation | What is counted |
|---|---|
| Earned, not yet received | its expected net, on its pay date, or in the month of its ex-date plus the share's usual gap |
| Declared, ex-date to come (a listed event) | today's units × the full declared amount, less withholding and fees, on its pay date; it assumes the units are still held on the ex-date |
| Not yet declared, share paying regularly | for each ordinary payment of the last twelve months, the same ordinary amount one year later, at today's units, unless a declared dividend falls within 45 days of that date (it replaces it); shown by month, not day |
| Irregular payer | the average ordinary amount a year over the last 24 months, shown as "irregular", with no month |
| Too little history (under twelve months covered and fewer than two payments) | "not enough history", never zero |
| Stopped paying (no ordinary payment for 1.5 times its usual interval, nothing declared) | left out, flagged "may have stopped paying" |

The usual gap from ex-date to payment is the median of the share's known gaps, or 30 days with none. Withholding and fees are the holding's current defaults; dirhams at today's rate. Special parts are never extrapolated; a declared special counts in full, since it is declared. A newly bought share is projected from the share's own history, not from the household's receipts.

Yield on value is the next twelve months' ordinary amount per share (declared or extrapolated, before withholding) over today's price; yield on cost is the same over the holding's average price, which for the opening entry is the broker's average. Neither is shown without a price, an average or units.

### 4.5 Spending equivalent

"Equivalent to X% of recorded spending", in the screen's scope, against spending as the Life plan counts it (`closedMonths`: refunds netted, transfers excluded):

- once received dividends cover a full twelve months: received over the last twelve closed months ÷ spending over the same months;
- before that: expected receipts over the next twelve months ÷ (average monthly spending over the last twelve closed months × 12), labelled "expected".

Not shown with fewer than three closed months or no spending.

## 5. Recording

### 5.1 The feed: `dividend-refresh`

A new Edge Function, separate from `price-refresh` so a dividend failure never stops prices. A new job, `daily-dividend-refresh`, runs it at 01:30 UTC, before the morning check, with the vault's scheduler secret (the same caller rules as `fd-accrual`).

A symbol is followed while any holding with it is held, was held in the last 90 days, or has a dividend earned and not yet received.

1. **Indian symbols** (priced by Yahoo): Yahoo's chart endpoint with `events=div`, two years the first time a symbol is checked, three months after that; one call each, as the price feed already makes.
2. **US symbols** (US and international equity): Alpha Vantage's `DIVIDENDS`, at most five calls a run, twelve seconds apart, in this order: symbols with an event whose ex-date has passed since their last success (so it can be earned the next morning), then symbols never checked, then the longest since their last success. Every symbol is checked at least weekly at today's count; the tab says when one has not been. Without an `ALPHAVANTAGE_API_KEY` secret the US side is skipped and the tab says so.
3. A response is a success only if it parses as the source's dividend list; Alpha Vantage's notes and limit messages arrive as HTTP 200 and count as failures. A failure changes no event and records the failure.
4. Upsert the listed events (3.1), record the check (3.4), then call `public.earn_dividends()`.

PR 1 also settles, against recorded responses for a share that split, whether Alpha Vantage's past amounts are adjusted for splits as Yahoo's are. If they are not, the feed reads Alpha Vantage's `SPLITS` for each US symbol in the same rotation, within the same five calls (two a symbol), and adjusts past amounts to today's shares before storing them; each symbol is then checked about every six days instead of three.

### 5.2 Earned: `earn_dividends()`

Service role only, idempotent, safe to run any number of times.

1. **New rows.** For every event listed by a successful check made on or after its ex-date, with no pay date before its ex-date, and every holding with that symbol whose units on the ex-date (4.1) are above zero:
   - if the holding has a row for that event, nothing;
   - else if it has a row added in the app or imported with no event, for an ex-date or pay date within 10 days, that row is linked to the event and keeps its figures (flagged `feed_changed` if its per-share amount differs);
   - else a row is made: `earned`, `per_share` frozen from the event, expected figures from the holding's rate and fee, `paid_into_account_id` from 3.5, source `feed`.

   An event with a pay date before its ex-date (some large special distributions) is not earned automatically; the tab lists it for a member to add.
2. **Feed changes.** When a listed event's amount or pay date differs from a row made from it, a row still `earned` and not fixed takes the new pay date, and the new amount only when the difference is not explained by a split recorded on the holding after the ex-date; any other row is flagged `feed_changed`. A frozen per-share figure is never changed by the feed.
3. **Presumed.** A row still `earned` whose destination is not a Broker funds account becomes `presumed` once 30 days have passed since its ex-date, or once its pay date has passed when it has one, with `credited_on` set to that day and marked estimated.

### 5.3 Trades change what was earned

Every function that saves, fixes or deletes a trade (`record_trade`, `fix_trade`, `delete_trade`, `record_new_holding_trade`, the opening entry's fix) re-works, in the same transaction, the holding's dividends with an ex-date on or after the earliest date the change touches:

- an `earned` row not fixed takes its new units and expected figures, and is removed if its units are now zero;
- a `received`, `presumed` or fixed row whose units would change keeps its figures and is flagged `trades_changed`;
- an event that now has units where it had none gets its row at once.

So a backdated buy, a sale fixed to an earlier date, or a split recorded late reaches the dividends without waiting for the feed.

### 5.4 Received into a broker's fund

**The balance rule.** A fund's balance is its last confirmed figure plus every movement dated after that confirmation: trades' cash and dividends received. It is the rule trades already follow (`private.trade_moves_fund`), applied to the credit date:

- a dividend credited after the fund's last confirmation moves it; one credited on or before does not, since the confirmed figure already includes it;
- a credit date with no time counts at the end of its day in Dubai, so a credit on the day of a confirmation counts as after it (a confirmation made in the app is dated at the start of its day);
- `fund_moved` records what moved and still contributes.

**Every change follows the same rule**, both ways, in one transaction:

- **Fix** (amounts, credit date, or where it was paid): reverse what the old receipt still contributes and apply what the new one contributes, each judged against the account's current confirmation. So a $70 receipt fixed to $68 moves the fund by −$2 if no confirmation has happened since, and by nothing if a later confirmation already holds the real figure. A change of fund reverses one and applies the other.
- **Skip** of a received dividend reverses what it contributes and leaves it `skipped`. **Restore** returns it to `earned`.
- Bank destinations are refused any movement by the function itself.

**Concurrency.** Each save locks the dividend's row, then every fund it touches in id order (`private.lock_funds`), and only then reads the funds' confirmations. A balance check-in on the same fund waits for it, or it waits for the check-in and then reads the new confirmation, so a receipt is counted once either way. Each save states the dividend `version` it was shown; a different version saves nothing. A bot proposal is applied once (`proposal_id` is unique), so a retried "yes" finds it applied. Balance changes are written to `account_balance_events` as trades' are.

### 5.5 The bot

Once a day, in the morning check, each member whose broker-fund dividends have reached their pay date and are still `earned` gets one message for all of them, as a new proposal kind `dividends_received`:

> Dividends due in the dollar broker's fund today:
> ABC: 40 × $0.25 = $10.00, $3.00 withheld, **$7.00**
> XYZ: 10 × $0.50 = $5.00, $1.50 withheld, **$3.50**
> Reply "yes" (or react 👍) once they are in the fund to add $10.50, or "no" to leave them for the app.

A "yes" records every line as received on the pay date (the credit date, editable later in the app) with the expected figures as the received ones and evidence `member`, through `apply_bot_proposal`, in one transaction, at the versions shown. If any row changed in between, nothing is saved and the message is sent again with today's figures. A figure that differs is fixed in the app; the bot does not take corrections. Each dividend is asked about once; an unanswered or declined one stays under "To record" in the app. Switchable in Settings → Telegram like the other nudges.

**Not logged twice.** An income message that reads as a dividend ("ABC dividend credit") is not logged as income: the bot says dividends are recorded on their own and points to the tab, so a dividend never reaches the Life plan as saving.

### 5.6 The app

Every member write goes through a function that checks, at save time, that the member belongs to the household and that the holding, the dividend and the destination account all belong to it. Figures are worked out on the server; the client's are never taken as given. As trades do, `preview_dividend` returns the figures, the movement and any warning, and `save_dividend` saves exactly that at the version previewed. If a confirmation of the fund landed in between and changes the movement, nothing is saved and the form asks to check again.

- **Record**: an earned broker-fund dividend as received (the bot's "yes"), with the credit date and, if different, the received figures.
- **Fix**: units, per share, the event's special part (3.2), withholding, fees, received figures, credit date, or where it was paid. For an Indian dividend, this is where the email's exact figures go, turning presumed into received with evidence `member`.
- **Skip** or **restore**.
- **Add**: a dividend the feed missed, or an older receipt (`source = 'app'`, `units_basis = 'stated'`), with or without an ex-date.
- **Review**: a row flagged `trades_changed` or `feed_changed` shows what changed, and is kept or fixed.

The feed job is the one writer outside this contract: it writes reference data and earned rows as the service role (5.1, 5.2).

## 6. The Dividends tab

A fifth tab on Wealth, after Investments, in the screen's scope (household, or one member). Layout follows the `design-taste-frontend` app-screen checklist; look follows `design/` and Rokda's palette. On a phone, rows are two lines and nothing scrolls sideways.

1. **Headline**: received over the last twelve months (or "since" the start of coverage, when shorter), with the presumed part said ("of which ₹… presumed, not checked"); expected over the next twelve months and its monthly equivalent; and the spending equivalent (4.5). The Indian market and the US market each as a smaller figure beneath, each with the period it covers.
2. **Coming up**: declared dividends with their dates, expected net and destination; earned dividends not yet received; broker-fund ones carry "Record". Then anything needing a member: flagged rows, and events to add by hand.
3. **By month**: received per month for up to 24 months (presumed receipts shaded apart), the next twelve months expected in a lighter shade, and a total per year. A switch shows Earned by ex-date month instead.
4. **By holding**: each holding with dividends found, with its frequency, last ordinary amount per share, received over the last twelve months, expected over the next twelve, yield on value and on cost, and the next date (a day if declared, a month if projected). Sorted by expected. Holdings with none are folded under "No dividends found since <date>", which is the start of that symbol's checked history, kept apart from symbols whose checks are failing. A holding opens its dividends, each with its status, its figures and Fix, Skip or Record.
5. **Where it comes from**: by listing market (Indian, US), each with its withholding, and by sector with an "Unknown" bar, both on expected receipts over the next twelve months, as short bars like the concentration line. When the two markets cover different periods, the section says so.
6. **Freshness and honesty**: per market, the last successful check, any failing symbols and since when; the dates covered; that units before a holding's opening entry are unknown; that a projection is one; that unpaid dividends are not in net worth; and that the Life plan already counts dividends in its return, so this tab is cash flow, not a second return.

States: loading; a load failure that says what did not load (never "None"); no holdings that pay; feeds not yet run; one market failing while the other works.

## 7. Past dividends

A data task, not code, after PR 1 and again every few months: the credit-intimation emails are read, matched to holdings, and shown as a worksheet; nothing is saved before the household's "go". Each becomes a `received` row with evidence `intimation`, source `import`, its stated units, figures, record date as ex-date (the record date and ex-date are the same day under T+1) and credit date, through the same function as Add or Fix, so a matching presumed or earned row is completed rather than duplicated. A rerun finds its rows already there and changes nothing. Nothing about the emails or their figures enters the repository.

## 8. Build order

| PR | What | Done when |
|---|---|---|
| **1. Records and feed** | 3.1–3.5 and their constraints, `earn_dividends()`, 5.3, `dividend-refresh` and its job, the withholding, fee and "paid into" fields in the editors | the event, entitlement and correction rules are settled in tests before ingestion is built; events arrive for both markets from recorded responses; the tests below marked 1 pass |
| **2. Receipts** | 5.4–5.6: the functions, the morning message, the bot's dividend guard, Record / Fix / Skip / Add / Review | the tests below marked 2 pass |
| **3. The tab** | section 6 and `src/lib/dividends.js` | the sums in section 4 and the tab's states are tested; a browser test on a phone covers long holding names, unknown dates, one market failing, and Record and Fix |
| **Data task** | section 7 | the worksheet is approved; imported rows reconcile with it; a rerun changes nothing |
| **Later** | a tax-year panel (withholding per market, for the return), a dividend income goal in Planning, dividend growth per holding | each its own issue |

Required scenarios:

| Scenario | Required result | PR |
|---|---|---|
| An ex-date moves after the event was first fetched | one earned row, on the new date | 1 |
| A dividend added by hand is later found by the feed | one row, linked, flagged if the figures differ | 1 |
| An ordinary and a special dividend on one date | both earned; only the ordinary part projected | 1, 3 |
| A holding sold after the ex-date | its dividend stays earned and comes in | 1 |
| A backdated buy, sale or split | earned rows re-worked; received ones flagged, unchanged | 1 |
| A split after a dividend, with the feed's amount adjusted | the earned row keeps its per-share amount | 1 |
| A holding without an opening entry | no earned rows | 1 |
| An Indian dividend with no evidence | presumed after 30 days, labelled, never moves a balance | 1 |
| Two members confirm the same dividend at once | one receipt, one movement | 2 |
| A confirmation races a balance check-in | the receipt counted exactly once | 2 |
| $70 received, then fixed to $68 | −$2 before a later confirmation; nothing after one | 2 |
| A receipt moved to another fund | both funds reconcile | 2 |
| A received dividend skipped, then restored | its movement reversed, then nothing moves until it is received again | 2 |
| A stale "yes" | nothing saved; the message is sent again | 2 |
| An import is rerun | no duplicate receipt, no movement | data task |
| One market's history covers less than the other's | the tab says so | 3 |

Each PR updates `docs/features.md` and a "Dividends" section in `docs/decisions.md`, and changes the "A broker's cash is an account" bullet that says dividends move a fund without a trade. PR 1 adds `dividend-refresh`'s tests to the bot test command in `CLAUDE.md`. New tables get RLS cases in `rls-policies.test.sql`; new constraints and triggers get cases in `migration-behaviour.test.sql`.

## 9. What could go wrong, and what stops it

| Risk | What stops it |
|---|---|
| A dividend counted twice in a fund | the balance rule (5.4), applied to every save, under locks, at a checked version |
| Counted twice in the Life plan | dividends are not income transactions, and the bot does not log one as income |
| Wrong units on an ex-date | units from the trade replay, the exchange's day for timed trades, re-worked when trades change; nothing before an opening entry |
| A feed misreads, moves or withdraws a dividend | only events listed after their ex-date are earned; frozen per-share figures; changes flagged, never applied to received rows; every broker-fund figure seen before a fund moves |
| A presumed Indian receipt never arrived | labelled "presumed, not checked" everywhere it counts; the import or a fix checks it; Skip removes it |
| A one-off inflates the forecast | special parts are never extrapolated, and can be set by hand |
| Yahoo (unofficial) changes or blocks | Indian events stop, the tab says since when, dividends can be added by hand |
| Alpha Vantage's allowance | at most five calls a run, a fifth of the free allowance; a refusal is a failure like any other |
| The wrong withholding rate or fees | per holding, editable; each dividend's figures are editable and kept as received |

Not changed here: a balance confirmed in the app with a past date replaces the balance, so a trade dated between that date and the moment of confirming is lost from it. That affects trades today and is its own issue.

## 10. Out of scope

Reinvested dividends (DRIP), tax owed in the UAE (none), reclaiming withheld tax, the household's final tax position, mutual-fund distributions, interest on cash, payment dates from company websites, analyst forecasts, and estimating dividends from before a holding's opening entry.
