# Planning, the revamp's phase 6: design

Status: approved 17 November 2026, with the five decisions as recommended,
and trimmed to the prototype: what the old screens add beyond it goes,
unless it is in use or worth keeping (below).

The prototype (`design/prototype/js/screens-planning.js`, `css/planning.css`)
is the target, as it was for Money and Wealth. Each tab is built like its
prototype screen from the shared kit. The UI review's Planning items (N7, N9,
S-plan-1, S-life, S-goals, S-debt, S-notes) are what the prototype already
answers.

## What changes

| | Today | After |
|---|---|---|
| Planning's tabs | Plan, Life plan, Goals, Debt payoff, Notes | Plan, Goals & debts, Notes |
| Plan (the summary) | Stop working, Goals and Debt cards, a Monthly check, What needs a decision | Gone (decision 1). Overview's Plan strip and To do took its place in phase 3 |
| Life plan | Basis notes, an assumptions bar, the stop year as a headline paragraph, four figures, levers as a sentence, the chart, two stress sections, goals with tick boxes, an Assumptions paragraph | Becomes **Plan**: a one-line strip, then three bands: When can we stop?, What would it take?, What could go wrong? |
| Goals | Sections of two-line rows, each with a sentence saying why | **Goals & debts**: one table card per group, columns as the prototype |
| Debt payoff | Its own tab: rows with a rank, the what-if in words, a drawer for the extra payment | A Debts band under the goals: three figures, a table, and Extra a month typed in place |
| Notes | Every note in full, one under another, edited in place | A list beside the chosen note; a note is written in a drawer |
| Editors | The old drawers (`te-drawer`) | The kit's Drawer: the plan's with folds, a goal's with tabs |

## Trimmed, and what stays

**Goes**, as the prototype has none of it:

- Today's money / Future money. The plan is in today's money, as the chart
  says.
- The chart's Saving and growth view.
- The fall later on. One market fall, the year work stops (decision 3).
- The 8-column, every-year table. Year by year is the prototype's: every
  fifth year and the stop year.
- "Your budget beside the records", the Assumptions paragraph and the
  footnotes. What matters moves into an (i).
- On Goals:
  - The tick boxes on the timeline.
  - The "falling to" step-down.
  - The pace sentences.
  - "If your investments paid for these".
- These editor fields, which are not in use:
  - A goal priced at today's cost, with its rate.
  - The Custom scenario.
  - Spending "for one" once only one person is planned for.

The calculations behind them stay in `lib`, untouched. Records already saved
are still counted.

**Stays**, beyond the prototype:

- **A goal's note, priority and funding source**, which are in use.
  - The note sits under the goal's name.
  - The priority orders the goals within each group.
  - The funding source is in the drawer.
- **A debt's note**, which is in use. It sits under the debt's name.
- **Bold in notes** (`**`), which notes use.
- **"Stops when work stops"** in Edit plan, which is in use and gives the
  "Less what stops" spending.
- **"Could stop as early as {year}"** with Try, when the plan already lasts.
  It answers the page's own question, and the prototype says nothing then.
- **The warning on a debt's 0% rate or 0 minimum.** Every date rests on
  those two figures.
- **What keeps work from being lost.** These aren't visible, but stay:
  - A note saves only over the version it was opened from.
  - A draft survives its note being deleted elsewhere.
  - Leaving with unsaved text asks first.
  - Each part says when a source didn't load.

## The frame

- Each tab's tools sit in the page header, as on Money and Wealth
  (`ToolsSlot`). Plan: Edit plan. Goals & debts: + Debt, + Goal. Notes: the
  "Private to your household" chip and + Note.
- **Old addresses keep working.** `?tab=life` opens Plan, `?tab=debt` opens
  Goals & debts, and `?tab=plan` now opens the new Plan. Overview's tiles
  point at the new tabs; its Cash reserve tile opens Goals & debts, where
  the reserve now shows.
- **A goal, a debt and a note have an address**, as an account and a
  holding do: `/planning?goal={id}`, `?debt={id}`, `?note={id}`. The goal
  and debt drawers open over any Planning tab, so Plan's "Goals on the
  timeline" opens a goal in place. Overview's To do "Open goal" opens the
  goal itself, and "Open notes" opens the note that is due.
- Scope stays as today. Plan is the household's whoever is selected, and
  says so. Goals and debts in one person's view are their own and shared
  ones, with shared ones counted at half.
