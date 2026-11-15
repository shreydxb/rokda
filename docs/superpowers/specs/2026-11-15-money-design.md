# Money, the revamp's phase 4: design

Status: draft for approval. Replaces `2026-11-14-money-design.md`, which was
written before the independent review and is superseded.

The prototype (`design/prototype/js/screens-money.js`, Inbox in
`screens-overview.js`) is the target. Each tab below is built like its
prototype screen; where the app knows something the prototype doesn't (a
custom date range, a split, an income-based household share), the app's
behaviour stays and is drawn in the prototype's style.

## What changes

| | Today | After |
|---|---|---|
| Money's tabs | Activity, Budget, Recurring, Insights, Inbox, Review | Activity, Budget, Recurring, Month end |
| Insights | Its own tab | Gone. Usual month → Budget's Usual column; top merchants → Activity's Merchants view; what moved → Overview's What changed (done) and a closed month's Biggest changes |
| Inbox | A Money tab | Its own page, `/inbox`, which the sidebar already names |
| Review | A checklist with a Next step card and What to do next | Month end: three steps, then a closed month reads as the month on a page |
| Wealth → Statements | Its own tab | Step 2 of Month end, and a card on the running month |

## The frame

- Each tab's tools sit in the page header, as in the prototype: Activity has
  the month stepper, List / Calendar / Merchants and + Transaction; Budget has
  Month / Year, the stepper and + Budget; Recurring has + Bill; Month end has
  the stepper.
- The month is in the address (`month=YYYY-MM`) and is kept when you switch
  tab, so stepping to October on Budget and opening Activity shows October.
  Activity's custom date range still overrides it.
- Old addresses keep working: `?tab=insights` opens Activity's Merchants view
  for the same month; `?tab=review` opens Month end; `?tab=inbox` opens
  `/inbox`; `/wealth?tab=statements` opens Month end on step 2. The
  "Back to the review" link becomes "Back to Month end".

## Activity

- **Filters:** search, Dates (the month, All dates, or Custom… with from and
  to), Category (with Uncategorised), Account, and More. More is a small
  pop-over holding Type, Which dates (Posted, Scheduled, All), Needs review
  only and, when any exist, AED estimated only. Active filters show as chips
  with × and Clear. Sorting moves to the Date and Amount column headers; the
  Sort select goes.
- **Summary row** on the table card: "N transactions", a "N scheduled not
  counted" chip that shows them, Spent, Income, and an (i) that says what
  Spent is: purchases less refunds, transfers count as neither, and shared
  records count half in one person's view.
- **Table:** Date; Merchant with chips (Needs review, Refund, Scheduled,
  Possible duplicate, AED estimated); Category, which is a select in place
  when the record has none, "Transfer → account" for a transfer and
  "Split · n" for a split; Account with the owner's avatar (the Owner column
  folds into it); Amount with the native amount beneath and "half of X" in
  one person's view. A row opens the record editor, as today.
- **Calendar:** today's calendar in the prototype's style; a day's records
  list beneath it.
- **Merchants** (from Insights): spending by merchant this month, net of
  refunds, with the number of payments, as a bar list. Beside it, Merchants
  paid and Top three's share of what was spent. A merchant opens the list
  filtered to it.
- **Empty month:** an empty state with + Transaction and a way back to the
  latest month with records.

## Budget

- **Hero:** spent of budget, a bar with a tick for how far through the month
  it is, "N% spent · N% of month gone", and one chip: Over by X, Over pace,
  On pace, or Within budget for a finished month. In one person's view a chip
  says the limits are the household's.
- **By category:** group rows with subtotals, category rows beneath them.
  Columns: Category (with the owner's avatar for a personal one), Spent,
  Limit (typed in place, as today), Usual, Pace (bar with the month tick and
  an Over by chip). A category opens its transactions beneath it with "All in
  Activity →". Then a Budgeted total row and an Outside budget row, which
  carries an "N uncategorised" chip that opens those records.
- **Usual** is the category's average over up to 6 earlier months with
  records, the same average Overview's What changed uses; "+N%" shows when
  this month is 10% or more above it.
- **Savings target** and **Household share:** the same figures as today in
  the prototype's cards. The share keeps splitting by income when salaries
  are set up.
- **Year:** the prototype's grid (months across, categories down, budgets in
  italics for months ahead, totals), with today's figures.
- Budget switches to `monthBudgetTrack` (lib/budget.js), so Budget, Overview
  and Month end read one sum (a deferred finding from phase 3).

## Recurring

- **Strip:** Fixed a month (and how many bills), Variable, about, Expected
  income a month, To mark paid (with a chip: N late, Due soon, or All clear).
