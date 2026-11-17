# Planning, the revamp's phase 6: design

Status: draft for approval.

The prototype (`design/prototype/js/screens-planning.js`, `css/planning.css`)
is the target, as it was for Money and Wealth. Each tab is built like its
prototype screen from the shared kit. Where the app knows something the
prototype doesn't, the app's behaviour stays and is drawn in the prototype's
style. Examples: two market falls, a custom scenario, a goal's cost rising
from today, the priority what-if. The UI review's Planning items (N7, N9,
S-plan-1, S-life, S-goals, S-debt, S-notes) are what the prototype already
answers.

## What changes

| | Today | After |
|---|---|---|
| Planning's tabs | Plan, Life plan, Goals, Debt payoff, Notes | Plan, Goals & debts, Notes |
| Plan (the summary) | Stop working, Goals and Debt cards, a Monthly check, What needs a decision | Gone (decision 1). Overview's Plan strip and To do took its place in phase 3 |
| Life plan | Basis notes, an assumptions bar, the stop year as a headline paragraph, four figures, levers as a sentence, the chart, two stress sections, goals with tick boxes, an Assumptions paragraph | Becomes **Plan**: a one-line strip, then three bands: When can we stop?, What would it take?, What could go wrong? |
| Goals | Sections of two-line rows, each with a sentence saying why | **Goals & debts**: one table card per group, columns as the prototype, and the why in the status chip's tooltip and the drawer |
| Debt payoff | Its own tab: rows with a rank, the what-if in words, a drawer for the extra payment | A Debts band under the goals: three figures, a table, and Extra a month typed in place |
| Notes | Every note in full, one under another, edited in place | A list beside the chosen note; a note is written in a drawer |
| Editors | The old drawers (`te-drawer`) | The kit's Drawer: the plan's with folds, a goal's with tabs |

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
    Change, which opens today's basis drawer. The (i) holds why that basis,
    since when, and the budget's own answer beside it (today's "Your budget
    beside the records").
  - The scenario as a select (Baseline, Conservative, Optimistic, Custom).
  - The spending after work as a select, with today's choices, each with
    its figure ("Planned · {x} a year", Less what stops, Today's or
    Budgeted, Essentials).
  - "{r}% return · {i}% inflation".
  - Today's money / Future money as a small Segmented. The prototype has no
    such switch; the app keeps it.
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
    - Today's warnings sit under the figures as warning rows: someone not
      in the plan, balances counted as 0, or the start leaving something
      out.
  - **Right column:** "The pot, year by year", drawn by a new kit chart.
    - Bars, with the years after work stops paler.
    - A band from Conservative to Optimistic.
    - A "Stop {year}" line, and a "Runs out {year}" dot.
    - A diamond for each goal the pot pays.
    - Arrow keys move along the years, and a readout shows the active year,
      as today.
    - The Pot / Saving and growth switch stays in the card's header.
  - Two folds beneath:
    - **Year by year:** today's table, every year, the last column a chip
      (Work stops, Nothing left, Short by {x}).
    - **Goals on the timeline:** each open goal with its amount and a chip
      (Paid {year}, From cash {year}, Kept, No date). A goal opens its
      drawer. Today's tick box goes: Kept or Spent is set in the goal's
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
    as early as {year}" (with Try) "· or spend up to {x} a year".
  - A goal the pot can't pay while still working keeps today's answer:
    move it later or make it smaller.
