// SHR-257: FDs accrue interest every calendar day, not just market days, so
// this runs daily (unlike price-refresh's weekday-only schedule). The
// accrual formula itself lives entirely in the `compute_account_derived_fields`
// trigger on `accounts` -- this function's only job is to touch every active
// FD row so that trigger re-evaluates against *today's* date. Nothing here
// computes interest itself, so there's exactly one place (the SQL trigger)
// that can ever disagree with itself about what an FD is worth.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

Deno.serve(async () => {
  const { data: fds, error } = await supabase.from("accounts").select("id").eq("type", "fd").eq("fd_status", "active");
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  let touched = 0;
  let failed = 0;
  for (const fd of fds ?? []) {
    // A no-op value write -- the row's own before-update trigger recomputes
    // balance/balance_aed/fd_status from principal/rate/dates against today.
    const { error: updateError } = await supabase.from("accounts").update({ fd_status: "active" }).eq("id", fd.id);
    if (updateError) failed += 1;
    else touched += 1;
  }

  return new Response(JSON.stringify({ touched, failed }), { headers: { "Content-Type": "application/json" } });
});
