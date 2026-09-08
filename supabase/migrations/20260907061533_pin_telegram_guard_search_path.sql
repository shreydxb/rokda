-- Security advisor: guard_telegram_link_columns had a mutable search_path.
-- Pin it, same as every other function in this schema.
create or replace function guard_telegram_link_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (new.telegram_user_id is distinct from old.telegram_user_id
      or new.telegram_link_code is distinct from old.telegram_link_code
      or new.telegram_link_code_expires_at is distinct from old.telegram_link_code_expires_at)
     and auth.role() <> 'service_role'
     and coalesce(current_setting('app.bypass_telegram_link_guard', true), 'off') <> 'on'
  then
    raise exception 'telegram link fields can only be changed by the linking flow' using errcode = '42501';
  end if;
  return new;
end;
$$;
