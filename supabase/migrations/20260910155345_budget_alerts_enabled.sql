-- The nightly budget-alert check (runBudgetAlertCheck in the Telegram edge
-- function) already nudges at 80%/90%/over-budget for every category with a
-- budget set -- it just had no way for a household to mute a specific
-- category's alerts. Defaults to on, since that's the behaviour that was
-- already live for everyone before this column existed.
alter table budgets add column alerts_enabled boolean not null default true;
