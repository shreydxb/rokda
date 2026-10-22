-- The planning editors now refuse what makes no sense as a plan, and the
-- database refuses the same, so a figure that reaches the table from anywhere
-- is one the screens can work with (docs/decisions.md, "Planning editors check
-- what they save"; Planning audit, 0b-C).
--
-- Before this, the assumptions drawer saved a cleared field as 0% and took any
-- number: a 0% withdrawal rate made the independence target 0, inflation of
-- -100% made every projection infinite, and 1,000% overflowed the column with
-- Postgres's own error. A debt saved with its rate or minimum blank was stored
-- as 0. The after-work return and a goal's rise were already checked; these
-- use the same ranges.
--
-- Each check is added NOT VALID and then validated, so existing rows are
-- checked without holding the table locked while they are.

alter table planning_assumptions
  add constraint planning_assumptions_return_range check (nominal_return_pct between -20 and 50) not valid,
  add constraint planning_assumptions_custom_return_range check (custom_nominal_return_pct is null or custom_nominal_return_pct between -20 and 50) not valid,
  add constraint planning_assumptions_baseline_return_range check (baseline_nominal_return_pct is null or baseline_nominal_return_pct between -20 and 50) not valid,
  add constraint planning_assumptions_inflation_range check (inflation_pct between -10 and 30) not valid,
  add constraint planning_assumptions_custom_inflation_range check (custom_inflation_pct is null or custom_inflation_pct between -10 and 30) not valid,
  add constraint planning_assumptions_baseline_inflation_range check (baseline_inflation_pct is null or baseline_inflation_pct between -10 and 30) not valid,
  add constraint planning_assumptions_withdrawal_range check (safe_withdrawal_pct between 1 and 10) not valid,
  add constraint planning_assumptions_custom_withdrawal_range check (custom_safe_withdrawal_pct is null or custom_safe_withdrawal_pct between 1 and 10) not valid,
  -- A lean target of nothing would read as independence already reached.
  add constraint planning_assumptions_lean_spend_positive check (lean_annual_spend is null or lean_annual_spend > 0) not valid,
  -- 0 is a choice Debt payoff shows as committing nothing; below it is none.
  add constraint planning_assumptions_debt_extra_nonnegative check (debt_extra_payment is null or debt_extra_payment >= 0) not valid;

alter table planning_assumptions validate constraint planning_assumptions_return_range;
alter table planning_assumptions validate constraint planning_assumptions_custom_return_range;
alter table planning_assumptions validate constraint planning_assumptions_baseline_return_range;
alter table planning_assumptions validate constraint planning_assumptions_inflation_range;
alter table planning_assumptions validate constraint planning_assumptions_custom_inflation_range;
alter table planning_assumptions validate constraint planning_assumptions_baseline_inflation_range;
alter table planning_assumptions validate constraint planning_assumptions_withdrawal_range;
alter table planning_assumptions validate constraint planning_assumptions_custom_withdrawal_range;
alter table planning_assumptions validate constraint planning_assumptions_lean_spend_positive;
alter table planning_assumptions validate constraint planning_assumptions_debt_extra_nonnegative;

-- A debt's balance is stored as the amount owed. A 0% rate and a 0 minimum
-- are real (an interest-free instalment, a loan from family), so 0 is allowed.
alter table debts
  add constraint debts_balance_nonnegative check (balance >= 0) not valid,
  add constraint debts_apr_range check (apr_pct between 0 and 100) not valid,
  add constraint debts_minimum_nonnegative check (minimum_payment >= 0) not valid;

alter table debts validate constraint debts_balance_nonnegative;
alter table debts validate constraint debts_apr_range;
alter table debts validate constraint debts_minimum_nonnegative;
