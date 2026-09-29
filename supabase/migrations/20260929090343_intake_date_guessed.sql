-- A bank SMS or receipt with no date on it, pasted into the bot later, used to
-- be dated the day it was pasted and could be confirmed with a "yes" as if
-- that were the day it was paid. The bot now marks such a date as a guess:
-- the entry waits in the Inbox for the real date, and is never offered for a
-- one-word confirm or waved through in bulk.
alter table intake
  add column date_guessed boolean not null default false;

comment on column intake.date_guessed is
  'True when the message gave no date and parsed_date is the day it was forwarded or sent. The Inbox asks for the real date before approving.';
