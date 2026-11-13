# Telegram Batch Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a paste of several entries, the bot sends a numbered list, and a reply to it ("all on 2 Oct", "1-5, 7 on 2 Oct", "drop 4") records or sets aside those entries.

**Architecture:** The pure parts (reading a reply, writing the list) live in a new bot module `batch.ts`. Each listed entry is bound to the list message through the existing `intake.confirm_chat_id` / `confirm_message_id` columns, as the single-entry prompt binds one; a reply to a message bound to two or more entries is a list reply, handled in a new `batchReview.ts` before the single-entry lookup. No database change.

**Tech Stack:** Deno Edge Function (TypeScript), Supabase JS, the handler test harness `telegram-webhook/testing/harness.ts`.

**Spec:** `docs/superpowers/specs/2026-11-13-telegram-batch-review-design.md`

## Global Constraints

- A date is required whenever a listed entry had none; words taken: "2 Oct", "2/10" (day/month), "today", "yesterday". Never a future day.
- When every listed entry had its date, "all" alone is enough, and a date given is refused rather than applied over the SMS's own.
- Listed: entries read in full apart from the date (`isReadyForFastConfirm` with `date_guessed` set aside). Entries already recorded are left out and named; entries missing something are named as waiting in the Inbox.
- At most 20 numbered (`BATCH_LIST_CAP = 20`); any more wait in the Inbox, and the list says so.
- Only a reply to the list, from the member who pasted it, acts on it. An unaddressed batch command is answered "reply to the list"; a bare "yes" or 👍 to a list is answered with how to reply.
- Approving goes through `approve_intake`, `p_date_confirmed: true` only for an entry whose date the person gave; an entry no longer pending is skipped and counted. Setting aside updates only a pending entry.
- Not in Telegram: changing a category, amount, account or merchant.
- A message of one entry keeps today's "reply yes".
- The repository is public: test fixtures use generic merchants and round amounts.

## Review Focus

1. A list where some entries had their date and some did not: "all on 2 Oct" dates only the undated ones; the dated keep their own.
2. A reply naming a number that is not on the list, or "drop" with nothing after it: refused, nothing done.
3. The other member replying to the list: nothing done, as for any prompt of another member's.
4. "2 Oct" read late in the year for an earlier year ("28 Dec" in January): the latest such day not after today.
5. A list approved twice (Telegram delivers the reply again): the second reports them as already settled, nothing recorded twice.

---

### Task 1: Reading a reply and writing the list (`batch.ts`)

**Files:**
- Create: `supabase/functions/telegram-webhook/batch.ts`
- Test: `supabase/functions/telegram-webhook/batch.test.ts`

**Interfaces:**
- Produces:
  - `export const BATCH_LIST_CAP = 20`
  - `export type BatchCommand = { kind: "all"; date: string | null } | { kind: "some"; numbers: number[]; date: string | null } | { kind: "drop"; numbers: number[] }`
  - `export function parseBatchReply(text: string, today: string): BatchCommand | { kind: "invalid"; reason: string } | null` — null when the text is not a batch command at all.
  - `export function readBatchDate(words: string, today: string): string | null | "future"` — ISO day.
  - `export type ListedEntry = { amount: number; merchant: string; account: string; category: string; undated: boolean }`
  - `export function batchListMessage(listed: ListedEntry[], notes: { recorded: Array<{ merchant: string; amount: number }>; waiting: Array<{ merchant: string | null; reason: string }>; overCap: number }): string`

- [ ] **Step 1: Write the failing tests** (Deno.test, plain asserts)
  - `parseBatchReply("all on 2 Oct", "2026-10-09")` → `{ kind: "all", date: "2026-10-02" }`; `"all"` → `{ kind: "all", date: null }`; `"1-3, 5 on 2/10"` → `{ kind: "some", numbers: [1, 2, 3, 5], date: "2026-10-02" }`; `"drop 4"` → `{ kind: "drop", numbers: [4] }`; `"drop 2, 4"` → numbers `[2, 4]`; `"all today"` and `"all yesterday"` → the day and the day before.
  - `"all on 20 Oct"` with today `2026-10-09` → `{ kind: "invalid", reason }` (future); `"drop"` → invalid; `"spent 40 at cafe"` → null; `"yes"` → null.
  - `readBatchDate("28 Dec", "2027-01-05")` → `"2026-12-28"`.
  - `batchListMessage` with two undated entries and one recorded note: numbered lines `1. AED 20.00 · City Taxi · Bank card · Transport`, a line asking for the date (`like "all on 2 Oct"`), and `1 more is already recorded (City Taxi, AED 20.00), left out.`; with all entries dated, the instruction reads `Reply "all" to record them`.

- [ ] **Step 2: Run, expect FAIL** — `deno test --node-modules-dir=none --allow-env --allow-read telegram-webhook/batch.test.ts` from `supabase/functions`: module not found.

- [ ] **Step 3: Implement `batch.ts`** to the interfaces above. Numbers accept ranges and commas or spaces; duplicates collapse; order kept ascending. Dates: day and month (month as a word or number), the latest such day not after `today`.

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit** `Bot: read a reply to a batch list, and write the list`

### Task 2: Sending the list after a paste (`index.ts`)

