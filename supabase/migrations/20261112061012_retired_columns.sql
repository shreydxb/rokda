-- Retired columns and redundant indexes (the round 2 cleanup, SHR-383;
-- docs/decisions.md, "Retired columns and indexes go"). Nothing in the app,
-- the bot or the database's functions reads or writes these columns; most
-- were left in place, unread, when the feature that used them changed.
-- Tested in supabase/test/migration-behaviour.test.sql ("Retired columns and
-- indexes").

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

-- The withdrawal rate fed only the 25x target, and Forecast's baseline only
-- Forecast; neither has been asked for or set since the five Planning tabs.
-- The debt plan stopped asking about new spend on a card, since its answer
-- changed nothing (Planning audit, 1.4). Their range checks go with them.
alter table public.planning_assumptions
  drop column safe_withdrawal_pct,
  drop column custom_safe_withdrawal_pct,
  drop column debt_assume_no_new_card_spend,
  drop column baseline_nominal_return_pct,
  drop column baseline_inflation_pct,
  drop column baseline_monthly_saving,
  drop column baseline_set_at;

-- An optional reason for closing an account, which nothing asks for or shows.
alter table public.accounts drop column closing_note;

-- A statement is compared with what Rokda holds when it is shown, so the
-- copy kept here is never written; and the bot keeps each question with
-- its chat (asked_prompts, "A statement answer belongs to the chat it was
-- asked in"), not by message id alone.
alter table public.statement_reconciliations
  drop column rokda_spend,
  drop column asked_message_ids;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Each of these is a single column that another full index on the same
-- table already leads with: a unique key, or the (household_id, ...) index
-- each of the household's foreign keys has. The planner uses that one
-- instead, for reads and for the check when a referenced row is removed.
drop index public.household_members_household_id_idx;
drop index public.categories_household_id_idx;
drop index public.accounts_household_id_idx;
drop index public.transactions_household_id_idx;
drop index public.recurring_household_id_idx;
drop index public.budgets_household_id_idx;
drop index public.intake_household_id_idx;
drop index public.net_worth_snapshots_household_id_idx;
drop index public.holdings_household_id_idx;
drop index public.goals_household_id_idx;
drop index public.debts_household_id_idx;
drop index public.category_rules_household_id_idx;
drop index public.independence_income_household_id_idx;
-- (holding_id, as_of) is unique, and leads with the holding.
drop index public.holding_value_history_holding_id_idx;
-- holding_trades_proposal_idx stays: the unique index on proposal_id is
-- partial, and a foreign key's index is a full one (the "fk indexes" test).
