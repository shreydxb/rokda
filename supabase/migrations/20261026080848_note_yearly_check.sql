-- A note that is checked once a year (docs/decisions.md, "A yearly check is a
-- note"; Planning audit, 4.18). Insurance, wills and nominations go unlooked
-- at because nothing asks. The household writes what to check in a note in
-- Planning -> Notes and marks it to be checked once a year; Overview asks for
-- it a year after it was last checked, or straight away if it never has been.
-- No new table: the note is the reminder's text.

alter table household_notes
  add column check_yearly boolean not null default false,
  add column checked_on date;

comment on column household_notes.check_yearly is 'Checked once a year: Overview asks for it a year after checked_on, or at once if never checked.';
comment on column household_notes.checked_on is 'The household day the note was last marked checked. Null if never.';
