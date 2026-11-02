# Dividends: what the shares pay, after tax, as passive income

Design for SHR-366. Status: draft for the household's review, 2 November 2026. This repository is public: every figure, ticker and account below is a round example ("ABC", "the dollar broker's fund", "the Indian bank account"), never the household's.

## 1. What this is

Rokda knows each holding, its units from the trades and its price, but nothing about what the shares pay. The household wants to see dividends as passive income: what has been earned, what is coming, which holdings pay and how often, and, over the years, whether dividends become a real share of what the household lives on.

**Done when:**

- every dividend a holding earns after its fresh start is recorded on its ex-dividend date, at the units actually held, with gross, tax withheld and net, without anyone typing it;
- a dividend paid into a broker's fund moves that fund once a member has confirmed it, so the fund's balance stays right between check-ins;
- Wealth has a Dividends tab: earned so far, the monthly average, the next twelve months projected, the share of monthly spending it covers, what is coming up, a chart by month, each holding's payments and yield, and India against the US;
- nothing is counted twice: not in a fund's balance, and not in the Life plan.

## 2. What the household decided (2 November 2026)

1. **A dividend is recorded, not only estimated.** Where the money lands is part of the record.
2. **Dividends are their own records, not income transactions.** Recorded income feeds the Life plan's monthly saving (`forecastInputs`), and the plan's return already includes dividends, so an income transaction would count every dividend twice. Transactions also never move a balance; a dividend paid into a broker's fund must, as a trade does.
3. **Earned on the ex-date, paid on the pay date.** The units held the day before the ex-date fix the entitlement, so a dividend counts as earned that day, from the trades, with no confirmation. Paying it is a separate step.
4. **Only money into a broker's fund is confirmed.** The dollar broker pays US dividends into its fund (a Broker funds account), and a "yes" moves the fund. Indian companies pay straight into the bank account linked to the demat account; a bank balance is a manual snapshot confirmed at the monthly check-in, so nothing moves and nothing is asked.
5. **The Indian bank account is an account in Rokda** (added on 2 November 2026 as a rupee bank account), so the money counts in net worth and each Indian dividend names where it went.
6. **Free data, checked live:**
   - Alpha Vantage's `DIVIDENDS` (free key: 25 requests a day, 5 a minute) returns ex-date, declaration date, record date, **payment date** and amount, including dividends declared but not yet paid. It is the US source.
   - Yahoo's chart endpoint with `events=div` returns ex-date and amount for NSE symbols (checked against a company's own credit intimation: same record date, same amount per share). It is the Indian source. No free source gives an Indian payment date.
   - Twelve Data (which prices the US holdings) puts dividends on a paid plan; EODHD's demo is refused; Nasdaq's covers Nasdaq-listed symbols only. None is used.
