-- P0 security fix: the telegram-webhook Edge Function has JWT verification
-- disabled (it must -- Telegram itself calls it, not a signed-in user) but
-- had NO verification that a POST actually came from Telegram at all. It
-- trusted message.from.id as a household member's identity and
-- message.chat.id as where to send the reply straight out of the request
-- body -- an arbitrary caller who knew (or guessed) a linked member's
-- Telegram numeric id could forge an update claiming to be them, with the
-- reply routed to a chat of the caller's choosing. The public ?setup=1 and
-- ?run_recurring_check=1 GET routes had the same problem: no check at all
-- beyond obscurity.
--
-- Telegram's own answer to this is a secret_token on setWebhook: Telegram
-- then attaches it as the X-Telegram-Bot-Api-Secret-Token header on every
-- real call, and the receiver rejects anything that doesn't match --
-- before parsing the body, so a forged request never gets far enough to
-- touch anything.
--
-- No edge-function secrets-management access from this session, so the
-- shared secret lives in Vault instead (same place service_role_key
-- already lives for the existing pg_cron jobs) and is read at request time
-- via a narrowly-scoped RPC -- never exposed through PostgREST to
-- anon/authenticated, only callable by the service-role client the edge
-- function itself uses.
create or replace function get_telegram_webhook_secret()
returns text
language sql
security definer
set search_path = public, vault
stable
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'telegram_webhook_secret';
$$;

revoke execute on function get_telegram_webhook_secret() from public, anon, authenticated;

comment on function get_telegram_webhook_secret is 'Returns the shared secret Telegram sends back as X-Telegram-Bot-Api-Secret-Token, and that the daily pg_cron check also sends. Only the service-role client (the edge function itself) can call this -- never exposed to anon/authenticated.';
