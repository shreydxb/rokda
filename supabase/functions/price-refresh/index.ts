// Pulls a real, timestamped FX rate and real instrument prices for every
// holding that has opted in (price_symbol + price_provider set). Never
// invents a number: a failed pull leaves the previous value in place and
// records the failure, so staleness is visible rather than silently masked.
//
// Runs weekdays around 3am Gulf time (see the price_refresh_schedule
// migration — safely after both the US close, ~midnight GST, and the NSE
// close, ~2-2:30am GST) and on demand from the Wealth screen's "Refresh"
// button.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TWELVEDATA_API_KEY = Deno.env.get("TWELVEDATA_API_KEY");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// AED-USD is a hard peg (3.6725, fixed by the UAE Central Bank since 1997) —
// a real constant, not a rate that needs fetching.
const AED_PER_USD = 3.6725;

async function refreshFx(): Promise<{ ok: boolean; rate: number | null; error?: string }> {
  const { data: existing } = await supabase
    .from("fx_rates")
    .select("*")
    .eq("base", "AED")
    .eq("quote", "INR")
    .maybeSingle();

  try {
    // Keyless, free, daily-refreshed. AED-USD is the fixed peg above, so
    // INR is the only rate worth pulling.
    const res = await fetch("https://open.er-api.com/v6/latest/AED");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const rate = body?.rates?.INR;
    if (typeof rate !== "number") throw new Error("Response had no INR rate");

    const fetchedAt = new Date().toISOString();
    await supabase.from("fx_rates").upsert({
      base: "AED",
      quote: "INR",
      rate,
      fetched_at: fetchedAt,
      fetch_error: null,
      fail_count: 0,
    });

    // Every household shows the same market rate — this is what replaces
    // the one-time manual WebSearch conversion the currency toggle used.
    await supabase
      .from("households")
      .update({ inr_per_aed: rate, inr_rate_set_at: fetchedAt, inr_rate_source: "auto" })
      .neq("id", "00000000-0000-0000-0000-000000000000");

    return { ok: true, rate };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase.from("fx_rates").upsert({
      base: "AED",
      quote: "INR",
      rate: existing?.rate ?? null,
      fetched_at: existing?.fetched_at ?? null,
      fetch_error: message,
      fail_count: (existing?.fail_count ?? 0) + 1,
    });
    // Fall back to whatever rate is already on record so holdings priced in
    // INR can still be converted today, even though this run's pull failed.
    return { ok: false, rate: existing?.rate ?? null, error: message };
  }
}

// AED-equivalent of one unit's worth of native-currency value, or null when
// the currency isn't one we can convert (only AED/USD/INR are), so callers
// know to leave that holding's AED value untouched rather than guess.
function toAed(currency: string, nativeAmount: number, inrPerAed: number | null): number | null {
  if (currency === "AED") return nativeAmount;
  if (currency === "USD") return nativeAmount * AED_PER_USD;
  if (currency === "INR") return inrPerAed ? nativeAmount / inrPerAed : null;
  return null;
}

type Holding = {
  id: string;
  currency: string;
  quantity: string | null;
  price_symbol: string;
  price_provider: "twelvedata" | "coingecko" | "mfapi";
  price_fetch_fail_count: number;
};

type PriceResult = { price: number; dayChangePct: number | null } | { error: string };

