-- Performance advisor cleanup: hoist per-row auth calls, index the last
-- uncovered foreign key. No authorisation boundary changes here -- every
-- policy below is rewritten to the same condition it already expressed.

-- 1. The last unindexed foreign key.
--
-- transaction_edits.edited_by references household_members(id) ON DELETE SET
-- NULL. Without a covering index, removing a member scans the whole edit log
-- to find the rows to null out. The table is empty today, which is exactly
-- when adding the index is free; it is an append-only audit trail, so it only
-- ever grows.
create index transaction_edits_edited_by_idx on transaction_edits (edited_by);

-- 2. auth.uid() / auth.role() evaluated once per statement, not once per row.
--
-- PostgreSQL treats a bare auth.uid() in a policy as a per-row expression and
-- re-evaluates it for every candidate row. Wrapping it in a scalar subquery
-- makes it an InitPlan: evaluated once, then reused. Both functions are
-- STABLE, so the value cannot change within a statement and the result is
-- identical either way -- this is purely how often it is computed.
--
-- Only the auth call moves. is_household_owner(household_id) takes a
-- row-dependent argument and genuinely has to run per row, so it stays as it
-- is; hoisting it would change what the policy means.
--
-- Each policy is dropped and recreated because a policy's expression cannot
-- be altered in place. The conditions are otherwise character-for-character
-- what they were.

drop policy "authenticated users can read fx rates" on fx_rates;
create policy "authenticated users can read fx rates" on fx_rates
  for select using ((select auth.role()) = 'authenticated');

drop policy "owners manage the roster, members manage themselves" on household_members;
create policy "owners manage the roster, members manage themselves" on household_members
  for update
  using (is_household_owner(household_id) or user_id = (select auth.uid()))
  with check (is_household_owner(household_id) or user_id = (select auth.uid()));

drop policy "owners remove members, members can leave" on household_members;
create policy "owners remove members, members can leave" on household_members
  for delete
  using (is_household_owner(household_id) or user_id = (select auth.uid()));

-- Deliberately NOT done here: moving pg_net out of the public schema.
--
-- The advisor flags it (lint 0014), and the fix is not the one-liner it looks
-- like. pg_net is not relocatable (pg_extension.extrelocatable = false), so
-- ALTER EXTENSION ... SET SCHEMA is refused outright; the only route is DROP
-- and CREATE. All three scheduled jobs -- daily-fd-accrual,
-- daily-recurring-nudge-check and weekday-price-refresh -- call net.http_post
-- from their bodies, so a drop/recreate risks leaving the FD accrual, the
-- price feed and the Telegram nudges silently doing nothing, which is the
-- failure mode nobody notices for a week.
--
-- What the advisor is actually reporting is the schema the extension is
-- REGISTERED in. All 12 of its functions live in the `net` schema, not in
-- public, so there is no public-facing surface to remove. The finding is
-- cosmetic here and the remediation is not: the risk runs the wrong way, so
-- it stays until there is a reason to touch pg_net for its own sake.
