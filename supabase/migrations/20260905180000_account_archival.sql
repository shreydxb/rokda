-- QA-01 (SHR-242): removing an account could erase its transaction history.
--
-- transactions.account_id was ON DELETE CASCADE, so deleting a card or account
-- deleted every transaction ever recorded on it. A household ledger must not
-- have a one-click path that destroys history.
--
-- Two changes:
--   1. Accounts can be closed (archived) instead of deleted. A closed account
--      keeps its rows, keeps its transactions, and stops appearing as a choice
--      for new entries.
--   2. The cascade becomes NO ACTION, so the database itself refuses to delete
--      an account that still has transactions. NO ACTION rather than RESTRICT
--      deliberately: it is checked at end of statement, so deleting a whole
--      household still cascades cleanly (households cascade to both tables in
--      one statement), while a plain account delete with history now errors.

alter table accounts add column archived_at timestamptz;
alter table accounts add column closing_note text;

create index accounts_archived_at_idx on accounts (archived_at);

comment on column accounts.archived_at is
  'When the account was closed. Closed accounts keep their transactions and stop being offered for new entries.';
comment on column accounts.closing_note is
  'Optional free-text reason recorded when the account was closed.';

alter table transactions drop constraint transactions_account_id_fkey;

alter table transactions
  add constraint transactions_account_id_fkey
  foreign key (account_id) references accounts (id) on delete no action;
