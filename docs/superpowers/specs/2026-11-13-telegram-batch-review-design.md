# Telegram batch review — design

## Why

Bank SMS are pasted a week's worth at a time. Today a message with several
entries always goes to the Inbox, so every paste ends in a trip to the app.
The household wants to finish a paste where it was sent.

## What it does

After a paste with two or more entries, the bot replies with a numbered list
of the entries it read in full, and takes three kinds of reply to that list:

```
all on 2 Oct        record every listed entry on that date
1-5, 7 on 2 Oct     record those; the rest wait in the Inbox
drop 4              set entry 4 aside (as "Not a spend" does)
```

Example list:

```
Got 6 from that message. Reply to this to record them:
1. AED 20.00 · City Taxi · Bank card · Transport
2. AED 45.50 · Corner Shop · Bank card · Groceries
3. AED 120.00 · Pharmacy · Bank card · Health
No date in the SMS: say the day they were paid, like "all on 2 Oct".
2 more are already recorded (City Taxi, AED 20.00; Shop, AED 30.00), left out.
1 needs a look in the Inbox (no category).
```

- **A date is required whenever a listed entry had none.** Words taken: a day
  and month ("2 Oct", "2/10"), "today", "yesterday". Never a future day.
  When every listed entry had its date, "all" alone is enough, and a date
  given is refused rather than applied over the SMS's own.
- **What is listed:** entries read in full (merchant, amount, account,
  category, AED). Entries already recorded (lib/alreadyRecorded.js) are left
  out and named. Entries missing something are named as waiting in the
  Inbox. Up to 20 are numbered; any more wait in the Inbox, and the list
  says so.
- **After a reply,** the bot says what it did: recorded N on the date, set
  aside M, and any that another member or the Inbox had settled already.
  Entries not named stay in the Inbox as they are.

## Goals and limits

- Goal: a paste can be finished in Telegram, the common case in one reply.
- Not in Telegram: changing a category, amount, account or merchant. Those
  stay in the Inbox.
- Must never happen: a reply recording an amount it never showed; an entry
  recorded on a guessed date; one member's reply acting on the other's list;
  an entry recorded twice.
- A single-entry message keeps today's "reply yes" prompt.

## Approaches

1. **Link each listed entry to the list message** (chosen). Each entry's
   `confirm_chat_id` and `confirm_message_id` are set to the list, as the
   single-entry prompt already does for one entry. A reply to the list finds
   its entries in order. No database change.
2. A bot proposal of a new kind holding the list: cleaner separation, but a
   migration and the database's proposal function for little gain.
3. Act on the member's latest list with no link: simplest, but acts on the
   wrong batch after two pastes.

## Calls made in building it

- **How a reply finds its list.** Only a reply to the list message, from the
  member who pasted it. An unaddressed "all on 2 Oct" is answered with "reply
  to the list", so a second paste can never take it.
- **The existing lookup.** `intakeForPrompt` expects one entry per prompt. A
  prompt with several entries is a list; a bare "yes" to a list is answered
  with how to reply, never taken as "all".
- **Approving.** Each entry through `approve_intake`, as the Inbox does, with
  the date marked confirmed only when the person gave it. Entries no longer
  pending are skipped and counted. Setting aside updates only a pending
  entry.
- **Numbers** refer to the list as sent; a number not on it is refused, with
  nothing done.

## Left to the builder

The exact wording of replies, the date reader's details, and the tests.