- Plan and Goals & debts stay in dirhams, as today (the AED note).

## Plan

- **Strip**, one line:
  - Basis: "recorded months · spending {x} · saving {y} a month", with
    Change (today's basis drawer) and an (i) saying why that basis and
    since when.
  - The scenario as a select: Baseline, Conservative, Optimistic.
  - The spending after work as a select, with today's choices, each with
    its figure ("Planned · {x} a year", Less what stops, Today's or
    Budgeted, Essentials).
  - "{r}% return · {i}% inflation".
- **When can we stop?** A card in two columns.
  - **Left column:**
    - "Stopping in" with the year, the ages, and where the year comes from:
      your plan, trying it, or assumed.
    - Verdict chips for Baseline and Conservative.
    - Four figures: Pot in {year}; Needed then, with an (i); Goals on the
      way; then either Short by (decision 2) or Left in {end}.
    - The stepper ("Stop working − {year} +").
    - While a year is being tried: a "Not saved" chip, Reset, and Make this
      the plan.
    - Warning rows under the figures, when they apply: someone not in the
      plan, balances counted as 0, or the start leaving something out.
  - **Right column:** "The pot, year by year", drawn by a new kit chart.
    - Bars, with the years after work stops paler.
    - A band from Conservative to Optimistic.
    - A "Stop {year}" line, and a "Runs out {year}" dot.
    - A diamond for each goal the pot pays.
    - Arrow keys move along the years, with a readout of the year, its
      ages, the pot and the range.
  - Two folds beneath:
    - **Year by year:** every fifth year and the stop year, with Year,
      Ages, Pot at start and a chip (Work stops, Nothing left, Working,
      After work).
    - **Goals on the timeline:** each open goal with its amount and a chip
      (Paid {year}, From cash {year}, Kept, No date). A goal opens its
      drawer.
- **What would it take?**
  - When the money runs short: three figures.
    - **Stop in {year}**, with its ages and Try.
    - **or save {x} more a month**, from now until the stop year.
    - **or spend at most {x} a year**, after the stop year, besides the
      costs that start then.
    - A figure with no answer says so ("No stop year makes it last").
  - When it lasts: one row, "Lasts to {end}" and "Nothing more is needed
    on {scenario}", with "Left at the end". Beneath it, muted: "Could stop
    as early as {year}" with Try.
  - A goal the pot can't pay while still working keeps today's answer:
    move it later or make it smaller.
- **What could go wrong?** Two cards side by side.
  - **If markets fall** (decision 3) and **If the rupee weakens**.
  - Each has a verdict chip in its header and one line beneath ("A
    two-year fall from {year} · steady plan lasts to {end}").
  - Each has an (i) explaining the test.
  - A "Show the path" fold holds the line against the steady plan. The
    kit's trend line gains a second, comparison line for this.
  - With nothing in rupees, the rupee card isn't drawn.
- Empty states keep today's wording and actions, drawn as the kit's
  EmptyState:
  - Not enough to project.
  - Set up the plan.
  - The plan has run its course.
  - Withheld while a source didn't load.
- **Edit plan**, a wide drawer, "Who it is for, and what it assumes".
  - Its sections, as folds:
    - **Who it is for:** birth year and age to plan to.
    - **Stop year.**
    - **Spending after work stops:** Planned, Essentials only, and the
      categories that stop.
    - **Costs that start then.**
    - **Other income.**
    - **Growth:** return, inflation, return after work, return on cash.
  - A cost or an income is added and edited in place, inside its fold. The
    prototype has no drawer opened over a drawer.

## Goals & debts

- **Goals**, one card per group, in this order:
  - Next 3 years · from cash
  - Kept, not spent · in cash
  - Later · paid by the plan
  - No date
- Each group card:
  - An (i) with the group's rule.
  - In its header: "{saved} of {target} · needs {x} a month".
  - The kept card's header also gives the **cash reserve**: "{x} in cash ·
    about {n} months of spending", with a chip, Covers kept goals or Short
    of kept goals. This is today's Monthly check, which loses its tab.
- Columns:
  - **Goal:** the owner's avatar, the name, and the note beneath.
  - **Target:** the amount, with "by {month}" or "no date" beneath.
  - **Saved.**
  - **Progress:** a bar and %.
  - **Needs a month.**
  - **Pace:** amber when below the plan, with the (i) "what has gone in
    each month, over about three months".
  - **Status:** today's chip.
- Rows within a group follow the priority, then the date.
- A later goal leaves Needs a month and Pace blank.
- **Done ({n})** folds the done goals.
- The empty state is "No goals yet" with + Goal.
- **The goal drawer:**
  - Tabs: Details, Contributions, Linked accounts.
  - **Details:**
    - The target.
    - Spent on its date / Kept, not spent.
    - Name, Target date, Monthly plan, Owner.
    - Note, Priority, Funding source.
    - Whether a goal is in the next 3 years or later still follows its
      date, as today.
  - Contributions and Linked accounts are today's sections.
  - The footer: Delete (two presses), Mark done or Reopen, Cancel, Save.
- **Debts**, a band under the goals, while anything is owed:
  - **Header:** "{n} debts", and Avalanche / Snowball (only with two or
    more debts) with its (i). The order is saved, as today.
  - **Three figures:**
    - Owed (the hero).
    - Clears {month}: "at the minimum payments", or "with {x} extra a
      month".
    - Interest still to pay.
  - **Table:**
    - Debt: avatar, name and note, with a Not in net worth chip and "Link
      account" when no valued account carries it.
    - Owed, Rate, Minimum, Clears, and Paid down (a bar).
    - The rows come in the chosen order.
    - A rate or minimum of 0 keeps its warning row above the table.
  - **Extra a month**, typed in place (decision 4): "→ Clears {month} ·
    saves {x} in interest, against {month} at the minimums". In one
    person's view it says the extra is the household's and stays read-only.
  - **The debt drawer:** today's fields, with the warning row "Not in net
    worth until an account is linked". Its Account select keeps "Create a
    loan account".

## Notes

- **Two panes.**
  - On the left, a Notes card listing each title with "Updated {date}"
    and a Due or Yearly chip, in decision 5's order.
  - On the right, the chosen note:
    - The title and Edit.
    - For a yearly note, a row: "Checked once a year · last checked
      {date}", amber with Checked today while due.
    - The body, drawn from `#`, `-` and `**` markup.
    - "Updated {date} by {name}".
- **The note drawer** (wide):
  - Title, the body, and a "Check once a year" switch with its hint.
  - The footer: Delete (two presses), Cancel, Save or Add note.
- The empty state is "No notes yet", with + Note.

## Figures the prototype shows that the app doesn't compute

| Figure | Proposal |
|---|---|
| The Conservative to Optimistic band, year by year | Run the plan on both scenarios at the same stop year (it already runs Conservative for its verdict); add, with a test |
| Short by, as the gap at the stop year | Needed then less Pot in, when the plan runs short (decision 2); add, with a test |
| The rupee path, year by year | `rupeeDrift` keeps only the verdicts; keep the rows too; add, with a test |
| Interest the extra payment saves | The two interest totals the app has, one less the other; add, with a test |

Everything else on the three screens is already worked out by the app: the
cash reserve, each goal's need and pace, payoff dates and the levers.

## Decisions

1. **The Plan summary tab is retired**, as the prototype does. Overview
   shows its figures and To do raises its items.
   - The reserve moves to the Kept card.
   - Saving against the target is Budget's savings line.
   - A goal with no date is the No date card.
2. **"Short by" is the gap at the stop year**, which reads straight off the
   two figures above it. Each year's shortfall shows in the readout.
3. **One market fall**, the year work stops: the prototype's, and the
   harder of the two the app tested.
4. **Extra a month is typed in place**, as a what-if shown at once. When it
   differs from the saved figure, a "Not saved" chip appears with Reset
   and Make this the plan, as the stop year has. Overview's Debts tile uses
   the saved figure.
5. **Notes list due notes first, then yearly ones, then the rest**, each
   group in the order they were written.

## Pull requests

| PR | Holds |
|---|---|
| 6a | The frame (three tabs, old addresses, the summary retired, Overview's links), Plan with its strip and three bands, the kit's plan chart and comparison line, and the Edit plan drawer |
| 6b | Goals & debts: the goal tables and drawer, the Debts band and drawer, `?goal=` and `?debt=` addresses, the cash reserve |
| 6c | Notes: the list and the note, the note drawer, `?note=` |

Each is built test first and checked on desktop. Phones keep working but
aren't planned for. Each is reviewed fresh, and merged on the word.

## Not in this phase

- New data or migrations: none are needed. The extra payment and the debt
  order are already saved, and a note's order is worked out, not stored.
- Settings and the bot (phases 7 and 8).
