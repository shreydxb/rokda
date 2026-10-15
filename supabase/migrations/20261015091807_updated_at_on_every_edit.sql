-- updated_at moves on every edit, whoever makes it (docs/decisions.md,
-- "updated_at is kept by the database"; SHR-307).
--
-- Fifteen tables have an updated_at column, and only accounts kept it: the
-- others relied on each screen remembering to send it. The transaction
-- editor never did, so an edited transaction kept its creation time, and the
-- bot, intake approval and statement imports never set it either. Each table
-- now has the rule accounts already follows (compute_account_derived_fields):
-- a direct write sets updated_at to now(). A row changed from inside another
-- trigger -- re-valued when the rupee rate moves, or losing an owner who was
-- removed -- was not edited, and keeps the time it had.
--
-- accounts is left as it is: its rule lives in compute_account_derived_fields.

create or replace function touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if pg_trigger_depth() <= 1 then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

revoke execute on function touch_updated_at() from public, anon, authenticated;

comment on function touch_updated_at() is
  'Sets updated_at to now() on a direct update; a row changed from inside another trigger keeps the time it had. The same rule as accounts.';

create trigger transactions_touch_updated_at before update on transactions for each row execute function touch_updated_at();
create trigger budgets_touch_updated_at before update on budgets for each row execute function touch_updated_at();
create trigger category_rules_touch_updated_at before update on category_rules for each row execute function touch_updated_at();
create trigger debts_touch_updated_at before update on debts for each row execute function touch_updated_at();
create trigger goal_allocations_touch_updated_at before update on goal_allocations for each row execute function touch_updated_at();
create trigger goals_touch_updated_at before update on goals for each row execute function touch_updated_at();
create trigger holdings_touch_updated_at before update on holdings for each row execute function touch_updated_at();
create trigger household_notes_touch_updated_at before update on household_notes for each row execute function touch_updated_at();
create trigger independence_income_touch_updated_at before update on independence_income for each row execute function touch_updated_at();
create trigger member_life_touch_updated_at before update on member_life for each row execute function touch_updated_at();
create trigger planning_assumptions_touch_updated_at before update on planning_assumptions for each row execute function touch_updated_at();
create trigger recurring_touch_updated_at before update on recurring for each row execute function touch_updated_at();
create trigger statement_reconciliations_touch_updated_at before update on statement_reconciliations for each row execute function touch_updated_at();
create trigger telegram_notification_prefs_touch_updated_at before update on telegram_notification_prefs for each row execute function touch_updated_at();
