# Overview, the cockpit — design (revamp phase 3)

## Why

The household adopted the independent review and its prototype as the plan
(SHR-385). Overview is the screen opened most and the first rebuilt from the
shared kit. The prototype's Overview answers, on one screen: what needs
doing, how the month is going, what the household is worth, and whether the
plan holds (review S-overview-1 to 12). The reference is
`design/prototype/` → Overview.

## Layout (desktop, 1440 × 900)

```
Saturday 14 Nov  [Data: 2 to check]           [Month|Quarter|Year] [+ Transaction] ⟳ 14:32
4 things need a decision
┌ Net worth ─────────────── Net worth → ┐ ┌ This month ──────── 22 transactions · Budget → ┐
│ AED 300,000  [Provisional]            │ │ Income        Spent (i)       Saved             │
│ ▲ 10,000 this month · 12 months       │ │ 20,000        15,000          5,000             │
│ [net worth trend line]                │ │ +10,000 expected 28 Nov       25% of income     │
│                                       │ │ Budget · 12,000 of 16,000   75% spent · 47% gone│
│                                       │ │ ━━━━━━━━━━━━━━━━━━━━━|━━━━━━━━━━━              │
└───────────────────────────────────────┘ └─────────────────────────────────────────────────┘
┌ To do ───────────────────────── 6 open ┐ ┌ Next 30 days ─────────────────── Recurring → ┐
│ Today                                  │ │ ●────●───◉────────────●────  (dated strip)   │
│ ● Unknown · uncategorised · −95 [Cat ▾]│ │ 20 Nov  Streaming     autopay          −50   │
│ ● Gym · late, was due 10 Nov [Mark paid]│ │ 28 Nov  Rent          manual        −5,000   │
│ Month end                              │ │ Committed 5,050 · cash on hand 40,000 [Covered]│
│ ● Card statement · to check   [Check]  │ └──────────────────────────────────────────────┘
│ ● October · not closed  [Close month]  │
│ Show all 9                             │
└────────────────────────────────────────┘
┌ Income and spending · 6 months ─ Activity → ┐ ┌ Where it went (i) ──────── Budget → ┐
│ [paired columns: income, spent; saved line] │ │ Rent      ━━━━━━━━━━━━|   5,000     │
│ Income · Spent · Saved                      │ │ Groceries ━━━━|━          1,500     │
└─────────────────────────────────────────────┘ │ What changed                        │
                                                │ [+25% vs usual] Groceries · 4 txns →│
                                                └─────────────────────────────────────┘
┌ Plan ──────────────────────────────────────────────────────────────────────────────────┐
│ Stop working →      │ Goals · next 3 years → │ Debts →              │ Cash reserve →    │
│ 2046                │ 20,000 of 60,000       │ −40,000              │ 6.2 months        │
│ [Baseline: …][Cons.]│ ━━━━━━░░░░░░░░         │ Clears Mar 2029      │ [Covers kept goals]│
└────────────────────────────────────────────────────────────────────────────────────────┘
┌ Recent ──────────────────────────────────────────────────────────────── Activity → ┐
│ Date    Merchant              Category        Account           Amount            │
└───────────────────────────────────────────────────────────────────────────────────┘
```

(Figures above are placeholders.)

## Every figure, and where it comes from

Nothing on this screen is a new calculation. Each figure is already worked
out by the app; the cockpit shows it here, drawn with the kit.

| Figure | Worked out today by | Note |
|---|---|---|
| Net worth, its change this month, Provisional / Incomplete | Overview (`overviewMath`) | Warnings become chips beside the figure |
| Net worth trend | Month-close snapshots plus today's figure (as Wealth → Net worth) | Draws as many months as have been closed, up to 12 |
| Income, Spent, Saved, rate, "+X expected" | Overview's period figures | "Net spend" is named "Spent"; "Income less spending" is "Saved" |
| Budget track: spent of budget, pace tick | Budget (`lib/budget.js`) | Month view only, as in the prototype |
| To do | Needs attention (`lib/attention.js`), statements to check (`lib/statements.js`), dividends' Needs you (`lib/dividendSummary.js`), Plan's decisions (goals short of cash) | One list; see below |
| Next 30 days: dates, status, amounts | Overview's Next 30 days and Needs attention (late, not confirmed) | Drawn as a dated strip plus the next five rows |
| Committed · cash on hand · Covered / Short | Cash cover (`lib/cashCover.js`), the bot's morning check | Over 30 days here; the bot's line keeps its 7 |
| Six months of income, spent and saved | Overview's chart columns | Columns for income and spent, a line for saved, an axis |
| Where it went, with the usual month | Spending by category, and Insights' average (`lib/insights.js`) | Top five, gross, as today; the tick is Insights' average |
| What changed | Insights' notable moves | At most three; each opens its transactions |
| Plan strip: stop year and verdicts, goals, debts, cash reserve | Planning → Plan (`PlanSummary`, `lib/monthlyCheck.js`) | The same figures as the Plan tab |
| Recent | Overview's recent activity | Five rows as a table |
| Data: N to check | Overview's data quality checks | A chip that opens the same list in place |

## To do, the one list

- **Today:** a record flagged for review (categorise or mark reviewed in
  place, as now); a bill late or an autopay not confirmed (**Mark paid** opens the
  transaction editor filled from the bill, as Recurring's does); a balance
  not confirmed (**Confirm balance**); a card payment due; a holding not
  priced; a dividend question (**Answer**, to Dividends).
- **Month end:** a card statement to check or not matching (**Check**); a
  month not closed (**Close month**); a backup due or failed (**Record
  backup**).
- **Planning:** a goal short of cash (**Open goal**); a yearly check due
  (**Open notes**).
- Six rows show, then "Show all N". A button is named for what it does;
  where the action has its own place (a statement, a dividend, a goal), the
  button opens that exact place.
- "Groceries running high" leaves To do: it is a finding, not a decision,
  and shows under What changed.
- The title counts To do: "6 things need a decision", or "All clear".

## What leaves Overview

- **The change against the same days last period** under each figure; the
  six-month chart carries the trend.
- **Runway**; the Plan strip's cash reserve says the same thing in months
  of spending.
- **The Accounts list**: Wealth → Net worth has it, one click away.
- **The gross spending total and "Before refunds…"**: behind (i) on Where it
  went.
- **The data quality section**: a chip beside the date opens the same list.

## Header

The kicker (date, Data chip), the title, then on the right: Month / Quarter /
Year, **+ Transaction** (the transaction editor, opened here) and refresh.

## Data

Overview already reads accounts, transactions, recurring, budgets, the
Inbox, snapshots, holdings, dividends, statements and backups. The Plan strip
also needs Planning's own reads (goals, debts, the life plan's inputs), so
Overview reads those too; if they fail, the strip says so with Try again and
the rest of the screen stands.

## Charts (new in the kit)

- **Trend line** with a faint area, an axis and a hover readout (net worth).
- **Paired columns with a line** (six months).
- **Dated strip**: today at the left, a mark per bill or pay day, sized by
  amount, coloured by status.

Each has a three-line axis where it has one, a readout on hover, and is
sized to the data it has (review P21).

## Limits

- Desktop first; the phone keeps a single column.
- Every warning, error and status today's Overview shows is still shown.
- No figure changes how it is worked out.

## Left to the builder

Exact spacing, the order inside each To do group, and the tests.
