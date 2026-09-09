-- Generalises "every quarter"/"every year" into "every N of this unit" --
-- cadence alone couldn't express a genuinely bi-monthly bill (this
-- household's real rent, paid every 2 months) without misusing "quarterly"
-- or hand-editing next_due_date every other cycle.
alter table recurring add column interval_count int not null default 1 check (interval_count >= 1);
