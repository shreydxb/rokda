-- This is a trigger-only function (it reads the special NEW record, which
-- only exists inside trigger execution) but Supabase's default privileges
-- grant EXECUTE on new public-schema functions directly to
-- anon/authenticated/service_role (not just PUBLIC), which exposes it as a
-- callable RPC endpoint via PostgREST. Calling it directly would just error
-- (no trigger context), but close the surface off entirely rather than
-- rely on that.
revoke execute on function set_transaction_edit_author() from public, anon, authenticated;
