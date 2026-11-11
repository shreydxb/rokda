# Ideas not yet scheduled

Things worth doing that have no Linear issue yet, usually because the free-tier
issue cap is full. Grounded in what the code actually does today, so picking one
up does not start with re-discovery.

## Telegram activity log: messages, replies, nudges, and cost

A page in the app showing everything that has gone through Telegram — messages
in, replies out, proactive notifications, with timestamps — and what each AI
call cost.

Priority: low. Raised 13 Sep 2026 as a "something just came to mind";
narrowed 11 Nov 2026, once AI calls were logged.

### What exists today

AI calls are logged: `telegram_call_log` (SHR-288) holds one row per call, with
its kind, model, prompt, completion and total tokens, latency and outcome, and
Settings → Telegram shows the household's calls and tokens. It deliberately
holds no prompt or reply text, and no cost.

Nothing close to a transcript:

- `household_members.telegram_last_question` / `telegram_last_answer` hold only
  the **single most recent** exchange, overwritten each time. The column comment
  says so outright: *"Not a full transcript."*
- The reminder tables (`recurring_nudges`, `credit_card_nudges`,
  `budget_alert_nudges`, `brief_sends` and the rest) record only that a reminder
  went out, and the key they de-duplicate on, not what it said.
- `intake` holds messages that became expense candidates — not questions, not
  answers, and nothing the parser rejected.

So outbound nudges are partially recoverable, conversation is not, and a message
the parser threw away leaves no trace at all.

### What is left

1. **Cost.** OpenRouter can report a per-call cost alongside `usage`; confirm the
   current opt-in against their docs rather than assuming it, and add a `cost`
   column to `telegram_call_log` at the call sites that already record tokens.
2. **A transcript.** A `telegram_events` table: household, member, direction
   (inbound / reply / nudge), kind, the text, `created_at`. Household-scoped
   with RLS and a tenant-qualified foreign key like everything else. Recorded
   wherever `reply()` sends and where a message arrives.
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
