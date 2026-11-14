# Rokda prototype

A clickable mock of the recommendations of an independent UI/UX review (kept privately; see `design/README.md`), designed fresh. It is not the app: there is no login, no database and no bot. Everything on screen comes from `data.js`, and nothing is saved when the page is closed.

## Open it

Double-click `index.html`. It opens in your browser straight from the folder; nothing to install or build.

- Best at 1440×900 or wider, in Edge or Chrome.
- The typefaces (Geist and Geist Mono) load from Google Fonts. Without a connection the page still works and falls back to Segoe UI and Cascadia Mono.
- The prototype's clock is fixed at **14 Nov 2026**, the date of the made-up data, so "due in 6 days" stays true whenever you open it.
- To start again from the original data, reload the page.

## What to try

| Try this | Where |
|---|---|
| Move between screens and tabs | Sidebar, and the tabs under each title |
| Switch month; it carries across the Money tabs | The `‹ Nov 2026 ›` control on Activity, Budget and Month end |
| Search, filter and sort transactions | Money → Activity |
| Open an editor | Click any row: a transaction, bill, account, holding, goal, debt, member, category or rule |
| Categorise in place, with Undo | Overview → To do, or an uncategorised row in Activity |
| Approve and reject | Inbox (keys: `A`, `R`, `↑`, `↓`) |
| Track a card against its statement | Wealth → Net worth → click a card under Liabilities (This cycle, Statements, Details) |
| Close a month | Overview → To do → "Close month" |
| See one person's share | "Showing: Both / Maya / Dev" at the top of the sidebar |
| Change display currency or theme | The account menu at the bottom of the sidebar |
| Quick add and jump | `Ctrl K`, then type `45 coffee` or a screen name |

## The states you asked for

| State | Where to see it |
|---|---|
| Empty screen | Planning → Notes |
| Warning: a balance not confirmed | "Provisional" chip on Overview and Wealth → Net worth; "Cash wallet · Balance not confirmed" in To do; the Data health list (the amber chip beside the date on Overview) |
| Failed refresh | Wealth → Investments opens with "Couldn't refresh prices"; "Try again" succeeds |
| Very long merchant name | Money → Activity (13 Nov) and Overview → Recent |
| Month with no data | Money → Activity or Budget, then step back to Jul or Jun 2026 |
| Also shown | A late bill, an autopay not confirmed, a statement that doesn't match, a stale price, a possible duplicate, a debt not in net worth, a goal short of cash |

Deep links work too, for example `index.html#/money/budget?month=2026-07`, `#/overview?theme=dark`, `#/wealth/networth?scope=maya`, `#/wealth/investments?currency=USD`, `#/money/activity?view=calendar`, `#/money/budget?bview=year`, `#/money/monthend?month=2026-09` (a closed month) and `#/money/monthend?month=2026-10&step=all` (every step open).

## How it was checked

- Every screen was rendered in headless Edge at 1440 wide and looked at, in the light theme; Overview, Investments and Plan also in dark.
- An automated pass opened 27 screen states and clicked every kind of button, row and menu item on each (289 clicks), then typed into the fields on five screens. It found no script errors.
- The card view's "This cycle" and "Statements" tabs were opened and looked at for the shared card.
- Not checked: browsers other than Edge, widths below about 1280, and what each click looks like after it lands (the pass checks for errors, not for appearance).

## Menu

Sixteen screens, following the structure in the review (N1 to N13).

```
Overview
Inbox
Money        Activity · Budget · Recurring · Month end
Wealth       Net worth · Investments · Dividends
Planning     Plan · Goals & debts · Notes
Settings     Household · Categories & rules · Telegram · Backups
Account menu Display currency · Theme · Data health · Quick add
```

Where the current app's screens went:

| Current app | In the prototype |
|---|---|
| Money → Insights | Overview ("What changed"), Budget ("Usual" column), Activity ("Merchants" view) |
| Wealth → Accounts | The ledger on Wealth → Net worth. A credit card opens its own card view (below) |
| Wealth → Statements | Step 2 of Money → Month end, and the Statements tab of each card's view |
| Planning → Plan (the summary page) | Overview's Plan strip (four tiles) and Overview's To do, under "Planning" |
| Planning → Life plan | Planning → Plan |
| Planning → Debt payoff | The second half of Planning → Goals & debts |

### The card view

The current app's Accounts tab showed each card with its balance, limit used, spending this cycle, and close and due days, so a card could be tracked against its statement. That job is kept here as a card view, opened by clicking a card under Liabilities on Net worth, or a card's name in Month end's statements table.

- **This cycle:** owed, spent this cycle, limit used, the cycle's dates, the next payment due, and every transaction on the card since its last statement day. "All transactions on this card" opens Activity filtered to the card.
- **Statements:** that card's statements with the recorded figure, the statement's figure, the difference and the status, and a link to Month end where they are checked.
- **Details:** balance, name, limit, statement day, due day and owner.

The statement day, due day and limit matter beyond this view: in the real app they also set each statement's period, the "card payment due" item on Overview, and the bot's card reminders.

## Screens and the review IDs they implement

