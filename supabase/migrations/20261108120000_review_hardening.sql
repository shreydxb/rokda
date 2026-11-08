-- Hardening from the outside review of 8 November 2026 (docs/decisions.md,
-- "What the outside review changed"). Each section fixes one finding; the
-- behaviour it guarantees is tested in supabase/test.

-- ---------------------------------------------------------------------------
-- 1. The Telegram link code is kept only as its digest
-- ---------------------------------------------------------------------------

-- Every member can read the household's roster, so a live link code stored
-- there could be read by another member and sent to the bot from their own
-- Telegram, linking it as the code's owner. The roster now holds only the
-- code's SHA-256 (lowercase hex); the caller gets the code itself, and the
-- bot hashes what it receives. The code is random (122 bits), so its digest
-- gives nothing away.
create or replace function public.generate_telegram_link_code(p_member_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
  v_household_id uuid;
  v_self boolean;
begin
  select m.household_id, m.user_id is not distinct from auth.uid() and m.user_id is not null
    into v_household_id, v_self
  from public.household_members m where m.id = p_member_id;
  if v_household_id is null or not private.is_household_member(v_household_id) then
    raise exception 'not a member of this household' using errcode = '42501';
  end if;
  if not v_self and not private.is_household_owner(v_household_id) then
    raise exception 'only an owner can link another member''s Telegram' using errcode = '42501';
  end if;

  v_code := replace(gen_random_uuid()::text, '-', '');

  perform set_config('app.bypass_telegram_link_guard', 'on', true);
  update public.household_members
    set telegram_link_code = encode(sha256(convert_to(v_code, 'UTF8')), 'hex'),
        telegram_link_code_expires_at = now() + interval '15 minutes'
    where id = p_member_id;

  return v_code;
end;
$$;

revoke execute on function public.generate_telegram_link_code(uuid) from public, anon;
grant execute on function public.generate_telegram_link_code(uuid) to authenticated;

comment on function public.generate_telegram_link_code(uuid) is
  'A one-time token to link a member''s Telegram, valid 15 minutes. For the caller''s own member row, or any member of the household if the caller is an owner. The roster keeps only its SHA-256.';
comment on column public.household_members.telegram_link_code is
  'The SHA-256 (hex) of a one-time link code from generate_telegram_link_code(); the bot matches the digest of what it is sent. Cleared on redemption or expiry.';

-- A code issued before this change was stored as itself: it is withdrawn, and
-- a member who had one asks for another.
select set_config('app.bypass_telegram_link_guard', 'on', true);
update public.household_members
  set telegram_link_code = null, telegram_link_code_expires_at = null
  where telegram_link_code is not null;
select set_config('app.bypass_telegram_link_guard', 'off', true);
