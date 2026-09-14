-- SHR-282: the Telegram bot's own message parser never classified expense vs
-- income vs refund -- every Telegram-captured message was silently treated
-- as an expense downstream (confirmPendingIntake hardcoded p_kind: 'expense',
-- and the Inbox's quick-approve/bulk-approve actions did the same), even
-- though approve_intake and the manual "edit before approving" review form
-- have supported all three kinds since QA-11/SHR-252. A confidently-parsed
-- salary credit sent via Telegram and fast-confirmed with "yes" would have
-- been recorded as a negative AED expense with no human ever reviewing it.
--
-- This column lets the parser record its own classification so the rest of
-- the pipeline (fast-confirm, quick-approve, the edit form's initial
-- selection) can use it instead of assuming expense. Nullable, no default:
-- an existing or future row that never gets classified (e.g. a manual entry
-- with no parser involved) falls back to 'expense' in application code,
-- exactly matching today's behavior -- this migration changes no existing
-- row's meaning.
alter table intake
  add column parsed_kind text check (parsed_kind in ('expense', 'income', 'refund'));