### Shell (every screen)

- Sidebar with the scope switch, six destinations and the Inbox count; account menu with display currency, theme, Data health and quick add.
- One header row per screen: title, period control, the one primary action, refresh with the time it last loaded.
- Implements: N1, N10, N12, P1, P2, P3, P5 to P9, P13 to P17, P19, P20, P22, P24, R1, R3, R5.

### Overview

- Headline finding, then four bands: Net worth with its 12-month trend, and This month with the budget track; To do beside Next 30 days; six months of income and spending beside "Where it went" and "What changed"; the Plan strip and Recent.
- Implements: S-overview-1 to S-overview-12, N13, H3, H4 (S-insights-3), S-plan-2 to S-plan-5, P21, P23.

### Inbox

- Queue on the left; the original message beside what was read, with every field editable in place; Approve and Reject with Undo; keyboard shortcuts.
- Implements: N1, S-inbox-1 to S-inbox-9.

### Money → Activity

- One filter row with "More", summary figures, sortable table, inline categorise, List / Calendar / Merchants views, the transaction editor.
- Implements: S-activity-1 to S-activity-9, S-insights-4, N2, N12.

### Money → Budget

- One hero bar with a pace tick and a single caption; table by group with editable limits and the "Usual" column; expanding a row shows its transactions; Savings target; Household share; Year view.
- Implements: S-budget-1 to S-budget-8, S-insights-2, S-insights-3.

### Money → Recurring

- Bills and expected income as tables, late first, with "Mark paid" on the rows that need it; "Ended" folded away; the bill editor.
- Implements: S-recurring-1 to S-recurring-6.

### Money → Month end

- Three numbered steps for the month that has ended, October (tidy transactions, check statements and balances, close); statements as a table with tick boxes and the statement's figure typed in place; a closed month (August, September) shows "the month on a page"; the month still running (November) shows what will need doing and any statement already closed.
- Implements: N3, N4, S-review-1 to S-review-11, S-statements-1 to S-statements-6, R4.

### Wealth → Net worth

- Hero figure with the "Provisional" warning, the trend, composition, and the accounts ledger (assets and liabilities) with the account editor.
- Each card row shows what was spent this cycle, when it closes and how much of the limit is used; clicking it opens the card view (This cycle, Statements, Details).
- Implements: N5, S-networth-1 to S-networth-9, S-accounts-1 to S-accounts-6 (S-accounts-2 as revised by note H10).

### Wealth → Investments

- Figure strip, value over time, allocation with the concentration cap, holdings table, the failed-refresh banner, the holding editor with tabs.
- Implements: S-investments-1 to S-investments-8.

### Wealth → Dividends

- "Needs you" when something waits; figure strip; 24 months of bars (received solid, expected outlined) beside "Coming up"; By holding as a table grouped by market; Tax years as its own view.
- Implements: N6, S-dividends-1 to S-dividends-12, H6.

### Planning → Plan

- Basis and assumptions as two single lines; "When can we stop?" with the stop-year stepper and one chart carrying the scenario range; "What would it take?"; "What could go wrong?".
- Implements: N7, S-plan-1, S-life-1 to S-life-12, H7.

### Planning → Goals & debts

- Goals as one table per group with a status chip each; debts as a figure strip, a table and an "Extra a month" what-if.
- Implements: N9, S-goals-1 to S-goals-8, S-debt-1 to S-debt-7.

### Planning → Notes

- Opens empty; adding a note turns it into two panes with yearly checks first.
- Implements: S-notes-1 to S-notes-5.

### Settings

- Household: name, rupee rate, members table and editor. Implements S-household-1 to S-household-5.
- Categories & rules: categories by group with their properties as chips; merchant rules with "Apply". Implements S-categories-1 to S-categories-5.
- Telegram: who is linked (with a link, QR and code), switches in two groups, diagnostics folded. Implements N11, S-telegram-1 to S-telegram-5, T19.
- Backups: latest status with a chip, a labelled form, history as a table. Implements S-backups-1 to S-backups-4.

## What is not in the prototype

- The Telegram bot itself (section 5 of the review). Only its Settings tab is here.
- Sign-in, phone layouts, and saving between reloads.
- Real arithmetic for planning: the stop-year projection, payoff dates and dividend figures are simple stand-ins that respond to the controls.
- The numbers do not all reconcile across screens the way real data would; each screen is internally consistent.

## Files

| File | What it holds |
|---|---|
| `index.html` | The page; loads everything else |
| `styles.css` | Palette, type and shared components |
| `data.js` | All made-up data, in one file |
| `js/core.js` | State, formatting and read-only sums over the data |
| `js/ui.js` | Shared pieces: chips, buttons, tables, bars, drawer, toast, popover |
| `js/charts.js` | The chart kit, drawn in SVG |
| `js/drawers.js` | The transaction editor |
| `js/screens-*.js`, `css/*.css` | One pair per screen group |
| `js/app.js` | Sidebar, header, navigation and event wiring |
| `_shots/` | Screenshots taken while checking the build; safe to delete |

To change the look, edit the colour values at the top of `styles.css`. To change the data, edit `data.js`.
