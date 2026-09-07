-- SHR-252 (QA-11 recheck): refund and currency meaning.
--
-- approve_intake derived a sign from p_kind and then discarded p_kind itself.
-- A refund (money returning on an earlier expense) and income (money
-- arriving) both signed positive and became indistinguishable once written:
-- periodSummary counted an AED 100 refund as AED 100 of income, and budget
-- spend was never reduced by it. Persisting the kind is what lets the
-- application tell them apart again.
--
-- Currency: the RPC stored whatever currency string was entered alongside an
-- amount that every aggregate calculation treats as AED, with no conversion.
-- Native-currency conversion isn't implemented yet, so this makes AED-only
-- explicit and enforced here rather than silently mixing units — changing
-- Currency to USD in the UI must not be able to store amount 100/currency USD
-- while dashboards keep reading it as AED 100.

alter table transactions add column kind text not null default 'expense' check (kind in ('expense', 'income', 'refund'));

comment on column transactions.kind is
  'What the money movement means: expense (left the account), income (arrived), or refund (came back on an earlier expense). Refunds are stored as a positive amount, like income, but must be netted against spend rather than counted as income.';

-- Backfill: existing rows only ever encoded expense/income via sign — there
-- is no way to recover which positive rows were actually refunds after the
-- fact. They are left as 'income', the same meaning they had before this
-- migration; only newly approved refunds get the correct kind.
update transactions set kind = case when amount < 0 then 'expense' else 'income' end;

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
  -- No native-currency conversion exists yet. Storing a non-AED amount as if
  -- it were AED would silently corrupt every dashboard total, so this is
  -- refused rather than accepted and misread (SHR-252).
  if upper(coalesce(p_currency, 'AED')) <> 'AED' then
    raise exception 'only AED is supported for approval right now' using errcode = 'P0001';
  end if;

  select * into v_intake from intake where id = p_intake_id for update;
  if not found then
    raise exception 'intake row % not found', p_intake_id using errcode = 'P0002';
  end if;

  -- Already done: return what was written. This is what makes a retry, a lost
  -- response, and a simultaneous approval all yield exactly one transaction.
  if v_intake.status = 'approved' then
    return jsonb_build_object('transaction_id', v_intake.transaction_id, 'already_approved', true);
  end if;
  if v_intake.status = 'rejected' then
    raise exception 'intake row % was already rejected', p_intake_id using errcode = 'P0001';
  end if;

  -- Money movement is explicit rather than inferred from a sign: an expense
  -- leaves, income and a refund arrive. The kind itself is now persisted too
  -- (below), so a refund stays distinguishable from income after the fact.
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
