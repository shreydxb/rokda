-- Whether the household has saved its own planning assumptions: the return,
-- inflation and withdrawal rate. The row can't say. The database fills those
-- columns with its defaults whenever any editor first creates it (the life
-- plan, the debt plan), so 6%, 2.5% and 4% read as "Your saved assumptions"
-- when nobody had chosen them (docs/decisions.md, "Defaults are called
-- defaults"; Planning audit, 1.3). The assumptions drawer sets this when it
-- saves Baseline.
--
-- A baseline was only ever taken by that save, so a row with one has saved.

alter table planning_assumptions add column assumptions_saved_at timestamptz;

update planning_assumptions set assumptions_saved_at = baseline_set_at where baseline_set_at is not null;
