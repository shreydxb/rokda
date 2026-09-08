-- The telegram-webhook function now rejects every request without the
-- shared secret (see 20260908100000_telegram_webhook_secret.sql) --
-- including this daily check, which previously called it with no
-- authentication at all. Reschedule with the header, same pattern already
-- used for the Authorization header on weekday-price-refresh /
-- daily-fd-accrual.
select cron.unschedule('daily-recurring-nudge-check');

select cron.schedule(
  'daily-recurring-nudge-check',
  '0 5 * * *',
  $$
  select net.http_get(
    url := 'https://erggbzbbutsvhleqcddq.supabase.co/functions/v1/telegram-webhook?run_recurring_check=1',
    headers := jsonb_build_object('X-Telegram-Bot-Api-Secret-Token', get_telegram_webhook_secret()),
    timeout_milliseconds := 60000
  )
  $$
);