async function fetchTwelveData(symbols: string[]): Promise<Record<string, PriceResult>> {
  const out: Record<string, PriceResult> = {};
  if (!TWELVEDATA_API_KEY) {
    for (const s of symbols) out[s] = { error: "TWELVEDATA_API_KEY not configured" };
    return out;
  }
  try {
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbols.join(","))}&apikey=${TWELVEDATA_API_KEY}`;
    const res = await fetch(url);
    const body = await res.json();
    // Single symbol comes back as one object; multiple as {symbol: object}.
    const bySymbol = symbols.length === 1 ? { [symbols[0]]: body } : body;
    for (const s of symbols) {
      const row = bySymbol[s];
      if (!row || row.status === "error" || row.code) {
        out[s] = { error: row?.message ?? "Symbol not found" };
        continue;
      }
      const price = Number(row.close);
      const pct = row.percent_change != null ? Number(row.percent_change) : null;
      out[s] = Number.isFinite(price) ? { price, dayChangePct: pct } : { error: "No price in response" };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const s of symbols) out[s] = { error: message };
  }
  return out;
}

async function fetchCoinGecko(ids: string[]): Promise<Record<string, PriceResult>> {
  const out: Record<string, PriceResult> = {};
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids.join(","))}&vs_currencies=usd&include_24hr_change=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    for (const id of ids) {
      const row = body[id];
      if (!row || typeof row.usd !== "number") {
        out[id] = { error: "Coin not found" };
        continue;
      }
      out[id] = { price: row.usd, dayChangePct: typeof row.usd_24h_change === "number" ? row.usd_24h_change : null };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const id of ids) out[id] = { error: message };
  }
  return out;
}

async function fetchMfapi(schemeCode: string): Promise<PriceResult> {
  try {
    const res = await fetch(`https://api.mfapi.in/mf/${encodeURIComponent(schemeCode)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const rows = body?.data;
    if (!Array.isArray(rows) || rows.length === 0) throw new Error("No NAV history for this scheme code");
    const price = Number(rows[0].nav);
    const prev = rows.length > 1 ? Number(rows[1].nav) : null;
    const dayChangePct = prev && prev > 0 ? ((price - prev) / prev) * 100 : null;
    return Number.isFinite(price) ? { price, dayChangePct } : { error: "No NAV in response" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function refreshHoldings(inrPerAed: number | null) {
  const { data: holdings, error } = await supabase
    .from("holdings")
    .select("id, currency, quantity, price_symbol, price_provider, price_fetch_fail_count")
    .not("price_symbol", "is", null)
    .not("price_provider", "is", null);
  if (error || !holdings) return { updated: 0, failed: 0, historyCaptured: 0 };

  const byProvider = new Map<string, Holding[]>();
  for (const h of holdings as Holding[]) {
    if (!byProvider.has(h.price_provider)) byProvider.set(h.price_provider, []);
    byProvider.get(h.price_provider)!.push(h);
  }

  const results = new Map<string, PriceResult>(); // holding id -> result
  const twelvedata = byProvider.get("twelvedata") ?? [];
  if (twelvedata.length) {
    const prices = await fetchTwelveData(twelvedata.map((h) => h.price_symbol));
    for (const h of twelvedata) results.set(h.id, prices[h.price_symbol] ?? { error: "No response" });
  }
  const coingecko = byProvider.get("coingecko") ?? [];
  if (coingecko.length) {
    const prices = await fetchCoinGecko(coingecko.map((h) => h.price_symbol));
    for (const h of coingecko) results.set(h.id, prices[h.price_symbol] ?? { error: "No response" });
  }
  const mfapi = byProvider.get("mfapi") ?? [];
  for (const h of mfapi) {
    results.set(h.id, await fetchMfapi(h.price_symbol));
  }

  let updated = 0;
  let failed = 0;
  let historyCaptured = 0;
  const now = new Date();
  const nowIso = now.toISOString();
  const today = nowIso.slice(0, 10);

  for (const h of holdings as Holding[]) {
    const result = results.get(h.id);
    if (!result) continue;
    if ("error" in result) {
      failed++;
      await supabase
        .from("holdings")
        .update({ price_fetch_error: result.error, price_fetch_fail_count: h.price_fetch_fail_count + 1 })
        .eq("id", h.id);
      continue;
    }

    updated++;
    // Only holdings with real units and a currency we can convert get an
    // auto-computed AED value; everything else keeps its manually-entered
    // value_aed exactly as before — this never guesses a number it can't
    // actually derive.
    const quantity = h.quantity != null ? Number(h.quantity) : null;
    const valueAed = quantity != null ? toAed(h.currency, quantity * result.price, inrPerAed) : null;

    await supabase
      .from("holdings")
      .update({
        current_price: result.price,
        day_change_pct: result.dayChangePct,
        last_refreshed: nowIso,
        price_fetch_error: null,
        price_fetch_fail_count: 0,
        ...(valueAed !== null ? { value_aed: Math.round(valueAed * 100) / 100 } : {}),
      })
      .eq("id", h.id);

    if (valueAed !== null) {
      const { error: historyError } = await supabase
        .from("holding_value_history")
        .upsert({ holding_id: h.id, as_of: today, value_aed: Math.round(valueAed * 100) / 100 }, { onConflict: "holding_id,as_of" });
      if (!historyError) historyCaptured++;
    }
  }
  return { updated, failed, historyCaptured };
}

Deno.serve(async () => {
  // Sequential, not parallel: holdings priced in INR need this run's own
  // fx rate (or the last good one) to convert to AED correctly.
  const fx = await refreshFx();
  const holdings = await refreshHoldings(fx.rate);
  return new Response(JSON.stringify({ fx, holdings }), {
    headers: { "Content-Type": "application/json" },
  });
});
