# Overview — design

## Why

Overview is the screen opened most. Its title asks a question ("3 things
need a decision"), but the decisions sit beside a chart, net worth is below
the first screen, "Next 30 days" is two half-empty boxes, and the page runs
to about 1.7 screens (revamp audit, November 2026).

## The screen's one question

"What needs me today, and how is the month going?" The decisions come first,
the month's figures beside them, everything else after.

## Layout (desktop, 1440 × 900)

```
3 things need a decision                         [MTD QTD YTD]   Refresh
Saturday 14 November · Data quality: 2 of 4 checks need a look ▾

Income      Net spend     Income less spending   Savings rate   Net worth
{x}         {x}           +{x}                   60%            {x}
new         new           new                                   +{x} this month

Needs attention (3)                          Next 30 days
Unknown · 13 Nov · −{x}  [Categorise…] [✓]   20 Nov  Streaming    −{x}  autopay
Streaming: debit not confirmed   [Open]      28 Nov  Rent      −{x}     no autopay
Groceries running high           [Open]      Committed {x} · Recurring →

Last 6 months (income and net spend)         Spending by category · this month
▁ ▁ ▁ ▂ ▂ █▆                                 Rent {x} · Groceries {x} · …

Recent activity                              Accounts
…                                            …
```

1. **The decisions first.** Needs attention moves to the left of the first
   row under the figures, where the title points. Next 30 days sits beside
   it as a short list (date, name, amount, autopay or not) instead of two
   large boxes.
2. **Net worth joins the figures** as a fifth figure, with its change this
   month. The separate net worth block (assets, liabilities, runway) goes;
   Wealth → Net worth has all of it, one click away.
3. **The chart is half the height,** and months with no records take a thin
   slot instead of a full one.
4. **Data quality moves up** beside the date, as the one status line it is,
   still opening its list in place.
5. **A change from nothing says "new"** in grey, instead of "▲ {x} vs the
   same days last month" in colour.
6. **What stays:** spending by category, recent activity and accounts, at the
   foot, as now. Every figure and link the screen has today is kept or one
   click away.

Target: the figures, the decisions, the next 30 days and the chart on the
first screen; the page about 1.2 screens long instead of 1.7.

## Limits

- No figure changes how it is worked out; only where it sits.
- Phone: the same order, one column (desktop first; the phone layout is
  kept working, not redesigned).
- Rokda's palette and type stay as they are.

## Left to the builder

Exact spacing, the chart's height, and the tests.
