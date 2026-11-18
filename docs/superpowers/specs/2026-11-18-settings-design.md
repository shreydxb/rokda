# Settings, the revamp's phase 7: design

Status: for approval.

The prototype (`design/prototype/js/screens-settings.js`) is the target, as it
was for the other pages. Each tab is built like its prototype screen from the
shared kit, and what the old tabs add beyond it goes unless it is in use or
worth keeping, as Planning was trimmed. The UI review's Settings items
(S-household, S-categories, S-telegram, S-backups, and T19's linking) are what
the prototype already answers. With this phase, every screen in the prototype
is built.

## What changes

| | Today | After |
|---|---|---|
| Household | Name and rupee rate as fields with their own Save buttons, members as two-line rows, the build under "About" | A Household card (Name, Rupee rate with an "Updated {date}" chip and an (i)) beside a Members table (Name, Role, Login, Telegram); fields save when left; + Member in the page header |
| Member editor | The old drawer, with the Telegram link code in it | The kit's drawer: Name, Role (Owner / Member) with a one-line note, then Login and Telegram as chips; Link opens the link drawer |
| Categories & rules | Income and Expense as two lists, a Show archived button, Starter set and + Category; rules as rows with a tall Apply now | A Categories table grouped as the prototype (Income, each group, Savings) with Whose cost, Budget a month and chips (Savings, Stops with work, Archived), beside a Merchant rules table with Apply; + Rule and + Category in the page header |
| Category and rule editors | The old drawers, with paragraphs | The kit's drawer; the paragraphs go behind an (i) |
| Telegram | Eight rows with "On"/"Off" words, an intro line, an "Activity" table of calls, success and tokens | Two cards of switches, Morning message and Questions that need an answer, with Budget alerts as a row linking to Budget; a Linked accounts card with Link; Diagnostics folded |
| Linking | A 32-character code in the member editor, to copy and send | A link drawer: Open Telegram (the bot with the code filled in), a QR code of the same link, and the code with Copy as a fallback |
| Backups | A paragraph, Latest as lines, a form with no labels, history as lines | Latest with a chip each (OK, Late, Failed, Missing) and Runbook →, a labelled "Record a backup" form, and History as a table |

## Trimmed, and what stays

**Goes**, as the prototype has none of it:

- The separate Save buttons on the household's name and rate.
- "How the currency works" and "About members" as folds: each becomes an (i).
- The Telegram tab's intro line and its token count.
- "Show archived" as a button: archived categories fold at the foot instead
  (decision 4).

**Stays**, because it is in use or worth keeping:

- **Subcategories.** The app files spending under subcategories within
  groups, and the household uses them; a group is a category that has
  subcategories, not a free-text field as in the prototype. A group's row
  opens that category, so it can be renamed.
- **The starter set**, for a household with no categories, and as a link at
  the foot of the Categories card (decision 6).
- **Merchant rules.** None are saved yet, but the prototype has them, the
  bot and the Inbox file by them, and a transaction's editor links to its
  rule (`?tab=categories&rule={id}`).
- **Backups.** None are recorded yet; Latest says Missing for both, and
  Overview's To do keeps asking for one.
- **Who may change what.** An owner manages the roster; a member renames
  themselves and links their own Telegram, and sees the rest read-only, as
  today.
- Every error, refusal and guard the tabs have today.

## The frame

- Settings keeps its four tabs and their addresses (`?tab=household`,
  `categories`, `telegram`, `backups`).
- Tab tools in the page header (`ToolsSlot`): Household: + Member.
  Categories & rules: + Rule, + Category. Telegram and Backups: none.

## Household

- **Household card** (left):
  - Name.
  - Rupee rate: "1 AED = [ ] INR", with an "Updated {date}" chip and an
    (i): stored in AED; the display currency only changes how totals show;
    USD at the fixed peg, INR at this rate, which the nightly refresh also
    updates.
  - Each field saves when it is left, and says "Saved" (S-household-4).
    A refusal or a bad figure says so under the field and puts it back.
  - The build label, small and muted, under the card (where the prototype
    puts its own).
- **Members card** (right): a table, Name (avatar, "you"), Role, Login
  (Linked / No login), Telegram (Linked / Not linked, amber); "{n} people" at
  its right; an (i) about owners and members with no login. A row opens the
  member.
- **Member drawer** (the kit's):
  - Name.
  - Role, Owner / Member, with one line when it can't change: "The only
    owner. Add another first." or "An owner needs a login."
  - Login and Telegram as chips; "Link" opens the link drawer.
  - Footer: Delete (not for yourself; two presses), Cancel, Save or
    Add member.

## Categories & rules

- **Categories card** (left, wider): "{n} in {g} groups" at its right; a
  compact table:
  - Columns: Category, Whose cost (avatar and name, or Shared), Budget a
    month (this month's, a dash when none), and the chips: Savings, Stops
    with work.
  - Rows grouped: Income, then each group of expense subcategories in the
    order they sort today, then Savings. A category with no subcategories
    sits under Other, as the prototype does.
  - Archived categories fold at the foot: "Archived ({n})".
  - Starter set at the foot.
- **Merchant rules card** (right): "{n} active" at its right; a table, When
  the merchant ("contains" or "starts with" and the pattern in mono, an Off
  chip when archived), File under, and Apply on an active rule. Apply files
  past uncategorised transactions and says how many. With no rules, an empty
  state with + Rule.
- **Category drawer:** Name, Kind (Expense / Income), Group (a top-level
  category, or none), Whose cost; switches Savings not spending, Stops when
  work stops, Archived, each with its short hint. The paragraphs go behind
  an (i).
- **Rule drawer:** Match (Contains / Starts with), Merchant pattern,
  Category, Active; Delete, Cancel, Save or Add rule.

## Telegram

- **Morning message card:** an (i), "everything that needs no answer
  arrives together, once, in the morning"; a row each with its line and a
  switch: Missed bills, Card due dates, Cash cover, Unusual spending,
  Weekly and month-end brief, and Budget alerts ("Set per category") with
  Budget →.
- **Questions that need an answer card:** an (i); Card statements,
  Dividends, Month-end balances.
- The switches are the kit's and save at once, each only its own setting,
  as today. They are the household's (decision 1).
- **Linked accounts card:** a row a member with its chip, and Link (or Link
  again once linked).
- **Link drawer:** "Link {name}": Open Telegram, the QR code, the code with
  Copy, "Works once, for 15 minutes." (decision 2).
- **Diagnostics · last 30 days**, folded: Messages handled, Read without
  error, and a table of messages by day in the house date format.

## Backups

- **Latest card** (left): Export and Restore drill, each "Passed {date} ·
  {n} days ago" with a chip: OK, Late (an export older than 35 days),
  Failed, or Missing. Runbook → at its right, and an (i) for the rest.
- **Record a backup card** (left): Kind and Result side by side, Date, Note,
  Record.
- **History card** (right): "{n} recorded"; a table of Date, Kind, Result
  (chip), By (avatar), Note.

## Figures the prototype shows that the app doesn't compute

None. A category's budget this month, the rate's date, the chips' states
and the diagnostics counts are all read already.

## Decisions

1. **Telegram's switches stay the household's.** The prototype has "Alerts
   for {person}", but the switches are stored once for the household and
   the bot reads them that way; making them each person's needs a database
   change and the bot's, which belongs with the bot (phase 8). The cards say
   nothing about whose they are, as today.
2. **Linking moves to the Telegram tab, with a link and a QR code.**
   - Open Telegram is `https://t.me/{bot}?start={code}`, which the bot
     already accepts. The bot's name is a build setting
     (`VITE_TELEGRAM_BOT`, set where the site is built); without it the
     drawer shows the code only.
   - The QR code is drawn by a small library, loaded only when the drawer
     opens.
   - Unlink is not offered: it needs a new database function, and linking
     again moves the link. "Link again" gives a fresh code.
3. **Household fields save when they are left**, with "Saved", as the
   prototype has it, in place of their Save buttons.
4. **Archived categories fold at the foot** of the Categories card, as Done
   goals do, in place of "Show archived".
5. **"Stops when work stops" joins the category drawer** as a switch and
   shows as a chip, as in the prototype. The Edit plan drawer keeps its own
   list: both set the same thing.
6. **The starter set stays**, shown by a household's empty Categories card
   and as a link at the card's foot, since the prototype has no place for
   it.

## Pull requests

| PR | Holds |
|---|---|
| 7a | The frame's tools; Household with the member drawer; Categories & rules with the category and rule drawers |
| 7b | Telegram with linking (the link drawer, QR code and bot link) and Diagnostics; Backups |

Each is built test first and checked on desktop. Phones keep working but
aren't planned for. Each is reviewed fresh, and merged on the word.

## Not in this phase

- Database changes: none are needed.
- Per-person alerts, Unlink, and the bot's own messages (phase 8).
