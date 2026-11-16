# Wealth, the revamp's phase 5: design

Status: approved 16 November 2026, with the four decisions as recommended
(the app's six ranges, By month over 12 months back and 12 ahead, a tax
year's drawer holding everything the app shows today, a balance old at 45
days).

The prototype (`design/prototype/js/screens-wealth.js`, `css/wealth.css`) is
the target, as it was for Money. Each tab is built like its prototype screen
from the shared kit; where the app knows something the prototype doesn't (a
longer chart range, a sector concentration, a tax year's statements and
refund), the app's behaviour stays and is drawn in the prototype's style. The
UI review's Wealth items (N5, N6, S-networth, S-accounts, S-investments,
S-dividends, H6, H10) are what the prototype already answers.

## What changes

| | Today | After |
|---|---|---|
| Wealth's tabs | Net worth, Accounts, Investments, Dividends | Net worth, Investments, Dividends |
| Accounts | Its own tab: card boxes, then the accounts by type | The ledger on Net worth: Assets and Liabilities tables. An account opens a drawer |
| A credit card | A box with this cycle's spending, closing and due dates | A Liabilities row ("{x} this cycle · closes in {n}d", a limit-used bar) that opens a card view: This cycle, Statements, Details |
| Net worth | Hero, composition, Assets and Liabilities lists, a Monthly change list, How it's grown at the bottom | The hero card beside How it has grown; Assets beside Liabilities and What the assets are. Monthly change goes (the chart and its table say it) |
| Investments | Value, the chart, two Allocation boxes, the concentration line, the holdings table, footer notes | A five-figure strip; Value over time beside Allocation; the Holdings table; notes behind a chip or an (i) |
| Holding editor | One long drawer | Details, Trades and Dividends tabs |
| Dividends | Eight stacked sections, Tax years at the bottom | Income and Tax years as two views. Income: Needs you (only when something waits), a figure strip, By month beside Coming up, By holding grouped by market |

## The frame

- Each tab's tools sit in the page header, as on Money (`ToolsSlot`, moved
  out of `screens/money` so both pages share it). Net worth: By type / By
  owner and + Account. Investments: All / Global / India / Commodities, the
  "Prices {time}" stamp with a stale chip, Refresh prices and + Holding.
  Dividends: Income / Tax years and the Feed chip.
- Old addresses keep working: `?tab=accounts` opens Net worth;
  `?tab=statements` already opens Month end.
- **An account has an address**: `/wealth?account={id}` opens its drawer (a
  card on This cycle; `&view=statements` or `details`). Month end's card
  name and Confirm balance, To do's Confirm balance and Open card, and
  Needs attention's card and balance items open the account itself, not the
  list.
- Everything stays scoped as today: in one person's view their own and
  shared rows, shared at half.

## Net worth

- **Hero card**: net worth with a Provisional chip while an account isn't
  confirmed (and one warning row naming them, with Confirm); "▲ {x} this
  month · {n}% in 12 months"; then Assets, Liabilities and Runway (months of
  spending the cash accounts cover; the app's `runwaySummary`, a dash until
  two months are complete).
- **How it has grown**: the kit's trend line of month-end net worth and
  today. A month not closed is drawn hollow and the card offers "Close
  {month}" (to Month end). "History as a table" folds beneath: Today (live),
  then each month with its change.
- **Assets**, a table grouped By type (Current accounts, Savings, Cash,
  Deposits and broker funds) or By owner (Shared, then each person), with a
  subtotal per group. A row: the name with its type, foreign amount or a
  deposit's maturity beneath; the owner; a status (Not confirmed with
  Confirm, or "Checked {n}d ago" once a balance is old); the amount, or "Not
  counted". Then one Investments row ({n} holdings, a stale chip) opening
  Investments, and Total assets.
- **Liabilities**: cards and loans; a card shows "{x} this cycle · closes in
  {n}d" and a limit-used bar; Total liabilities; "Closed ({n})" folds the
  closed accounts, each with Reopen.
- **What the assets are**: the kit's stacked bar, "{x} in all".

### The account drawer

- **Details**, for every account: the editor's fields as today (balance,
  "Confirm this balance" with its date, name, type, currency, owner, a card's
  limit, statement day and due day, a deposit's terms), its last confirmed
  balance, and Close account (two presses; one never used is deleted, as
  today) beside Cancel and Save. One "+ Account": the type is chosen here.
