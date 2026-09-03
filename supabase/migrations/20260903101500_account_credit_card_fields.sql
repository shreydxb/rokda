-- Credit-card-specific fields, nullable since they're meaningless for
-- other account types. Statement/due day are day-of-month integers so the
-- app can compute "since last statement" without a full billing-cycle table.
alter table accounts
  add column credit_limit numeric(14, 2),
  add column statement_day int check (statement_day between 1 and 31),
  add column due_day int check (due_day between 1 and 31);
