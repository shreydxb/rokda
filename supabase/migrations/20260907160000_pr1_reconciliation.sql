-- Reconciles PR #1 (SHR-241 corrections: month close, refund handling, debt
-- payoff, migration fixes) into this branch. PR #1's own migration files use
-- a different filename/timestamp scheme (a full re-export, see its own
-- SHR-253 commit) and were never applied to production -- this migration
-- ports only the schema PR #1's frontend code actually depends on that this
-- branch doesn't already have. `intake.source_ref` and its unique index
-- already exist here (added by the Telegram intake migration) and are not
-- repeated.

-- QA-01 (SHR-242): removing an account could erase its transaction history.
-- An account can now be closed (archived) instead of deleted; a closed
-- account keeps its rows and transactions and stops being offered for new
-- entries. The FK becomes NO ACTION so the database itself refuses to
-- delete an account that still has transactions.
alter table accounts add column archived_at timestamptz;
alter table accounts add column closing_note text;
create index accounts_archived_at_idx on accounts (archived_at);

alter table transactions drop constraint transactions_account_id_fkey;
alter table transactions
  add constraint transactions_account_id_fkey
  foreign key (account_id) references accounts (id) on delete no action;

comment on column accounts.archived_at is
  'When the account was closed. Closed accounts keep their transactions and stop being offered for new entries.';
comment on column accounts.closing_note is
  'Optional free-text reason recorded when the account was closed.';

