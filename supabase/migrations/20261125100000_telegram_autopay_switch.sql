-- Autopay questions get their own switch (the review of the whole revamp;
-- docs/decisions.md, "The review of the whole revamp"). The bot's question
-- about an autopay bill, with Paid, Not yet and Other amount, was switched
-- off by recurring_enabled, which Settings → Telegram calls "Missed bills"
-- and lists with the morning message, the nudges that need no answer. So a
-- household that turned missed-bill reminders off lost every autopay
-- question too, without being told.
--
-- A household that had missed bills off had autopay questions off as well,
-- so it keeps them off: the new switch starts where the old one was.
alter table public.telegram_notification_prefs add column autopay_enabled boolean not null default true;
update public.telegram_notification_prefs set autopay_enabled = recurring_enabled;

comment on column public.telegram_notification_prefs.autopay_enabled is
  'The bot''s question about an autopay bill on and after its due date (Paid, Not yet, Other amount). Separate from recurring_enabled, the missed-bill reminder. Missing row = on.';
