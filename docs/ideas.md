# Ideas not yet scheduled

Things worth doing that have no Linear issue yet, usually because the free-tier
issue cap is full. Grounded in what the code actually does today, so picking one
up does not start with re-discovery.

## Telegram activity log: messages, replies, nudges, token usage and cost

A page in the app showing everything that has gone through Telegram — messages
in, replies out, proactive notifications, with timestamps — plus AI token usage
and what each call cost.

Priority: low. Raised 13 Sep 2026 as a "something just came to mind".

### What exists today

Nothing close to a transcript:

- `household_members.telegram_last_question` / `telegram_last_answer` hold only
  the **single most recent** exchange, overwritten each time. The column comment
  says so outright: *"Not a full transcript."*
- The three nudge tables (`recurring_nudges`, `credit_card_nudges`,
  `budget_alert_nudges`) record only `sent_at` plus the key they de-duplicate
  on. They exist to stop repeat nagging, so they record *that* a nudge went out,
  not what it said.
- `intake` holds messages that became expense candidates — not questions, not
  answers, and nothing the parser rejected.

So outbound nudges are partially recoverable, conversation is not, and a message
the parser threw away leaves no trace at all.

### The cost half is nearly free

The webhook calls OpenRouter (`https://openrouter.ai/api/v1/chat/completions`,
model `google/gemini-2.5-flash-lite`) from three places: receipt/message
parsing, and two in the assistant path.

All three read only `body.choices[0].message.content` and discard the rest.
`body.usage` — the standard OpenAI-compatible `prompt_tokens` /
`completion_tokens` / `total_tokens` — is already in the response and thrown
away. OpenRouter can also report a per-call cost; confirm the current opt-in
against their docs rather than assuming it.

The token and cost data therefore does not need deriving or estimating. It needs
capturing at three call sites.

### Rough shape

1. A `telegram_events` table: household, member, direction (inbound / reply /
   nudge), kind, the text, `created_at`, and for AI calls the model, prompt and
   completion tokens, and cost. Household-scoped with RLS and a tenant-qualified
   foreign key like everything else (see the composite-key work of 13 Sep).
2. Record at the three OpenRouter call sites and wherever `reply()` sends.
3. A Settings or Activity sub-page listing it newest-first, with per-day and
   per-month cost roll-ups.

### Deliberately not doing

**No estimated costs.** If a call did not report usage, the row says unknown
rather than guessing — the same no-fabrication rule the rest of Rokda follows
about financial data. A made-up cost figure is worse than a blank one.

Retention deserves a decision before building: a full transcript of household
finance chat is sensitive, and "keep everything forever" should be a choice
rather than a default.

### Related

Receipt-photo intake is **already built** (`imageBase64` / `imageMime`, photo
handling in the webhook) but has never actually been used. If that starts being
used this log gets more valuable — image parses are the expensive calls, and the
ones most likely to need reviewing after the fact.
