-- pg_net's default http_post timeout (5000ms) is far too short once a real
-- refresh is pacing Twelve Data batches a minute apart — the call would
-- read as a client-side timeout failure even though the Edge Function is
-- still running fine and completing all its writes. Reschedule with a
-- generous timeout so the cron job's own result reflects reality.
select cron.unschedule('weekday-price-refresh');

select cron.schedule(
  'weekday-price-refresh',
  '0 23 * * 0,1,2,3,4',
  $$select net.http_post(
    url := 'https://erggbzbbutsvhleqcddq.supabase.co/functions/v1/price-refresh',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  )$$
);
