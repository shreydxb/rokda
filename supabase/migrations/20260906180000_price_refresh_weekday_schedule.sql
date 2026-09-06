-- Replaces the daily 03:17 GST schedule with weekdays only, timed after
-- both the US close (~midnight GST) and the NSE close (~2-2:30am GST):
-- 03:00 GST is 23:00 UTC the previous day, and GST-Monday through
-- GST-Friday map to UTC Sunday through UTC Thursday.
select cron.unschedule('daily-price-refresh');

select cron.schedule(
  'weekday-price-refresh',
  '0 23 * * 0,1,2,3,4',
  $$select net.http_post(
    url := 'https://erggbzbbutsvhleqcddq.supabase.co/functions/v1/price-refresh',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )$$
);
