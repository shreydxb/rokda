-- Schedules the price-refresh Edge Function to run once a day. Requires a
-- Vault secret named 'service_role_key' holding this project's service role
-- key (Project Settings -> API in the dashboard) -- deliberately not set by
-- migration, since that key must never be committed to the repo. Until the
-- secret exists this job runs and no-ops (the Authorization header comes
-- back null and the function returns 401); the manual "Refresh" button in
-- the Wealth screen is unaffected, since it calls the function directly
-- with the signed-in user's own session.
create extension if not exists pg_net;
create extension if not exists pg_cron;

select cron.schedule(
  'daily-price-refresh',
  '17 3 * * *',
  $$select net.http_post(
    url := 'https://erggbzbbutsvhleqcddq.supabase.co/functions/v1/price-refresh',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )$$
);
