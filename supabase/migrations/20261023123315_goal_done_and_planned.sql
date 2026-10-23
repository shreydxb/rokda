-- A goal can be marked done, and carries what the household plans to put
-- towards it each month (docs/decisions.md, "A goal can be done, and has a
-- plan"; Planning audit, 2.7).
--
-- Done: a goal reached or spent stayed on Goals, in Plan's checks, on the
-- Life plan's timeline and in the Telegram bot's list, and the only way out
-- was to delete it with its contributions. done_at says when, and null is
-- open; reopening clears it.
--
-- Planned monthly: Goals said what a goal needs each month but had nowhere to
-- record what the household means to put in, so a goal with a plan that
-- covers it was still raised as a decision on Plan. Null is no plan; 0 is a
-- plan of nothing, which is a choice the household can make.

alter table goals
  add column done_at timestamptz,
  add column planned_monthly numeric(14, 2),
  add constraint goals_planned_monthly_nonnegative check (planned_monthly is null or planned_monthly >= 0);
