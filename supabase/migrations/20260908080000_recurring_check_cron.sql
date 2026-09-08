-- SHR-259 follow-up: schedules the daily recurring-payment nudge check
-- (see telegram-webhook's runRecurringCheck / ?run_recurring_check=1) via
-- pg_cron, same pattern as the existing weekday-price-refresh and
-- daily-fd-accrual jobs. 05:00 UTC = 09:00 Gulf Standard Time -- late
-- enough that the previous day's spending has settled, early enough that
-- a nudge lands before the day gets busy.
select cron.schedule(
  'daily-recurring-nudge-check',
  '0 5 * * *',
  $$
  select net.http_get(
    url := 'https://erggbzbbutsvhleqcddq.supabase.co/functions/v1/telegram-webhook?run_recurring_check=1',
    timeout_milliseconds := 60000
  )
  $$
);
