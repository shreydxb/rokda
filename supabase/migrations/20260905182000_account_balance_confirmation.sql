-- QA-02 (SHR-243): an unentered balance was indistinguishable from a verified
-- zero.
--
-- `balance` defaults to 0, so a newly added account reads as "AED 0" and a
-- credit card reads "Nothing owed" — statements the household never made. The
-- model is, and stays, a MANUAL SNAPSHOT: a balance is whatever a member last
-- confirmed it to be, as of a date. It is deliberately NOT derived from an
-- opening balance plus transactions; mixing the two silently would be worse
-- than either.
--
-- balance_as_of records when someone last confirmed the number. Null means
-- nobody has: the figure is unknown, not zero.

alter table accounts add column balance_as_of timestamptz;

create index accounts_balance_as_of_idx on accounts (balance_as_of);

comment on column accounts.balance is
  'Manual snapshot, in AED. Meaningful only together with balance_as_of — never derived from transactions.';
comment on column accounts.balance_as_of is
  'When a household member last confirmed this balance. Null means unconfirmed: the balance is unknown, not zero.';