- **Bills table:** Status, Name, Every, Next due (with "in n days" or "n days
  ago"), Owner, Paid by (Autopay or Manual), Amount ("about" for a variable
  bill, the native amount beneath), and Mark paid when one is due.
- **Expected income table:** the same columns with Paid into in place of Paid
  by. Ended schedules sit in a fold.
- **Words:** Posted reads Paid for a bill and Received for income. An autopay
  bill past its date with nothing recorded reads Not confirmed (amber), since
  the money most likely left on time; a manual one stays Late (red). Only the
  app's wording changes; the bot's is phase 8.
- + Bill opens the editor in the kit's drawer.

## Inbox, its own page

- `/inbox`, titled "Inbox · N waiting", with "Approve N read cleanly" (today's
  Approve confident, same rule) in the header. Undated batches stay above.
- **Two panes.** The waiting list: text or photo, merchant, amount, who sent
  it and when, and chips (No date, Read cleanly, Looks already recorded). The
  selected message: the quoted text or the receipt photo, "From X · time ·
  Telegram", then what was read as fields you can edit in place (Merchant,
  Amount with AED debited for another currency, Date, Category, Account). The
  separate Edit step goes. Remember this merchant and the already-recorded
  warning stay. Approve and Reject (today's Not a spend), and the keys A, R,
  ↑ and ↓, which do nothing while typing in a field. After either, the next
  message is selected.

## Month end

Which page a month shows depends on where it is:

1. **The running month:** "November is still running", with Close October
   when the month just ended isn't closed yet. A strip of Uncategorised so
   far, Statements to check (with "N doesn't match") and Balances not
   confirmed, each linking where it is done. Then every card statement still
   open, in the statements table.
2. **The month just ended, not closed:** "Close October", a three-step bar,
   "n of 3 steps done", a Household chip and "Budget for Oct →". The step
   still open is expanded; a click opens another.
   - **Tidy transactions:** uncategorised records with a category select in
     place; possible duplicates with Both are real and Delete one; flagged
     records, AED estimates, transfer suggestions and unlinked refunds, each
     with its action as today. A "Nothing to do (n)" fold lists the checks
     that are clear.
   - **Check statements and balances:** the statements that closed in the
     month, grouped by card (Period, Due, In Rokda, Statement, Difference,
     Status), with Mark done, Resolve (which asks what was done, as today) and
     Reopen; tick boxes and "Mark n done" for several at once. Then the
     balances not confirmed since the month ended, each with Confirm.
   - **Close:** Income, Spent, Saved and Net worth (Provisional when an
     account isn't valued), a note when a step is still open ("you can close
     now and finish after"), the Assets and Liabilities fields today's close
     already has, and Close October.
3. **A closed month, "the month on a page":** Income, Spent (with the change
   on the month before), Saved (and its share of income) and Net worth at
   close (with the change on the previous close); Biggest changes, the three
   categories furthest from their usual, with a tick at the usual; and
   Against budget, with a chip for each group over. An earlier month that was
   never closed shows steps 1 and 2, and says it can't be closed now.

What leaves: the Next step card, and What to do next. Its goal set-asides are
already on Overview's To do; its cash and saving lines are on Planning → Plan
and Budget's savings target.

## Figures the prototype shows that the app doesn't compute

| Figure | Proposal |
|---|---|
| Budget's Over pace / On pace chip | Add, with tests: over pace when the share of budget spent is more than 10 points ahead of the share of the month gone |
| Usual over 3 months (prototype) | Keep 6 months, as Overview and Insights use today, so Usual reads the same everywhere |
| Recurring's monthly totals | Today's Fixed and Variable add each bill whatever its cadence, so a yearly bill counts in full every month. Use the monthly equivalent (a yearly bill counts a twelfth), with tests |
| Not confirmed | A label for an autopay bill that is late; no new data |
| Possible duplicate on an Activity row | The pairs Month end already finds; new place only |
| Merchants' Top three share | Add, with a test |
| A closed month's changes on the month before | Worked out from records and closes the app has; add with tests |
| Typing a statement's total (prototype's "Enter") | Leave out: totals come in from reconciling a statement in a Claude session. The column shows the total when one is recorded, a dash otherwise |

## Pull requests

| PR | Holds |
|---|---|
| 4a | The month in the address, the pop-over for More, Activity (List, Calendar, Merchants) and Recurring |
| 4b | Budget, the Usual column and the pace chip; the Insights tab removed |
| 4c | The Inbox page |
| 4d | Month end, replacing Review and absorbing Wealth → Statements |

Each is built test first, checked on desktop (phones keep working but aren't
planned for), reviewed fresh, and merged on the word.

## Not in this phase

The record, transfer and recurring editors' fields (only their drawer
changes), the bot's wording (phase 8), and Wealth's other tabs (phase 5).
