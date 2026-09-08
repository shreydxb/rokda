-- This is a trigger-only function (it reads the special NEW record, which
-- only exists inside trigger execution) but Postgres grants EXECUTE to
-- PUBLIC by default, which exposes it as a callable RPC endpoint via
-- PostgREST. Calling it directly would just error (no trigger context), but
-- close the surface off entirely rather than rely on that.
revoke execute on function set_transaction_edit_author() from public;
