# The Telegram bot, the revamp's phase 8: design

Status: approved 23 November 2026, with the six decisions as recommended:
a tap on Record records, with Undo for ten minutes.

The prototype has no bot, so the target is section 5 of the UI review the
household adopted as the plan (kept privately; `design/README.md`), items
T1 to T25. The bot already sends buttons and edits a message in place for
one thing, the missing category or card (`telegram-webhook/choices.ts`);
this phase gives every message that proposes something its buttons, says
everything in one short format, and makes the morning one tidy message
followed by its questions.

## What changes

| | Today | After |
|---|---|---|
| An expense ready to record (T2) | "Got it — AED 42.00 at Bakery (Bank card, Groceries) on 2026-10-03. Everything matched, so reply "yes" to record it, or edit in the Inbox." | Two lines, `Bakery · AED 42` / `Groceries · Bank card · 3 Oct`, with Record, Category, Account and Discard |
| Recorded (T3) | A second message, "Recorded: …", and no way back | The same message turns into `✓ Bakery · AED 42 · Groceries`, with Undo for 10 minutes |
| A wrong category (T4) | A typed correction within 20 minutes, while exactly one entry waits | Category shows the six usual ones at any time before recording; after, Undo |
| Declining (T5) | "no" does nothing; it waits until rejected in the app | Discard, or "no", sets it aside |
| Sent to the Inbox (T6) | "Not recorded yet: I couldn't tell the category, so it's in the Inbox. Approve it there, or send it again with that added." plus notes | `In the Inbox · needs a category`, one line a reason, Open Inbox |
| Several waiting (T7) | Four long messages asking for a swipe-reply | With buttons on each, rarely needed; else `Which one? Tap Record on the message you mean.` |
| A pasted list (T8) | A numbered list, then instructions; "yes" refused, "all" required, dates typed | Record all, Choose…, and when dates are missing Today, Yesterday, Other day; "yes" reads as "all" when every entry has its date |
| The morning (T9, T23) | "Good morning. 3 things today:" and full sentences, then a message a question | Short grouped lines (`Not seen: Internet · AED 400 · due 3 Oct`), the same items, order and words as Overview's To do, with Open Overview; then each question as its own message with buttons |
| Autopay (T10) | Two or three instruction sentences, every morning | `Internet · AED 400 · due today from Bank card. Gone out?` with Paid, Not yet, Other amount |
| A statement (T11) | Tells the person to send the PDF elsewhere and reply "done" | `Bank card statement closed 3 Oct · due 28 Oct.` with Checked and Open Month end |
| Dividends (T12) | A line a share, then a three-option sentence | The lines, with Received, Not yet, Leave for the app (or Already in the balance, Arrived after, Not yet) |
| Month-end balances (T13) | The list, then a sixty-word paragraph | The list, one line of how to reply, and All unchanged |
| A transfer (T14) | Four sentences before the answer | `Transfer AED 500 · Bank → Savings · 3 Oct` with Record and Cancel |
| A trade (T15) | Accurate lines, then the reply hint | The lines, warnings starting ⚠, "Tax: not known yet", Save and Cancel |
| Outcome words (T16) | Recorded, Saved, captured, logged, Set aside, Left for the app… | Three: Recorded, In the Inbox, Cancelled |
| Money and dates (T17, T18) | `AED 42.00`, `AED 2050.00`, ISO dates, mixed separators; "AED" printed for any currency | `AED 1,234` (decimals only when not zero), `3 Oct` (the year only when not this year), `·` between facts, `→` for paths; the currency read is the one printed |
| Linking (T19) | The app shows a code (now a link and a QR, phase 7a); the bot's reply is a sentence | `Linked as Alex. Send a receipt, "42 groceries", or a question. /help for more.` |
| Help (T20) | No /help or command menu; /start when linked goes to the AI | A menu: /help, /brief, /inbox (how many, and a link), /undo; /start when linked shows help |
| Failures (T21, T22) | Long sentences explaining | Under fifteen words: `Couldn't read that. It's in the Inbox.`; explanations move to /help |
| The brief and answers (T24, T25) | "Net worth: AED x (Excludes 1 account …)" | One label and figure a line, ⚠ lines for warnings; answers lead with the figure and name the period |

## What stays

- Typed "yes" and 👍 still record, and every typed answer the questions take
  today still works; buttons are added, not swapped in.
- Every guard: an update handled once, a tap only by the member it was for,
  nothing across households, an entry already recorded left out, a pasted
  entry with no date never recorded on a guessed one.
- What each check sends, to whom and when, and the Settings switches.

## Decisions

1. **A tap on Record records** (T1 to T3). Today a tap never records, by
   design: the "yes" was the safety step. The two-line message shows the
   whole entry before the tap, and Undo stands for ten minutes after it,
   so recommended: Record records. The alternative keeps the typed "yes" as
   the only way to record, and buttons only change the category or card.
2. **Undo puts an expense back where it was**: the message shows its
   buttons again, so a wrong category is changed and recorded again, or
   discarded. Only the member who recorded it, within ten minutes, and only
   while nobody has changed it since. It needs one database function (a
   migration). Recommended.
3. **Discard, and "no", set an entry aside**, as Reject does in the Inbox.
   Recommended.
4. **"Open Inbox", "Open Overview" and "Open Month end" need the site's
   address**, as an Edge Function secret `APP_URL` (in Supabase), so the
   public repository names no household's site. Until it is set those
   buttons are left off. Recommended.
5. **The statement reminder stops telling the person to send the PDF
   elsewhere**; if that is still the routine, /help says so. Recommended.
6. **Alerts stay the household's.** Per-person switches (the prototype's
   "Alerts for") need the database, the bot and Settings to change, and the
   switches have never been changed from their defaults. Recommended: not
   built.

## Pull requests

| PR | Holds |
|---|---|
| 8a | The one money and date format (`_shared/applib/botFormat.js`, T17, T18), short failure lines (T21, T22), the brief (T24) and the answers' tone (T25). Text only. Each later pull request writes the messages it rebuilds through the same format and with the three outcome words (T16), so no message is rewritten twice |
| 8b | Buttons on what the bot proposes (T1 to T8, T14, T15): an expense's Record, Category, Account and Discard; Recorded with Undo; the Inbox line; a pasted list's buttons; transfers and trades. The undo function (a migration) |
| 8c | The morning (T9 to T13, T23): the digest as grouped short lines, then autopay, statement, dividend and balance questions with their buttons |
| 8d | Commands and linking (T19, T20): the command menu, /help, /inbox, /undo, /start when linked, the linked reply |

Each is built test first against the bot's own harness (no real Telegram
message is ever sent), reviewed fresh, and merged on the word. 8b's
migration is applied on "apply and merge", as before.

## Not in this phase

- How the AI reads a message, and what it records: only what the bot says
  and the buttons it offers change.
- Per-person alerts (decision 6).
