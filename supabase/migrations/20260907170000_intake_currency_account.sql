-- The AI parser only ever extracted merchant/amount/date/category -- it
-- never asked about currency or account, so both silently defaulted at
-- approval time: currency to AED regardless of what was actually spent (a
-- foreign-currency card charge would be recorded as if it were the same
-- number in AED), and account to whichever happened to be first in the
-- list. This makes both a first-class part of what gets parsed and stored,
-- so the review screen can flag a mismatch instead of hiding it.
alter table intake
  add column parsed_currency text,
  add column parsed_account_id uuid references accounts(id) on delete set null;

comment on column intake.parsed_currency is 'Currency the AI detected in the raw message/photo (e.g. from a bank SMS or an explicit "usd"), or null if unstated. Never assumed to be AED -- the review screen must flag anything other than AED or null, since no currency conversion exists.';
comment on column intake.parsed_account_id is 'Account suggested from a card-ending match in the raw text (e.g. a bank SMS naming "card ending 1234" against an account named "...1234"), or null if none matched. Only a suggestion -- the reviewer still confirms it.';
