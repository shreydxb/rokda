-- Optional: lets "paid down" be shown as a real percentage. Without it,
-- there's no honest way to know how much of the original balance is gone.
alter table debts add column original_amount numeric(14, 2);
