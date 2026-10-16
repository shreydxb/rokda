-- A Telegram link code is generated for yourself, or by an owner (SHR-314).
--
-- generate_telegram_link_code() checked only that the caller belonged to the
-- member's household. Any member could therefore generate a code for any
-- other member, the owner included, send it to the bot from their own
-- Telegram, and be treated by the bot as that person: its writes recorded as
-- theirs, its private replies sent to the wrong phone. With one login that was
-- theoretical; a second member's login (SHR-314) makes it real.
--
-- Now the code is for the caller's own member row, or the caller is an owner.
-- An owner still links a member who has no login of their own (a partner who
-- only uses Telegram), which is how such a member is linked at all.

create or replace function generate_telegram_link_code(p_member_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_household_id uuid;
  v_self boolean;
begin
  select household_id, user_id is not distinct from auth.uid() and user_id is not null
    into v_household_id, v_self
  from household_members where id = p_member_id;
  if v_household_id is null or not private.is_household_member(v_household_id) then
    raise exception 'not a member of this household' using errcode = '42501';
  end if;
  if not v_self and not private.is_household_owner(v_household_id) then
    raise exception 'only an owner can link another member''s Telegram' using errcode = '42501';
  end if;

  v_code := replace(gen_random_uuid()::text, '-', '');

  perform set_config('app.bypass_telegram_link_guard', 'on', true);
  update household_members
    set telegram_link_code = v_code,
        telegram_link_code_expires_at = now() + interval '15 minutes'
    where id = p_member_id;

  return v_code;
end;
$$;

revoke execute on function generate_telegram_link_code(uuid) from public, anon;
grant execute on function generate_telegram_link_code(uuid) to authenticated;

comment on function generate_telegram_link_code(uuid) is
  'A one-time token to link a member''s Telegram, valid 15 minutes. For the caller''s own member row, or any member of the household if the caller is an owner.';
