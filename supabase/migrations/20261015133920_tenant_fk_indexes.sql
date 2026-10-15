-- Covering indexes for the last four tenant-qualified foreign keys
-- (Supabase performance advisor, 15 October 2026 QA review).
--
-- Each of these foreign keys is (household_id, <member or account>), added
-- after the last re-audit (20260919100000_shr149_fk_index_reaudit.sql), and
-- none has an index leading with those two columns. Removing a household
-- member, or an account, then scans the whole table to find the rows to
-- null out or cascade. The tables are small today; the indexes are cheapest
-- added now, and a behaviour test now fails on any foreign key left without
-- one, so the next table cannot slip past the advisor unnoticed.
--
-- categories_owner_member_id_idx (owner_member_id only, partial) stays: it
-- is not used for the foreign key, but dropping it is a separate decision
-- and nothing here needs it gone.

create index categories_household_owner_idx on categories (household_id, owner_member_id);
create index household_notes_household_updated_by_idx on household_notes (household_id, updated_by);
create index statement_reconciliations_household_account_idx on statement_reconciliations (household_id, account_id);
create index statement_reconciliations_household_closed_by_idx on statement_reconciliations (household_id, closed_by_member_id);
