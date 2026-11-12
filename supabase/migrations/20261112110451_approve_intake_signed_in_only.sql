-- approve_intake is for signed-in members and the bot. It was granted to
-- them by name, but the access Postgres gives everyone to a new function was
-- never taken away, so it could be called signed out. It runs as its caller,
-- who signed out can see no Inbox row, so nothing could be approved that way;
-- this closes it like every other function (SHR-381). Tested in
-- supabase/test/rls-policies.test.sql ("signed-out functions").
revoke execute on function public.approve_intake(uuid, uuid, numeric, date, text, uuid, text, text, boolean, uuid, boolean, numeric, boolean) from public, anon;
