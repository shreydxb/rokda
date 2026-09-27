-- Reminders that end, reminders in rupees, money that arrives in a known year,
-- and spending that stops when work does.
--
-- A household with a car loan, two LIC policies and a PPF account has
-- schedules that end (the last EMI, the last premium, the last deposit),
-- amounts set in rupees, and policy maturities paid in a fixed calendar year
-- whatever year work stops. None of those fit the tables as they were.

-- Recurring: an optional last date, and an amount kept in its own currency.
--
-- `amount` stays the AED figure every screen and the Telegram bot already
-- read. For a row in another currency, `native_amount` is the figure the
-- household actually owes, in `currency`, and `amount` is computed from it:
-- the fixed peg for USD, the household's rate for INR. When the rate moves,
-- the INR rows follow it (recurring_follow_inr_rate below).
alter table recurring
  add column ends_on date,
  add column native_amount numeric(14, 2),
  add constraint recurring_currency check (currency in ('AED', 'USD', 'INR')),
  add constraint recurring_native_amount_currency check ((currency = 'AED') = (native_amount is null)),
  add constraint recurring_ends_after_start check (ends_on is null or ends_on >= next_due_date);

create or replace function recurring_amount_from_native()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  rate numeric;
begin
  if new.currency = 'USD' then
    new.amount := round(new.native_amount * 3.6725, 2);
  elsif new.currency = 'INR' then
    select inr_per_aed into rate from households where id = new.household_id;
    if rate is null or rate <= 0 then
      raise exception 'Set an AED/INR rate in Settings before adding a reminder in rupees.'
        using errcode = 'check_violation';
    end if;
    new.amount := round(new.native_amount / rate, 2);
  end if;
  return new;
end;
$$;

revoke execute on function recurring_amount_from_native() from public, anon, authenticated;

create trigger recurring_amount_from_native
  before insert or update of currency, native_amount, amount on recurring
  for each row execute function recurring_amount_from_native();

create or replace function recurring_follow_inr_rate()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.inr_per_aed is not null and new.inr_per_aed > 0 then
    update recurring set amount = round(native_amount / new.inr_per_aed, 2)
    where household_id = new.id and currency = 'INR';
  end if;
  return null;
end;
$$;

revoke execute on function recurring_follow_inr_rate() from public, anon, authenticated;

create trigger recurring_follow_inr_rate
  after update of inr_per_aed on households
  for each row when (new.inr_per_aed is distinct from old.inr_per_aed)
  execute function recurring_follow_inr_rate();

comment on column recurring.ends_on is
  'The last date this schedule can fall on: the final EMI, premium or deposit. Null for a schedule with no end. Occurrences after it are not shown or nudged.';
comment on column recurring.native_amount is
  'The amount in `currency` when that is not AED, signed like `amount`. `amount` is then computed from it (USD at the peg, INR at households.inr_per_aed) and follows the INR rate when it changes.';

-- Other income: a lump sum paid in a known calendar year, in any currency.
--
-- A policy maturing in 2044 pays in 2044 whether work stops in 2040 or 2055,
-- so "N years after work stops" cannot place it. `in_year` does; the amount
-- is then what will be paid that year, like a goal's amount on its date, and
-- the Life plan brings it back to today's money.
alter table independence_income
  add column in_year int,
  add column currency text not null default 'AED',
  add constraint independence_income_currency check (currency in ('AED', 'USD', 'INR')),
  add constraint independence_income_in_year_lump_sum check (in_year is null or kind = 'lump_sum'),
  add constraint independence_income_in_year_range check (in_year is null or in_year between 2000 and 2200);

comment on column independence_income.in_year is
  'For a lump sum paid in a fixed calendar year (a policy maturity): the year, and `amount` is what is paid then. Null for income timed from the year work stops (starts_after_years).';
comment on column independence_income.currency is
  'Currency of `amount`. Converted to AED at today''s rate (the peg for USD).';

-- Spending that stops when work does: rent on a home that will be owned by
-- then, loan payments that will be finished. The Life plan leaves these
-- categories out of spending after work stops.
alter table categories
  add column stops_after_work boolean not null default false;

comment on column categories.stops_after_work is
  'True for an expense the household expects to have stopped by the time work stops (rent on a home it will own, a loan''s instalments). The Life plan leaves it out of spending after work stops.';
