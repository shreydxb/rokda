# Money — design

## Why

Money is where records are kept, so it is the screen worked in most after
Overview. The revamp audit (November 2026) found the same few things on each
of its six tabs: a full-width "← Prev · month · Next →" bar on four of them,
lines that say again what a figure beside them already says, a second row of
filters always open, an Inbox message box mostly empty, Recurring held to
two-thirds of the page, and Review saying its next step twice.

## The screen's one question

"Are this month's records right, and where is the money going?" Each tab
keeps its job; this pass takes out what repeats and tightens the layout.

## What changes, everywhere

1. **One compact month switcher** — `‹ Nov 2026 ›` at the top left, beside
   the tab's other controls, in place of the full-width bar with big
   buttons. Budget, Insights, Review and the Activity calendar all use it.
   The arrows are labelled "Previous month" and "Next month" for screen
   readers; Next stays disabled where it is today (Review).

## Tab by tab

### Activity

```
[Search…] [All dates ▾] [Posted|Scheduled|All] [Needs review] [Filters · 1]   [List|Calendar] [+ Add]
8 records · Net spend AED 7,748 · Income AED 18,000

Date    Merchant                          Category     Account          Amount
13 Nov  Unknown · needs review            Uncategorised Current account   −95
12 Nov  Restaurant …                      Dining out   Platinum card    −220
11 Nov  Spinneys · Alex                   Groceries    Platinum card    −412
```

- **Filters fold.** Category, account, type and sort move behind a
  "Filters" button that opens them in place. The button shows how many of
  them are set ("Filters · 1"), and the row stays open while any is set, so
  a filter is never hidden while it is narrowing the list.
- **The Owner column goes.** Nearly every record is shared; a record that is
  one person's gets their name as a small tag after the merchant, as "needs
  review" and "refund" do now. The household switch still narrows the list.
- **The summary line is shorter:** the purchases-less-refunds breakdown
  moves to the line's hover text.

### Budget

```
[Month|Year]  ‹ Nov 2026 ›                                        [+ Set budget]

Spent of budget   ━━━━━━━━━━━━━|━━━━━━━━━━━━━━━━━━━━━━━━━━━━
572 of 2,150      27% used                    47% of the month gone
```

- The month switcher sits beside Month | Year.
- **The pace sentence goes when it only repeats the bar** ("47% of the month
  gone, 27% of budget spent."). "Already 70 over budget" stays as a warning,
  and a past month still says what it closed at.
- **"Budgeted subtotal" and "All spending" become one line:**
  "Budgeted 2,150 · spent 572 · all spending 7,168, of which 6,595 outside
  the budget (95 uncategorised)".
- **Household share:** when shared costs are split evenly because no salary
  is recorded, one grey line says how to change it: "Add each salary as an
  income reminder to split by income." (deferred from the shell review).

### Recurring

```
+ Add recurring                     Committed each month 6,555 · Variable ~0

Name        Schedule   Next     Whose    Autopay       Status     Amount
Streaming   Monthly    20 Nov   Alex     Yes           Upcoming      −55
Rent        Monthly    28 Nov   Shared   No            Upcoming   −6,500
```

- **Full width, as a table**, in place of a list held to 820px with the
  details run together in one grey line. "No autopay" keeps its warning
  colour; overdue and missed statuses keep theirs.

### Insights

- The compact month switcher.
- **A category with no earlier months shows no bar**, only "new this
  month"; today it draws a full bar that reads as "far over average".
- "Net of refunds, posted records, AED." under Top merchants moves to the
  heading's hover text; "What moved, and on what evidence" becomes "What
  moved".

### Inbox

- **The message box fits the message**, instead of a fixed tall box.
- **The speech-bubble icon goes** from each waiting item; where it came from
  is already said under the message ("via Telegram").
- The two help lines ("Sorted newest first…", "Approved items appear in
  Activity straight away.") go. The low-confidence flag itself stays.

### Review

- The compact month switcher.
- **The "Next step" box goes.** It repeated the first open check below it;
  instead the first open check carries the accent border and the button.
- "Covers the whole household's records, whoever is selected. Each check
  ticks itself off once the work is done." becomes "Covers the whole
  household."
- "What to do next" becomes a short list (one line per goal, with its
  link), instead of a large card per goal.

## Limits

- No figure changes how it is worked out, and no filter, check or action is
  removed; each is where it was or one click away.
- Warnings, errors and statuses stay in view.
- Rokda's palette and type stay as they are. Phone layouts keep working; they
  are not redesigned.

## How it ships

Two PRs, to keep each review small:

1. The month switcher, Budget, Insights and Review.
2. Activity, Recurring and Inbox.

## Left to the builder

Exact spacing, the wording of each shortened line, and the tests.
