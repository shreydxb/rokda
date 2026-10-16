-- Payments made in another currency keep that amount beside the AED actually
-- debited, and exchange rates keep their history (docs/decisions.md, "A payment
-- in rupees keeps both amounts"; SHR-321).
--
-- Money sent home is agreed in rupees and debited in dirhams. A transaction
-- could hold only the AED, so the rupee figure went into the note, and every
-- conversion used the latest rate because fx_rates keeps only the latest.
--
--   * transactions.currency now means the currency the payment was made in,
--     as recurring.currency already does, and native_amount is the amount in
--     it. amount stays the AED that counts everywhere, and an AED payment has
--     no native_amount. Every existing row is AED, so the rule holds for all
--     of them.
--   * aed_estimated marks an AED figure worked out from a rate because the
--     AED actually debited isn't known yet. It is replaced by the real figure
--     when it is, and the monthly review asks for it.
--   * fx_rate_history keeps one rate per day per pair, so a past payment is
--     estimated, and shown, at its own date's rate. The daily price refresh
--     writes it; before that, it starts from the latest rate on record.
--   * approve_intake takes the native amount too, so a rupee payment sent to
--     the bot keeps both figures through the Inbox. The function is replaced
--     with two more parameters, last and defaulted, so the bot's existing
--     calls still resolve; the eleven-parameter one is dropped, as PostgREST
--     cannot choose between the two for a call that leaves them out.

alter table transactions
  add column native_amount numeric(14, 2),
  add column aed_estimated boolean not null default false;

alter table transactions
  add constraint transactions_native_amount_currency check ((currency = 'AED') = (native_amount is null)),
  add constraint transactions_native_amount_sign check (native_amount is null or sign(native_amount) = sign(amount)),
  add constraint transactions_aed_estimated_native check (not aed_estimated or native_amount is not null);

comment on column transactions.currency is
  'The currency the payment was made in. amount is always AED; for anything else native_amount is the figure in this currency.';
comment on column transactions.native_amount is
  'The amount in transactions.currency, signed like amount, when that is not AED (a remittance agreed in rupees). Null for an AED payment.';
comment on column transactions.aed_estimated is
  'True while amount is an estimate from native_amount at a rate, because the AED actually debited is not known yet.';

create table fx_rate_history (
  base text not null,
  quote text not null,
  day date not null,
  rate numeric(14, 6) not null check (rate > 0),
  -- Where the day's rate came from: the daily refresh's feed, or the ECB
  -- reference rate a backfill read for a day before history began.
  source text not null,
  fetched_at timestamptz not null default now(),
  primary key (base, quote, day)
);

alter table fx_rate_history enable row level security;

-- Market rates are the same for every household, like fx_rates. Written only
-- by the price refresh (service role); anyone signed in reads them.
create policy "authenticated users can read fx rate history" on fx_rate_history
  for select using ((select auth.role()) = 'authenticated');

comment on table fx_rate_history is
  'One exchange rate per day per pair (units of quote per one base), so a past payment is converted at its own date''s rate. Written by the price-refresh Edge Function.';

-- Start from the latest rate on record, so there is a history from today.
insert into fx_rate_history (base, quote, day, rate, source, fetched_at)
select base, quote, (fetched_at at time zone 'Asia/Dubai')::date, rate, 'open.er-api', fetched_at
from fx_rates
where rate is not null and fetched_at is not null
on conflict do nothing;

drop function if exists approve_intake(uuid, uuid, numeric, date, text, uuid, text, text, boolean, uuid, boolean);

create function approve_intake(
  p_intake_id uuid,
  p_account_id uuid,
  p_amount numeric,
  p_occurred_at date,
  p_kind text default 'expense',
  p_category_id uuid default null,
  p_currency text default 'AED',
  p_merchant text default null,
  p_is_shared boolean default true,
  p_owner_member_id uuid default null,
  p_date_confirmed boolean default false,
  p_native_amount numeric default null,
  p_aed_estimated boolean default false
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
  v_currency text := upper(coalesce(nullif(btrim(p_currency), ''), 'AED'));
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
  -- p_amount is always the AED that counts. A payment in another currency
  -- also gives the amount in that currency; an AED one has none.
  if v_currency <> 'AED' and (p_native_amount is null or p_native_amount = 0) then
    raise exception 'a % payment needs its % amount as well as the AED debited', v_currency, v_currency using errcode = '22023';
  end if;
  if v_currency = 'AED' and (p_native_amount is not null or coalesce(p_aed_estimated, false)) then
    raise exception 'an AED payment has no other amount to estimate from' using errcode = '22023';
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

  -- The message gave no date, so parsed_date is only the day it reached the
  -- bot. It becomes the day it was paid when a person says so, never by
  -- default. Read from the locked row, so a screen holding an older copy of
  -- the entry cannot approve past it.
  if v_intake.date_guessed and not coalesce(p_date_confirmed, false) then
    raise exception 'the message had no date: set the day it was paid, or confirm the date shown, before approving'
      using errcode = '22023';
  end if;

  -- The intake row's household is the authority. Every id the caller supplied
  -- has to belong to it; none of them may silently pull a row from elsewhere.
  if not exists (select 1 from accounts where id = p_account_id and household_id = v_intake.household_id) then
    raise exception 'account % does not belong to this intake row''s household', p_account_id using errcode = '42501';
  end if;
  if p_category_id is not null
     and not exists (select 1 from categories where id = p_category_id and household_id = v_intake.household_id) then
    raise exception 'category % does not belong to this intake row''s household', p_category_id using errcode = '42501';
  end if;
  if p_owner_member_id is not null
     and not exists (select 1 from household_members where id = p_owner_member_id and household_id = v_intake.household_id) then
    raise exception 'member % does not belong to this intake row''s household', p_owner_member_id using errcode = '42501';
  end if;

  v_signed := case when p_kind = 'expense' then -abs(p_amount) else abs(p_amount) end;

  insert into transactions (
    household_id, account_id, category_id, amount, currency, native_amount, aed_estimated, kind, merchant,
    occurred_at, is_shared, owner_member_id, needs_review, confidence
  )
  values (
    v_intake.household_id, p_account_id, p_category_id, v_signed, v_currency,
    case when v_currency = 'AED' then null else sign(v_signed) * abs(round(p_native_amount, 2)) end,
    v_currency <> 'AED' and coalesce(p_aed_estimated, false), p_kind,
    nullif(btrim(p_merchant), ''), p_occurred_at, coalesce(p_is_shared, true), p_owner_member_id, false,
    v_intake.confidence
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
  'Approves a pending intake row into exactly one transaction, carrying the intake confidence across. Idempotent: an already-approved row returns its existing transaction. p_amount is the AED that counts; a payment in another currency also gives p_native_amount, and p_aed_estimated when the AED is an estimate. Refuses an account, category or member belonging to a different household than the intake row. Refuses an entry whose date was guessed (intake.date_guessed) unless p_date_confirmed says a person set or confirmed the date.';

grant execute on function approve_intake(uuid, uuid, numeric, date, text, uuid, text, text, boolean, uuid, boolean, numeric, boolean) to authenticated, service_role;