-- QA-02 (SHR-243): an unentered balance was indistinguishable from a
-- verified zero. `balance` is a manual snapshot; balance_as_of records when
-- someone last confirmed it. Null means unconfirmed -- unknown, not zero.
-- (An FD's balance is computed, not a manual claim -- it never gets a
-- balance_as_of stamp; see the FD accrual trigger, which is unaffected by
-- this column's addition.)
alter table accounts add column balance_as_of timestamptz;
create index accounts_balance_as_of_idx on accounts (balance_as_of);

comment on column accounts.balance is
  'Manual snapshot, in AED, for a non-FD account -- meaningful only together with balance_as_of, never derived from transactions. Computed automatically for type=fd (see compute_account_derived_fields).';
comment on column accounts.balance_as_of is
  'When a household member last confirmed this balance. Null means unconfirmed for a manual account; always null for an FD, whose value is computed rather than claimed.';

-- SHR-252 (QA-11 recheck): a refund and income both signed positive and
-- were indistinguishable once written. kind persists which one it actually
-- was so spend/income aggregates can net a refund against spend rather than
-- counting it as income.
alter table transactions add column kind text not null default 'expense' check (kind in ('expense', 'income', 'refund'));
update transactions set kind = case when amount < 0 then 'expense' else 'income' end;

comment on column transactions.kind is
  'What the money movement means: expense (left the account), income (arrived), or refund (came back on an earlier expense). Refunds are stored as a positive amount, like income, but must be netted against spend rather than counted as income.';

-- QA-11 (SHR-252): Inbox approval was neither atomic nor idempotent -- a
-- retry or two simultaneous reviewers could each insert a transaction.
-- transaction_id is both what approval produced and the idempotency key: an
-- already-approved row names its transaction and a retry returns it rather
-- than writing a second one.
alter table intake add column transaction_id uuid references transactions(id) on delete set null;
create unique index intake_transaction_id_key on intake (transaction_id) where transaction_id is not null;

comment on column intake.transaction_id is
  'The transaction this intake row was approved into. Null while pending or rejected.';

-- SECURITY INVOKER, so RLS still applies to the caller -- this adds
-- atomicity, not privilege. `for update` serialises two reviewers; the
-- second sees the row already approved and returns the existing
-- transaction rather than writing a second one.
create or replace function approve_intake(
  p_intake_id uuid,
  p_account_id uuid,
  p_amount numeric,
  p_occurred_at date,
  p_kind text default 'expense',
  p_category_id uuid default null,
  p_currency text default 'AED',
  p_merchant text default null,
  p_is_shared boolean default true,
  p_owner_member_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_intake intake;
  v_transaction_id uuid;
  v_signed numeric;
begin
  if p_kind not in ('expense', 'income', 'refund') then
    raise exception 'unknown intake kind %', p_kind using errcode = '22023';
  end if;
  if p_account_id is null then
    raise exception 'an account is required' using errcode = '22023';
  end if;
  if p_amount is null or p_amount = 0 then
    raise exception 'an amount is required' using errcode = '22023';
  end if;
  -- No native-currency conversion for transactions yet (accounts/holdings
  -- have it; a manually-approved intake row does not) -- refused rather
  -- than accepted and misread as AED (SHR-252).
  if upper(coalesce(p_currency, 'AED')) <> 'AED' then
    raise exception 'only AED is supported for approval right now' using errcode = 'P0001';
  end if;

  select * into v_intake from intake where id = p_intake_id for update;
  if not found then
    raise exception 'intake row % not found', p_intake_id using errcode = 'P0002';
  end if;

  if v_intake.status = 'approved' then
    return jsonb_build_object('transaction_id', v_intake.transaction_id, 'already_approved', true);
  end if;
  if v_intake.status = 'rejected' then
    raise exception 'intake row % was already rejected', p_intake_id using errcode = 'P0001';
  end if;

  v_signed := case when p_kind = 'expense' then -abs(p_amount) else abs(p_amount) end;

  insert into transactions (
    household_id, account_id, category_id, amount, currency, kind, merchant,
    occurred_at, is_shared, owner_member_id, needs_review
  )
  values (
    v_intake.household_id, p_account_id, p_category_id, v_signed, 'AED', p_kind,
    nullif(btrim(p_merchant), ''), p_occurred_at, coalesce(p_is_shared, true), p_owner_member_id, false
  )
  returning id into v_transaction_id;

  update intake
     set status = 'approved',
         transaction_id = v_transaction_id
   where id = p_intake_id;

  return jsonb_build_object('transaction_id', v_transaction_id, 'already_approved', false);
end;
$$;

comment on function approve_intake is
  'Approves a pending intake row into exactly one transaction. Idempotent: an already-approved row returns its existing transaction. AED-only: refuses a non-AED currency rather than storing an unconverted amount as if it were AED.';

-- QA-04 (SHR-245) / SHR-254 recheck: `last_refreshed` conflated "priced" with
-- "record touched" -- reloading Investments or renaming a holding falsely
-- certified a stale valuation as current. priced_at is the correct name for
-- what staleness must actually mean; last_refreshed is kept, deprecated, for
-- any client still writing it, synced one-directionally so a genuine
-- priced_at write also updates it but never the reverse.
alter table holdings add column priced_at timestamptz;

comment on column holdings.priced_at is
  'When the stored value/price was last confirmed as of. Advances only when a valuation is entered and confirmed, or the price-refresh feed writes a fresh price -- never by reloading the screen or editing a name. See holdings_sync_priced_at().';
comment on column holdings.last_refreshed is
  'Deprecated in favour of priced_at -- kept only for a client that still writes it. Do not read from this column in new code.';

update holdings set priced_at = last_refreshed where last_refreshed is not null;

create or replace function holdings_sync_priced_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.priced_at is not null and new.last_refreshed is null then
      new.last_refreshed := new.priced_at;
    end if;
    return new;
  end if;

  if new.priced_at is distinct from old.priced_at then
    new.last_refreshed := new.priced_at;
  end if;
  return new;
end;
$$;

create trigger holdings_sync_priced_at_trigger
  before insert or update on holdings
  for each row
  execute function holdings_sync_priced_at();

comment on function holdings_sync_priced_at is
  'One-directional compatibility shim: a priced_at write is also copied onto last_refreshed for any remaining legacy reader. A last_refreshed write alone never moves priced_at.';
