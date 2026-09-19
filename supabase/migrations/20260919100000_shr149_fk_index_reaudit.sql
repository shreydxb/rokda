-- SHR-149: re-audit of foreign-key access paths against the current v6
-- schema (Supabase's own performance advisor, 2026-09-19). Two uncovered
-- foreign keys, both on tables added after the last cleanup pass in
-- 20260913170137_rls_initplan_and_last_fk_index.sql -- neither existed at
-- the time, so neither was caught by it.

-- telegram_call_log.member_id references household_members(id) ON DELETE
-- SET NULL. Without a covering index, removing a member scans the whole
-- call log to find the rows to null out. Same reasoning as
-- transaction_edits_edited_by_idx: an append-only log that only grows, so
-- the index is cheapest added now.
create index telegram_call_log_member_id_idx on telegram_call_log (member_id);

-- unusual_spend_nudges.category_id references categories(id) ON DELETE
-- CASCADE. The table's primary key (household_id, category_id, year,
-- month) covers household_id-led lookups but not a bare category_id scan,
-- so deleting a category scans the whole table to find rows to cascade.
create index unusual_spend_nudges_category_id_idx on unusual_spend_nudges (category_id);

-- Deliberately NOT acted on here: the advisor's 18 "unused index" findings
-- across budgets/intake/accounts/categories/goals/recurring/transactions/
-- telegram_call_log. Every one of those indexes backs a real FK or a
-- household-scoped access path the app or its RLS policies actually use
-- (see the migrations that created them); pg_stat simply hasn't recorded
-- enough query volume yet to mark them used, because the whole project is
-- weeks old and holds a few hundred rows. Dropping them on that evidence
-- would be optimizing for a query shape that doesn't reflect real usage --
-- exactly what SHR-149 says not to do. Revisit only if the advisor still
-- flags them once there's meaningful traffic to judge by.
