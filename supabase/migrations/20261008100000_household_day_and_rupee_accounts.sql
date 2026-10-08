-- The household's day in the database, and rupee balances that follow the rate.
--
-- 1. current_date is the session's day, which on Supabase is UTC. Fixed
--    deposits accrued to it: the nightly fd-accrual run is at 03:00 Dubai
--    (23:00 UTC), so it valued every deposit as of the previous day and
--    marked one matured a day late. transactions.occurred_at defaulted to it
--    too. household_today() is Dubai's date at a given moment, whatever zone
--    the session is in.
-- 2. A rupee account's balance_aed was computed only when the account was
--    saved, while the rate refreshes every weekday (price-refresh) and
--    holdings and rupee reminders follow it. Net worth therefore added rupee
--    accounts at old rates to holdings at today's. accounts_follow_inr_rate
--    re-values them whenever the household's rate changes, the way
--    recurring_follow_inr_rate already does for reminders. Dollar accounts
--    need nothing: the peg does not move.

create or replace function household_today(p_at timestamptz default now())
returns date
language sql
stable
set search_path = ''
as $$
  select (p_at at time zone 'Asia/Dubai')::date;
$$;

-- Not a helper to hide: the account trigger and the occurred_at default run as
-- the signed-in user (and as service_role for the Edge Functions), so both
-- roles must be able to execute it. anon writes nothing that calls it.
revoke execute on function household_today(timestamptz) from public, anon;
grant execute on function household_today(timestamptz) to authenticated, service_role;

comment on function household_today(timestamptz) is
  'The household''s calendar day (Asia/Dubai: UTC+4, no daylight saving) at a moment, now() by default. Use it instead of current_date, which is the session''s day -- UTC on Supabase, so the previous Dubai day from 00:00 to 04:00.';

-- Every current writer sends a date, so this changes no row today. It keeps a
-- writer that leaves the column out from dating a 1am expense yesterday.
alter table transactions alter column occurred_at set default household_today();

create or replace function compute_account_derived_fields()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  -- Dubai's day, not current_date (UTC): see household_today().
  v_today date := household_today();
  v_inr_per_aed numeric;
  v_days_total numeric;
  v_accrual_days numeric;
  v_years numeric;
  v_periods_per_year numeric;
begin
  if new.type = 'fd' and new.principal is not null and new.interest_rate_pct is not null
     and new.opened_date is not null and new.maturity_date is not null then
    v_days_total := greatest(new.maturity_date - new.opened_date, 0);
    v_accrual_days := least(greatest(v_today - new.opened_date, 0), v_days_total);
    v_years := v_accrual_days / 365.0;

    if new.compounding = 'monthly' then v_periods_per_year := 12;
    elsif new.compounding = 'quarterly' then v_periods_per_year := 4;
    elsif new.compounding = 'half_yearly' then v_periods_per_year := 2;
    elsif new.compounding = 'annually' then v_periods_per_year := 1;
    else v_periods_per_year := null;
    end if;

    if v_periods_per_year is null then
      new.balance := round(new.principal * (1 + (new.interest_rate_pct / 100.0) * v_years), 2);
    else
      new.balance := round(
        (new.principal * power(
          (1 + (new.interest_rate_pct / 100.0) / v_periods_per_year)::double precision,
          (v_periods_per_year * v_years)::double precision
        ))::numeric,
        2
      );
    end if;

    new.fd_status := case when v_today >= new.maturity_date then 'matured' else 'active' end;
  end if;

  if new.currency = 'AED' then
    new.balance_aed := new.balance;
  elsif new.currency = 'USD' then
    new.balance_aed := round(new.balance * 3.6725, 2);
  elsif new.currency = 'INR' then
    select inr_per_aed into v_inr_per_aed from households where id = new.household_id;
    new.balance_aed := case when v_inr_per_aed is not null and v_inr_per_aed > 0 then round(new.balance / v_inr_per_aed, 2) else null end;
  else
    new.balance_aed := null;
  end if;

  -- updated_at is when the account was last written to directly. A row
  -- re-valued from inside another trigger (accounts_follow_inr_rate, when the
  -- rupee rate moves) was not edited, so it keeps the time it had. The only
  -- other trigger-side write is a removed member's accounts losing their
  -- owner (the foreign key's ON DELETE SET NULL), which is not an edit
  -- either. A future trigger that edits accounts for real would have to set
  -- updated_at itself.
  if pg_trigger_depth() <= 1 then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

revoke execute on function compute_account_derived_fields() from public, anon, authenticated;

comment on column accounts.balance_aed is
  'AED-equivalent of balance, computed by compute_account_derived_fields(): the fixed AED/USD peg, or households.inr_per_aed for INR, re-applied whenever that rate changes (accounts_follow_inr_rate). Null when there is no rate -- never guessed, never 1:1.';

create or replace function accounts_follow_inr_rate()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- A no-op write: compute_account_derived_fields() re-values each row from
  -- its balance and the rate just stored, so there is one formula. With no
  -- rate it leaves balance_aed null: unknown, never 1:1.
  update accounts set currency = currency
   where household_id = new.id and currency = 'INR';
  return null;
end;
$$;

revoke execute on function accounts_follow_inr_rate() from public, anon, authenticated;

create trigger accounts_follow_inr_rate
  after update of inr_per_aed on households
  for each row when (new.inr_per_aed is distinct from old.inr_per_aed)
  execute function accounts_follow_inr_rate();

-- Bring every rupee account to the rate on record now rather than at the next
-- refresh. This is a direct write, so it moves their updated_at once.
update accounts set currency = currency where currency = 'INR';
