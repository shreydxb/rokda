-- Two things the household asked for after building goal_allocations:
--
-- 1. FDs currently have no way to auto-accrue interest -- `accounts.balance`
--    was just a plain number someone had to update by hand. This adds
--    FD-specific fields (principal/rate/dates/compounding) and makes
--    `balance` a computed value for type='fd' accounts: the trigger below
--    derives it from those fields and today's date, so it's never
--    client-writable for an FD (same "server owns the number" pattern as
--    holdings.value_aed, which price-refresh alone can write).
-- 2. Net worth / goal math has always summed `accounts.balance` as if every
--    account were AED, even though `currency` already existed. Holdings
--    solved this correctly (value_aed, computed by price-refresh) -- this
--    brings accounts to the same standard with `balance_aed`, computed the
--    same way (fixed AED/USD peg, live AED/INR rate off `households`).
alter table accounts
  add column principal numeric,
  add column interest_rate_pct numeric,
  add column compounding text default 'simple',
  add column opened_date date,
  add column maturity_date date,
  add column fd_status text not null default 'active',
  add column balance_aed numeric;

alter table accounts drop constraint accounts_type_check;
alter table accounts add constraint accounts_type_check
  check (type = any (array['checking'::text, 'savings'::text, 'credit_card'::text, 'investment'::text, 'loan'::text, 'cash'::text, 'other'::text, 'fd'::text]));

alter table accounts add constraint accounts_compounding_check
  check (compounding is null or compounding in ('simple', 'monthly', 'quarterly', 'half_yearly', 'annually'));
alter table accounts add constraint accounts_fd_status_check
  check (fd_status in ('active', 'matured'));
alter table accounts add constraint accounts_fd_dates_check
  check (maturity_date is null or opened_date is null or maturity_date > opened_date);

comment on column accounts.principal is 'FD-only: original deposit amount. Source of truth for balance when type=fd -- balance itself becomes computed, not client-writable.';
comment on column accounts.interest_rate_pct is 'FD-only: annual interest rate, percent.';
comment on column accounts.compounding is 'FD-only: simple (interest paid once at maturity, the common UAE FD structure) or a compounding frequency.';
comment on column accounts.fd_status is 'FD-only: active while accruing, matured once maturity_date has passed -- frozen at the full-term value until the household rolls it over into a new term (never auto-reinvested at a guessed future rate).';
comment on column accounts.balance_aed is 'AED-equivalent of balance, computed from currency (fixed AED/USD peg, live AED/INR rate off households.inr_per_aed). Null when currency is INR and no rate has ever been set -- never guessed.';

create or replace function compute_account_derived_fields()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_inr_per_aed numeric;
  v_days_total numeric;
  v_accrual_days numeric;
  v_years numeric;
  v_periods_per_year numeric;
begin
  if new.type = 'fd' and new.principal is not null and new.interest_rate_pct is not null
     and new.opened_date is not null and new.maturity_date is not null then
    v_days_total := greatest(new.maturity_date - new.opened_date, 0);
    v_accrual_days := least(greatest(current_date - new.opened_date, 0), v_days_total);
    v_years := v_accrual_days / 365.0;

    if new.compounding = 'monthly' then v_periods_per_year := 12;
    elsif new.compounding = 'quarterly' then v_periods_per_year := 4;
    elsif new.compounding = 'half_yearly' then v_periods_per_year := 2;
    elsif new.compounding = 'annually' then v_periods_per_year := 1;
    else v_periods_per_year := null; -- 'simple': interest paid once at maturity, no periodic compounding
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

    new.fd_status := case when current_date >= new.maturity_date then 'matured' else 'active' end;
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

  new.updated_at := now();
  return new;
end;
$$;

create trigger accounts_compute_derived_fields
  before insert or update on accounts
  for each row execute function compute_account_derived_fields();

-- Backfill balance_aed for existing rows (all AED today, but this keeps the
-- column honest for the household's next non-AED account) by re-running the
-- same trigger logic via a no-op update.
update accounts set updated_at = updated_at;
