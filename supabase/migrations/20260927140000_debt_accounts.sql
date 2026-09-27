-- A debt on Debt payoff is the plan for a loan or card; the loan itself lives
-- in accounts, where net worth counts it. They were two unrelated records, so
-- a debt entered only on Debt payoff never reached net worth, and one entered
-- in both drifted apart. account_id links them: a linked debt takes its
-- balance from the account, and the debt keeps only what an account has no
-- place for -- the rate, the minimum, the original amount.

alter table debts
  add column account_id uuid,
  add constraint debts_account_id_fkey
    foreign key (household_id, account_id) references accounts (household_id, id) on delete set null (account_id);

-- One plan per loan: two debts on one account would count it twice.
create unique index debts_account_id_key on debts (account_id) where account_id is not null;
create index debts_household_account_idx on debts (household_id, account_id);

-- Only something owed can be a debt's account: a savings account's balance
-- would be read as the amount owed.
create or replace function debts_account_is_liability()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  account_type text;
begin
  if new.account_id is null then
    return new;
  end if;
  select type into account_type from accounts where id = new.account_id;
  if account_type is not null and account_type not in ('loan', 'credit_card') then
    raise exception 'A debt can only be linked to a loan or credit card account, not a % account.', account_type
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function debts_account_is_liability() from public, anon, authenticated;

create trigger debts_account_is_liability
  before insert or update of account_id on debts
  for each row execute function debts_account_is_liability();

comment on column debts.account_id is
  'The loan or credit card account this debt is the payoff plan for. When set, the account''s balance is the amount owed and net worth counts it; debts.balance is only the last figure entered here. Null for a debt with no account, which net worth does not see.';