**Files:**
- Modify: `supabase/functions/telegram-webhook/index.ts` (the capture loop and its reply, around the multi-item reply)
- Modify: `supabase/functions/telegram-webhook/intake.ts` (`alreadyRecordedNote` gives way to the list's own note for a multi-item paste; keep it for one entry)
- Test: `supabase/functions/telegram-webhook/batchReview.test.ts` (new handler-test file on the harness)

**Interfaces:**
- Consumes: Task 1's `batchListMessage`, `BATCH_LIST_CAP`; `alreadyRecordedAll` (applib); `isReadyForFastConfirm` (applib/telegramConfirm.js).
- Produces: each listed intake row has `confirm_chat_id` and `confirm_message_id` set to the list message; entries are listed in their capture order (`<update>`, `#1`, `#2`…).

- [ ] **Step 1: Write the failing tests**
  - "a paste of several entries is answered with a numbered list, each entry bound to it": three SMS items, all read in full and undated → the reply contains `1. AED`, `2. AED`, `3. AED` and `like "all on 2 Oct"`; every pending intake row has `confirm_message_id` equal to the list message's id.
  - "an entry already recorded, or missing a category, is named and not numbered": one item repeats a recorded transaction, one has no category → two numbered, the notes name both, neither of those rows is bound.
  - "more than 20 entries: 20 are numbered and the rest wait in the Inbox".
  - "one entry keeps the yes prompt": a single complete dated entry still gets `reply "yes"`.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** Read each item's saved row id (the first row's id is `inserted.id`; later inserts add `.select("id").single()`). After the loop, for two or more saved items: list those passing `isReadyForFastConfirm({ ...row, date_guessed: false })` and not matched by `alreadyRecordedAll`, up to the cap; send `batchListMessage` with `reply()`; bind the listed rows with one update `.in("id", ids)`. A failed send leaves them unbound and the reply says "check the Inbox", as today. The unsaved and dividend notes still follow.

- [ ] **Step 4: Run all bot tests, expect PASS.**

- [ ] **Step 5: Commit** `Bot: answer a paste of several entries with a numbered list`

### Task 3: Acting on a reply to the list (`batchReview.ts`)

**Files:**
- Create: `supabase/functions/telegram-webhook/batchReview.ts`
- Modify: `supabase/functions/telegram-webhook/index.ts` (before `intakeForPrompt`), `confirmations.ts` (`handleReaction`)
- Test: `supabase/functions/telegram-webhook/batchReview.test.ts`

**Interfaces:**
- Consumes: Task 1's `parseBatchReply`; Task 2's binding.
- Produces:
  - `export async function batchForPrompt(householdId: string, memberId: string, chatId: number, messageId: number | null): Promise<PendingIntakeRow[] | "failed">` — rows bound to that message for this member, in capture order; a list is two or more.
  - `export async function handleBatchReply(chatId: number, member: { id: string; household_id: string }, rows: PendingIntakeRow[], text: string, today: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**
  - "all on a date records every listed entry on it, each marked as confirmed": two undated listed → two `approve_intake` calls with `p_occurred_at` the date and `p_date_confirmed: true`; reply `Recorded 2 on 2 Oct.`
  - "some on a date records those, and the rest wait": `"1 on 2 Oct"` of two → one call; reply names 1 recorded and 1 still in the Inbox.
  - "drop sets an entry aside": `"drop 2"` → that row `rejected`, the other untouched.
  - "a list of dated entries takes all alone, and refuses a date given".
  - "a mixed list dates only the undated" (Review Focus 1).
  - "a number not on the list does nothing" (Review Focus 2).
  - "the other member's reply does nothing" (Review Focus 3): rows bound for member A, reply from member B → no call, the reply is the one for an unknown prompt.
  - "a reply delivered again records nothing twice" (Review Focus 5): second run → `already settled`.
  - "a bare yes, or a 👍, on the list says how to reply"; "an unaddressed all on 2 Oct with a list open says to reply to the list".

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** In `index.ts`, for text with a `reply_to_message`, call `batchForPrompt` first; two or more rows → `handleBatchReply` and return. For unaddressed text that `parseBatchReply` reads as a command, if the member has bound pending entries on a list → reply to the list hint. In `handleReaction`, a 👍 on a list message → the how-to-reply message. Approving: the arguments `confirmPendingIntake` sends, plus `p_occurred_at` (the date given for an undated row, the row's own otherwise) and `p_date_confirmed` (true only for an undated row given a date); a row no longer pending is skipped and counted. Drop: `update({ status: "rejected" }).eq("id", id).eq("status", "pending")`.

- [ ] **Step 4: Run all bot tests, expect PASS.**

- [ ] **Step 5: Commit** `Bot: record, or set aside, the entries of a list from a reply`

### Task 4: Docs, checks, review, PR

**Files:**
- Modify: `docs/decisions.md` (under "What the feature review changed"), `docs/features.md` (Telegram bot section)

- [ ] **Step 1:** Add the decision and the feature lines.
- [ ] **Step 2:** Run the checks in CLAUDE.md: eslint, vitest, build, `deno check` for every function, the bot tests, Playwright. Expected: all pass.
- [ ] **Step 3:** Fresh review of the branch; fix Important findings with a failing test first.
- [ ] **Step 4:** Push and open the PR.
