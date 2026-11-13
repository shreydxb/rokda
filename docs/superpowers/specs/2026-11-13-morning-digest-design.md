# Morning digest — design

## Why

The daily check sends each reminder as its own message: a bill due, a card
payment, a budget passed, cash cover, unusual spending. On a busy morning
that is several messages, and on the 1st the monthly review and the balance
check-in arrive separately. The household asked for fewer messages.

## What it does

The morning check gathers the reminders that need no answer into **one
message per person**, sent only when there is at least one line:

```
Good morning. 3 things today:
• Bills: Rent AED 5,000.00 due tomorrow; Internet AED 400.00 is 2 days late.
• Bank card: AED 1,250.00 due on 22 Nov (3 days).
• Groceries has passed 80% of its budget (AED 1,620 of 2,000).
```

- **What goes in:** bills due and late, card payments due, budget alerts,
  cash cover, unusual spending. Each line keeps its own rule for when it is
  due and its own record that it was sent, so a line appears on the days it
  would have been a message before, and never twice.
- **Who gets what:** each line goes to the people its message went to
  before. A personal card's payment goes to its owner, and a shared bill to
  both. Each person gets their own digest.
- **Mondays and the 1st:** the lines go at the end of the weekly brief, or of
  the monthly review, so that morning is still one message. On the 1st the
  monthly review and the balance check-in become one message per person. The
  check-in part keeps its own reply ("Bank 10,000 · Card 1,000 owed").
- **Questions stay separate:** autopay "was this paid?", dividends received,
  statement questions and the split question each need an answer tied to
  their own message, so they are not folded in.
- **Settings:** the existing switches (Settings → Telegram) still turn each
  kind of line on or off.

## Goals and limits

- Goal: at most one message a morning that needs no answer, per person.
- Must never happen: a reminder lost because another line failed; a line
  recorded as sent when its digest did not reach that person; one person's
  personal reminder in the other's digest.
- Not changed: what each reminder says or when it is due; the questions; the
  time of the daily check.

## Approaches

1. **Collect, then send** (chosen). Each reminder check returns its lines
   (text, who gets it, and how to record it sent) instead of sending. The
   morning run groups the lines by person, sends one digest each, and records
   a line once every person it was for received theirs; a line not delivered
   is tried again the next morning, as today.
2. A digest table written by each check and sent by a later job: a migration
   and a second schedule, for nothing approach 1 lacks.
3. Leave the checks and only delay sending: still one message per reminder.

## Left to the builder

The exact wording of the lines and the greeting, the order of the lines
(things late first), and the tests.