7. **Tax is per holding.** US shares at the dollar broker: 30% (no US–UAE treaty). Indian shares held as a non-resident without a Tax Residency Certificate: 20.8% (20% plus 4% cess), which is what the companies' own intimations show. A US-listed share of a foreign company (an ADR) is taxed by its home country instead, so the rate is set on the holding, with a default by asset class.
8. **History before the fresh start is imported, not estimated.** Units before each holding's opening entry are unknown. Past Indian dividends can be imported from the companies' credit-intimation emails, which state units, gross, tax, net and the credit date; that is a data task after the first PR, done like the October statements (a worksheet first, nothing saved before the household's "go"). Past US dividends are not estimated.
9. **Bonus issues need nothing new.** A bonus issue changes units, not cash; the feed reports it as a split, and the existing large-move question already asks about it.

## 3. What is stored

### 3.1 `dividend_events`: what each share pays

Reference data from the feeds, the same for every household, like `fx_rate_history`.

| Column | Meaning |
|---|---|
| `symbol` | the holding's `price_symbol` (`ABC` for a US share, `ABC.NS` for an Indian one) |
| `ex_date` | the ex-dividend date, in the exchange's own calendar |
| `amount` | numeric(18,6), per share, in `currency` |
| `currency` | the share's currency (`USD`, `INR`) |
| `pay_date`, `record_date`, `declared_on` | where the source gives them (Alpha Vantage does; Yahoo gives none) |
| `source` | `alphavantage`, `yahoo` or `manual` |
| `fetched_at` | when the feed last wrote it |

Unique `(symbol, ex_date)`. A later fetch updates the amount and dates (a declared figure can be corrected) but never deletes a row. RLS: any signed-in member reads; only the service role writes. A household's own manual dividend (3.2) does not need an event.

### 3.2 `holding_dividends`: what the household earned

One row per holding per ex-date. Written only by the dividend functions (section 5); members of the household read their own.

| Column | Meaning |
|---|---|
| `id`, `household_id`, `holding_id` | `(household_id, holding_id)` references `holdings (household_id, id)` |
| `ex_date`, `pay_date` | copied from the event, or typed; `pay_date` may be null |
| `per_share` | numeric(18,6), in the holding's currency |
| `units` | numeric(20,8), > 0: units held on the ex-date |
| `units_basis` | `trades` (from the replay), `current` (a holding with no trades: its units today, and the screen says so) or `stated` (typed or imported) |
| `gross`, `tax`, `net` | numeric(16,4); `gross = units × per_share` unless stated; `net = gross − tax`; all ≥ 0 |
| `tax_pct` | the rate the tax was worked at, kept for the record |
| `special` | true when the payment is a one-off (section 4.3); left out of projections |
| `status` | `earned`, `paid` or `skipped` |
| `paid_on`, `paid_on_estimated` | the day it landed; estimated when no pay date was known (section 5.3) |
| `paid_into_account_id` | where the money went |
| `fund_moved` | numeric(16,4), what actually moved the fund (0 when nothing moved) |
| `source` | `feed`, `app`, `bot` or `import` |
| `proposal_id` | the bot proposal that paid it; unique when set |
| `note`, `created_at`, `updated_at`, `updated_by` | |

Constraints (each gets a case in `migration-behaviour.test.sql`):

- unique `(holding_id, ex_date)`;
- `net = gross − tax` and `tax ≤ gross`;
- `paid_on` is set exactly when `status = 'paid'`;
- a `feed` row's ex-date is after its holding's opening entry (or, for a holding with no trades, after the holding was created); only `import` and `app` rows may be dated earlier;
- `paid_into_account_id` belongs to the household.

### 3.3 Changes to `holdings` and `accounts`

- `holdings.dividend_tax_pct` numeric(5,2), 0–100. Filled by the migration from the asset class (Indian equity 20.8, US and international equity 30, others null) and by a trigger for new holdings; editable in the holding editor ("Tax withheld on dividends").
- `accounts.dividends_into_account_id`, on a Broker funds account only: where its holdings' dividends are paid. Null means the fund itself. The rupee broker's fund points at the Indian bank account; the dollar broker's fund stays null. Editable in the account editor for a Broker funds account.
- A holding's dividends go where its fund says. A holding with no fund has no destination: its dividends are earned and shown, and the screen says where they were paid is not set.

### 3.4 `dividend_feed_state`: what the feed last checked

`symbol`, `provider`, `checked_at`, `fail_count`, `last_error`. Service role only; the tab reads a summary through a function for its freshness line.

## 4. The sums

All pure logic lives in `src/lib/dividends.js` with `dividends.test.js` beside it. The database never projects; the app never decides what was earned.

### 4.1 Units on the ex-date

The units after every entry traded before the ex-date, from the same replay the trades use (`private.holding_entries` and `private.replay_entries`). An entry's market day is its `traded_at` in the exchange's time zone when set (a US trade confirmed after midnight in Dubai belongs to the previous New York day), otherwise its `trade_date`. A trade on the ex-date itself does not count: the buyer on the ex-date is not paid. If the units are zero, no row is made.

### 4.2 Converting to dirhams

Dollars at the peg (3.6725). Rupees at the household's rate on the ex-date from `fx_rate_history`, or the household's stored rate when that day has none, the same rule "Profit on sales" uses. A rupee figure with no rate at all is unknown, never guessed.

### 4.3 Special dividends and frequency

- **Frequency**: regular payments over the last 24 months, halved: about 1 a year is yearly, 2 half-yearly, 4 quarterly, 12 monthly; anything else is "irregular". Fewer than two payments is "too new to say".
- **Special**: a payment more than twice the median of that share's other payments in the last 24 months, once it has at least three. Specials count in what was earned and are flagged, but are left out of projections and frequency.

### 4.4 Projection, labelled as one

For each holding still held:

1. dividends already declared (an event with an ex-date from today on) at today's units;
2. then, for each regular payment of the last twelve months, the same amount per share one year later, unless a declared dividend falls within 45 days of that date (it replaces it);
3. less the holding's tax rate.

The screen calls it "if each pays what it paid last year". Yield on value is the next twelve months' gross per share over today's price; yield on cost is the same over the holding's average price.

### 4.5 What it covers

"Covers X% of monthly spending" is the projected next-twelve-months net over twelve, against the average monthly spending of the last twelve closed months (the figure the Life plan uses, `closedMonths`), in the same scope as the screen. With fewer than three closed months, it is not shown.

## 5. Recording

### 5.1 The feed: `dividend-refresh`

A new Edge Function, separate from `price-refresh` so a dividend failure never stops prices. A new job, `daily-dividend-refresh`, runs it at 01:30 UTC, before the morning check, with the vault's scheduler secret (the same caller rules as `fd-accrual`).

"Held" below means held now or at any time in the last 90 days, so a share sold just after its ex-date still has its dividend found.

1. **Indian symbols** (held, priced by Yahoo): Yahoo's chart endpoint with `events=div`, two years the first time a symbol is seen, three months after that. One call per symbol, as the price feed already makes.
2. **US symbols** (held, US or international equity): Alpha Vantage's `DIVIDENDS`, five symbols a run, the longest-unchecked first, so each is checked every few days within the free allowance with no waiting between calls. US dividends are declared weeks ahead, so a few days' gap misses nothing. Without an `ALPHAVANTAGE_API_KEY` secret the US side is skipped and the freshness line says so.
3. Upsert into `dividend_events`; record the check in `dividend_feed_state`.
4. Call `public.earn_dividends()` (5.2).

A provider failure leaves the last events in place, adds to `fail_count`, and the tab says how long ago each side was last checked.

### 5.2 Earned: `earn_dividends()`

Service role only, idempotent. For every event whose ex-date has passed and every holding with that symbol, it makes the `holding_dividends` row if there is none: units from 4.1, gross, tax at the holding's rate, net, `special` from 4.3, `paid_into_account_id` from 3.3, status `earned`, source `feed`. Once a row exists, the feed changes it only if it is still `earned` and no member has fixed it (`updated_by` is null): then a corrected amount or a newly known pay date is carried into it. A member's fix, and every paid or skipped row, stands.

### 5.3 Paid

- **Into a broker's fund**: the bot asks (5.4), or a member records it in the app. On a "yes" the row becomes `paid` on the pay date and the fund moves by the net, under the trades' rule (`private.trade_moves_fund` on the pay date): a payment dated before the fund's balance was last confirmed does not move it, since the confirmed figure already includes it. `fund_moved` records what moved, and a fix or delete reverses exactly that under the same rule. The fund's balance change is kept in `account_balance_events` like a trade's.
- **Into a bank account, or nowhere set**: nothing moves and nothing is asked. `earn_dividends()` marks the row `paid` on its pay date, or, with no pay date known, 30 days after the ex-date (an Indian company must pay within 30 days of declaring, and declares before the record date), with `paid_on_estimated` set. Until then it shows under Coming up.
- **Skipped**: a member can mark a dividend as not received (a cancelled payment, a share sold before the record date that the trades don't show); it leaves every total and its fund movement, if any, is reversed.

### 5.4 The bot

Once a day, in the morning check, each member whose broker-fund dividends reached their pay date gets one message for all of them, as a new proposal kind `dividends_paid`:

> Dividends paid into the dollar broker's fund today:
> ABC: 40 × $0.25 = $10.00, $3.00 tax, **$7.00**
> XYZ: 10 × $0.50 = $5.00, $1.50 tax, **$3.50**
> Reply "yes" (or react 👍) to add $10.50 to the fund, or "no" to leave them for the app.

A "yes" applies every line in one transaction through `apply_bot_proposal`, each at the row's `updated_at` when shown: if any row changed in between, nothing is saved and the message is sent again with today's figures. A figure that is wrong is fixed in the app; the bot does not take corrections. Each payment is asked about once; an unanswered or declined one stays under "To record" in the app. Switchable in Settings → Telegram like the other nudges.

### 5.5 The app

Every write goes through a database function that checks the member belongs to the household and returns the figures it saved (`preview_dividend` then `save_dividend`, as trades do: what was previewed is what is saved):

- **Record** an earned broker-fund dividend as paid (the bot's "yes", from the app);
- **Fix** units, per share, tax, net, pay date or where it was paid (for an Indian payment, to the exact figures in the company's email);
- **Skip** or **restore**;
- **Add** a dividend the feed missed, or an older one (`source = 'app'`, `units_basis = 'stated'`).

## 6. The Dividends tab

A fifth tab on Wealth, after Investments, in the screen's scope (household, or one member). Layout follows the `design-taste-frontend` app-screen checklist; look follows `design/` and Rokda's palette. On a phone, rows are two lines and the chart scrolls with the page, not sideways.

1. **Headline**: earned in the last twelve months (net, in dirhams), the monthly average, the next twelve months projected (labelled), and "covers X% of monthly spending". India and the US each as a smaller figure beneath.
2. **Coming up**: declared dividends with their dates, the projected net and where they will be paid; then earned dividends not yet paid. Broker-fund ones not confirmed carry "Record".
3. **By month**: net earned per month for up to 24 months, with the next twelve projected in a lighter shade; a total per year beside it.
4. **By holding**: each paying holding with its frequency, last amount per share, earned in the last twelve months, projected, yield on value and on cost, and its next date; sorted by projected net. Holdings that paid nothing in two years are folded under "Pay no dividend" with a count. A holding opens its list of dividends, each with Fix and Skip.
5. **Where it comes from**: India against the US (each with its tax withheld), and by sector, as short bars like the concentration line.
6. **Freshness and honesty**: when each feed last checked; dividends on holdings with no trades say their units are today's; a projection says it is one; and a line that the Life plan already counts dividends in its return, so this tab is cash flow, not a second return.

States: loading, a load failure that says what did not load (never "None"), no dividends yet, and a household with no paying holdings.

## 7. Build order

| PR | What | Done when |
|---|---|---|
| **1. Database and feed** | 3.1–3.4, `earn_dividends()`, `dividend-refresh`, the job, the tax and "paid into" fields in the editors | events arrive for both markets in tests against recorded responses; earned rows have the right units across trades before, on and after an ex-date; RLS and behaviour tests pass |
| **2. Paid** | 5.3–5.5: the functions, the morning message, Record / Fix / Skip / Add in the app | a broker-fund payment moves the fund once, and not at all when dated before the last confirmation; a bank payment never moves anything and is marked paid on time; a stale "yes" saves nothing |
| **3. The tab** | section 6 and `src/lib/dividends.js` | the sums in 4.3–4.5 are tested; the tab's states are tested; one browser test shows the tab on a phone |
| **Data task** | importing past Indian dividends from the companies' emails | the worksheet is approved and the imported rows reconcile with it |
| **Later** | a tax-year panel (tax withheld per country, for the return), a dividend income goal in Planning, dividend growth per holding | each its own issue |

Each PR updates `docs/features.md` and adds to a "Dividends" section in `docs/decisions.md`, and changes the "A broker's cash is an account" bullet that says dividends move a fund without a trade. PR 1 adds the new function's tests to the bot test command in `CLAUDE.md`.

## 8. What could go wrong, and what stops it

| Risk | What stops it |
|---|---|
| A dividend counted twice in net worth | a fund moves only on a confirmed broker-fund payment, under the trades' "after the last confirmation" rule; bank balances are never moved |
| Counted twice in the Life plan | dividends are not income transactions, so the plan's saving never includes them |
| Wrong units on the ex-date | units come from the trade replay, with the exchange's day for timed trades; holdings without trades are labelled |
| A feed misreads an amount | the bot shows every figure before a fund moves; any row can be fixed; the feed never overwrites a fixed row |
| Yahoo (unofficial) changes or blocks | Indian rows stop arriving, the freshness line says since when, and dividends can be added by hand |
| Alpha Vantage's free allowance | five calls a day, a fifth of the allowance; a refusal is a failure like any other |
| A one-off inflates the forecast | specials are flagged and left out of projections |
| The wrong tax rate | per holding, editable; each payment's tax is editable and kept as recorded |

## 9. Out of scope

Reinvested dividends (DRIP), dividend tax owed in the UAE (none), reclaiming withheld tax, mutual-fund distributions, interest on cash, analyst forecasts of future dividends, and estimating dividends from before a holding's fresh start.
