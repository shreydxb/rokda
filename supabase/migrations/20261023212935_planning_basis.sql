-- The basis every planning figure is worked out on, chosen by the household
-- rather than by the app (docs/decisions.md, "The household chooses the
-- basis"; Planning audit, 2.9).
--
-- The plan used the budget until three months had ended and then switched to
-- the recorded months on its own, though a household's first months are
-- partial and its records can run well ahead of the plan it wrote down.
--
-- planning_basis: 'budget' or 'recorded'; blank is not chosen, which keeps
-- the old rule (the budget until three months have ended, then the records).
-- records_from: the first month the records count from, as its first day;
-- blank counts every recorded month.

alter table planning_assumptions
  add column planning_basis text,
  add column records_from date,
  add constraint planning_assumptions_basis check (planning_basis is null or planning_basis in ('budget', 'recorded')),
  add constraint planning_assumptions_records_from_month check (records_from is null or extract(day from records_from) = 1);