- **What could go wrong?** Two cards side by side.
  - **If markets fall** (decision 3) and **If the rupee weakens**.
  - Each has a verdict chip in its header and one line beneath ("Rupee
    holdings lose 3% a year · steady plan lasts to {end}").
  - The (i) holds today's explanation.
  - A "Show the path" fold holds the line against the steady plan. The
    kit's trend line gains a second, comparison line for this.
  - With nothing in rupees, the rupee card isn't drawn.
- The Assumptions paragraph moves into the strip's (i) and the Edit plan
  drawer.
- Empty states keep today's wording and actions, drawn as the kit's
  EmptyState:
  - Not enough to project.
  - Set up the plan.
  - The plan has run its course.
  - Withheld while a source didn't load.
- **Edit plan**, a wide drawer, "Who it is for, and what it assumes".
  - Its sections, as folds: Who it is for, Stop year, Spending after work
    stops, Costs that start then, Other income, Growth. These are today's
    sections, in the prototype's order.
  - A cost or an income is added and edited in place, inside its fold. The
    prototype has no drawer opened over a drawer.

## Goals & debts

- **Goals**, one card per group, in this order:
  - Next 3 years · from cash
  - Kept, not spent · in cash
  - Later · paid by the plan
  - No date
- Each group card:
  - An (i) with the group's rule (today's footnote, split up).
  - In its header: "{saved} of {target} · needs {x} a month".
  - The next-3-years card's header also gives the step-down: "falling to
    {y} after {month}".
  - The kept card's header also gives the **cash reserve**: "{x} in cash ·
    about {n} months of spending", with a chip, Covers kept goals or Short
    of kept goals. This is today's Monthly check, which loses its tab.
- Columns:
  - **Goal:** the owner's avatar and the name.
  - **Target:** the amount, with "by {month}" or "no date" beneath. A goal
    priced at today's cost says "about {x} by {year}" beneath.
  - **Saved.**
  - **Progress:** a bar and %.
  - **Needs a month.**
  - **Pace:** amber when below the plan, with the (i) "what has gone in
    each month, over about three months".
  - **Status:** today's chip, with the sentence it rests on as its tooltip.
- A later goal shows what is set aside for it and leaves Needs a month and
  Pace blank. "If your investments paid for these" stays as a fold inside
  the Later card.
- **Done ({n})** folds the done goals.
- The empty state is "No goals yet" with + Goal.
- **The goal drawer:**
  - Tabs: Details, Contributions, Linked accounts.
  - **Details** holds today's fields: the target with Amount on the date /
    Today's cost (and Rises by), Spent on its date / Kept, not spent, Name,
    Target date, Monthly plan, Owner, Note, Priority, Funding source.
    Whether a goal is in the next 3 years or later still follows its date,
    as today; the prototype's Kind select isn't added.
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
    - Debt: avatar and name, with a Not in net worth chip and "Link
      account" when no valued account carries it.
    - Owed, Rate, Minimum, Clears, and Paid down (a bar).
    - The rows come in the chosen order.
    - A rate or minimum of 0 keeps today's "check this" warning row above
      the table.
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
    - The body, drawn from today's `#`, `-` and `**` markup.
    - "Updated {date} by {name}".
- **The note drawer** (wide):
  - Title, the body, and a "Check once a year" switch, with today's hint.
  - The footer: Delete (two presses), Cancel, Save or Add note.
  - These stay as today:
    - A save only goes over the version it was opened from.
    - A note deleted elsewhere keeps its draft.
    - Leaving with unsaved text asks first.
- The empty state is "No notes yet", with today's suggestion and + Note.

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

1. **The Plan summary tab.** It shows the stop year, goals, debts, a
   monthly check and what needs a decision. Since phase 3, Overview shows
   the same figures in its Plan strip, and To do raises the same items.
   - **Recommended:** retire it, as the prototype does.
   - The reserve moves to the Kept card. Saving against the target is
     Budget's savings line, and a goal with no date is the No date card.
2. **"Short by".** Today it is every year's shortfall added up. The
   prototype gives the gap at the stop year, which reads straight off the
   two figures above it.
   - **Recommended:** the prototype's.
   - Each year's shortfall stays in Year by year.
3. **Two market falls.** The app tests a fall the year work stops and a
   fall later on; the prototype shows one.
   - **Recommended:** the card's verdict is the fall the year work stops,
     the harder one and the prototype's.
   - A second line names the later fall's outcome.
   - Show the path switches between the two.
   - Today's "to weather it, stop in {year}" stays under the verdict.
4. **Extra a month.** Today it is a saved figure, set in a drawer, and
   Overview's Debts tile uses it. The prototype types it in place.
   - **Recommended:** typed in place as a what-if, shown at once. When it
     differs from the saved figure, a "Not saved" chip appears with Reset
     and Make this the plan, as the stop year has.
5. **The order of notes.** Today notes are listed in the order they were
   written. The prototype puts due notes first, then yearly ones.
   - **Recommended:** the prototype's, with each group in today's order.

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
