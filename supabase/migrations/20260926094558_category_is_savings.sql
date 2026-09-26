-- A category can hold money set aside rather than spent: "Savings &
-- Investments", an emergency-fund top-up. Its budget is a savings target --
-- the Budget screen compares it with what the month actually saved -- and it
-- is kept out of every spending total. Nothing is filed under it as spending:
-- the app and the Telegram bot leave savings categories out of the lists a
-- transaction's category is picked from.
alter table categories
  add column is_savings boolean not null default false,
  add constraint categories_savings_is_expense check (not is_savings or kind = 'expense');
