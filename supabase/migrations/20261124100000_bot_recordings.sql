-- What the bot recorded (the revamp, phase 8d; docs/decisions.md, "The bot:
-- commands and linking"). A tap on Record records an expense,
-- and its message offers Undo for ten minutes (20261123100000_bot_undo). The
-- /undo command does the same for the member's latest Record, without
-- finding the message: it needs to know which transaction the bot's own
-- Record made, per entry, and an entry approved in the app (by the partner,
-- at another amount, say) must never look like one. So the bot writes a row
-- here as it records, naming the entry, the member who sent it and the
-- transaction its approval made, and /undo hands the latest of the last ten
-- minutes to undo_intake_approval, which checks it all again.
--
-- Only the bot, with its service role, reads or writes these: a member who
-- could write a row could name an approval made in the app as the bot's. So
-- RLS is on with no policy, and signed-in members have no grant at all.
--
-- A row goes when its transaction goes (an undo, or a delete in the app) and
-- when its entry goes, so /undo never finds something already taken back.
create table public.bot_recordings (
  intake_id uuid primary key references public.intake (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  member_id uuid not null,
  transaction_id uuid not null,
  recorded_at timestamptz not null default now(),
  foreign key (household_id, member_id) references public.household_members (household_id, id) on delete cascade,
  foreign key (household_id, transaction_id) references public.transactions (household_id, id) on delete cascade
);

-- /undo reads a member's latest; the cascade from a transaction finds its row.
create index bot_recordings_member_latest_idx on public.bot_recordings (household_id, member_id, recorded_at desc);
create index bot_recordings_transaction_idx on public.bot_recordings (household_id, transaction_id);

alter table public.bot_recordings enable row level security;
revoke all on public.bot_recordings from public, anon, authenticated;
grant select, insert, update, delete on public.bot_recordings to service_role;

comment on table public.bot_recordings is
  'Which transaction the bot''s own Record made, per entry, for /undo. Written and read by the bot (service_role) only; a row goes with its transaction or its entry.';