- **A credit card** opens on **This cycle**: Owed (when checked), Spent this
  cycle ({n} transactions), Limit used with its bar; the cycle's dates and
  "closes in {n}d"; Payment due (the latest statement's, while it's ahead,
  else the running cycle's); the cycle's transactions, each opening its
  editor; and "All transactions on this card" (Activity, the card, all
  dates). **Statements** lists the card's statements as Month end's table
  reads them, with "Check statements in Month end".

## Investments

- **Strip**: Value; Invested; Profit not yet taken (and its share of cost);
  Profit on sales this year (and how many sales, or None); Change today.
- **Value over time**, the trend line with the range buttons (decision 1)
  and a "Partial history" chip whose popover holds today's caveats, and a
  readout of the change over the range.
- **Allocation**: the stacked bar by asset class; beneath it the largest
  concentration against the household's cap (today's rule, a sector or a
  single holding) as a bar with the cap's tick, "Above / Within {n}% cap",
  an "{n} untagged" chip opening that holding, and Change cap in a pop-over.
- **Holdings**: Holding (Stale price and Untagged chips, class · sector
  beneath), Owner, Units, Avg price and Price now (currency as a grey
  suffix; "manual" where there is no feed), Invested, Value (share of total
  beneath), Profit (share of cost beneath), Today. "Sold ({n})" folds the
  sold ones with what each made.
- A failed price refresh is the kit's banner with Try again. "About
  refreshing", the oldest valuation and the live-feed count move into the
  Prices stamp's popover.
- **The holding drawer** gets three tabs: Details (today's fields, the
  pricing paragraphs behind an (i)), Trades and Dividends (today's
  sections). Delete stays in Details, with today's guards.

## Dividends

- **Header**: Income / Tax years, and "Feed: checked {date}", amber when a
  check is failing and naming the symbol, its popover each market's last
  check.
- **Needs you**: the one boxed card at the top, only while something waits,
  each question with its answers.
- **Strip**: Received · 12 months ("Received since {date}" while the record
  is shorter, as today; a "{x} presumed" chip; an (i) with what the figures
  leave out), Expected · 12 months (with "+{n}% on the last 12"), A month
  ("about {x}"), and Of spending.
- **By month**: bars, received solid (presumed paler) and expected outlined,
  today marked, with Received / Earned; the readout gives this year so far
  and next year expected. The kit gains this chart. Span: decision 2.
- **Coming up**, beside it: date, holding, its state and amount in its own
  currency, Record on an earned one. A row's other actions (Fix, Skip,
  Restore, Keep as it is, It's this one, Part was a one-off) sit under "⋯".
- **By holding**: a table grouped by market (the group row gives the
  market's withholding and its Received and Expected), columns Holding,
  Sector, Rhythm, Last, Received, Expected, Yield, On cost, Next; a row opens
  the holding on its Dividends tab. "Not paying or not checked ({n})" folds
  the rest with the reason. A market with no opening entry is one warning
  row with Add opening trade.
- "Where it comes from" and "How fresh this is" go: the market grouping and
  the Feed chip say them.
- **Tax years**: one table (Tax year with a Provisional chip, Member,
  Dividends, Tax withheld, Against AIS and 26AS, Return, Refund); a year
  opens a drawer (decision 3).

## Figures the prototype shows that the app doesn't compute

| Figure | Proposal |
|---|---|
| Expected's "+{n}% on the last 12" | Add, with a test |
| A month, "about {x}" | Expected ÷ 12; add, with a test |
| Runway on Net worth | `runwaySummary` already works it out and nothing shows it; use it |

Everything else on the three screens is already worked out by the app.

## Decisions

1. **Investments' ranges.** The prototype has 1M, 3M, 6M; the app has 1W,
   1M, 3M, 6M, 1Y, 5Y. Recommended: keep the app's six.
2. **By month's span.** The prototype shows the last 12 months and the next
   12; the app shows up to 24 back, from where the record starts, and 12
   ahead. Recommended: the prototype's 12 and 12, matching the strip's "12
   months"; older months stay in Activity.
3. **A tax year's drawer.** The prototype's holds four figures and the
   return fields; the app's tax year also checks each share against both
   statements and records what happened to the refund. Recommended: the
   table as the prototype, its drawer holding everything the app shows today.
4. **When a balance reads "Checked {n}d ago".** The prototype says it after
   30 days; the app calls a balance old at 45 (Overview's To do and Month
   end's strip). Recommended: 45, so the three agree.

## Pull requests

| PR | Holds |
|---|---|
| 5a | Net worth with the accounts ledger, the account drawer and its card view; the Accounts tab retired; `?account=` addresses |
| 5b | Investments and the holding drawer's tabs |
| 5c | Dividends: Income and Tax years, and the kit's bar chart |

Each is built test first, checked on desktop (phones keep working but
aren't planned for), reviewed fresh, and merged on the word.

## Not in this phase

- New data or migrations: none are needed.
- The Data health list (review R3): the Provisional chip keeps today's
  warning row.
- Planning, Settings and the bot (phases 6 to 8).
