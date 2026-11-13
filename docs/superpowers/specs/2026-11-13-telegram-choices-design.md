# Choosing a missing category or card in Telegram — design

## Why

An entry the bot could not finish (no category, or no card matched) waits in
the Inbox, so a paste or a typed expense often ends in a trip to the app for
one tap. The batch list now names these ("1 needs a look in the Inbox (no
category)"); this lets them be finished where they were sent.

## What it does

When an entry is missing **only** its category or its card, the bot asks
with buttons under its reply:

```
AED 30.00 at Corner Bakery (Bank card). Which category?
[ Food & Dining › Eating Out ] [ Groceries ] [ Shopping ]
[ Food & Dining › Food Delivery ] [ Transport › Taxi ] [ In the Inbox ]
```

- **Category:** the six categories this merchant, then the household, used
  most (subcategories only, as the pickers now offer), plus "In the Inbox".
- **Card:** the household's cards and accounts that take spending, up to
  eight, plus "In the Inbox". A card the sender owns comes first.
- **After a tap:** the choice is saved on the entry, and the message turns
  into the usual prompt: "AED 30.00 at Corner Bakery (Bank card, Groceries)
  on 12 Nov. Reply "yes" to record it." If the entry still has no date from
  the SMS, it says so and asks for the day the same way as now.
- **Missing both:** the category is asked first, then the card.
- **A batch paste:** up to three entries waiting for a category or card are
  asked about after the list, one message each; any more stay in the Inbox,
  as now.
- **A tap never records the expense.** The "yes" still does, so the person
  sees the whole entry before it counts.

## Goals and limits

- Must never happen: a tap from the other member, or on an entry already
  approved or set aside, changing it; a category or account from another
  household; a guessed date recorded.
- Not in Telegram: changing the amount or merchant; making a new category.
- A tap's button data is kept under Telegram's 64-byte limit by writing the
  entry's and the choice's ids compactly; every tap is checked against the
  database (the member, the household, the entry still pending), never
  trusted from the button.

## Approaches

1. **Buttons carrying both ids** (chosen): no database change. Telegram's
   callback is checked in full on each tap.
2. A saved "question" row per message, the button carrying only its number:
   a migration for no gain over 1.
3. Numbered replies ("reply 2 for Groceries"): no setup change, but slower
   and easy to mistype.

## Setup after the merge

Telegram only sends button taps to a bot that asked for them. After the
bot is deployed, its webhook is registered once more with button taps
allowed (the existing setup call, with "callback_query" added). That is one
call against production, done only with your go-ahead. Until then the
buttons show but do nothing, and the Inbox works as before.

## Left to the builder

The wording, the exact ranking of categories, and the tests.
