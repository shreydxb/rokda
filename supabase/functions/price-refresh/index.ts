// Pulls a real, timestamped FX rate and real instrument prices for every
// holding that has opted in (price_symbol + price_provider set). Never
// invents a number: a failed pull leaves the previous value in place and
// records the failure, so staleness is visible rather than silently masked.
//
// Runs weekdays around 3am Gulf time (see the price_refresh_schedule
// migration — safely after both the US close, ~midnight GST, and the NSE
// close, ~2-2:30am GST) and on demand from the Wealth screen's "Refresh"
// button.
import "jsr:@supabase/functions-js@2.117.2/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2.117.2";
import { householdToday } from "../_shared/applib/day.js";
import { historyRowsFromEcb } from "../_shared/applib/fxHistory.js";
import { navQuoteTime, quoteTime } from "../_shared/quoteTime.ts";
import { bearerToken, presentedSchedulerSecret, schedulerSecretMatches } from "../_shared/requestAuth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TWELVEDATA_API_KEY = Deno.env.get("TWELVEDATA_API_KEY");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// AED-USD is a hard peg (3.6725, fixed by the UAE Central Bank since 1997) —
// a real constant, not a rate that needs fetching.

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

    // The day's rate in the history too, so a payment dated today is
    // estimated at today's rate long after the latest one has moved on
    // (SHR-321). Best-effort: a failed write leaves the latest rate current.
    await supabase.from("fx_rate_history").upsert(
      { base: "AED", quote: "INR", day: householdToday(new Date(fetchedAt)), rate, source: "open.er-api", fetched_at: fetchedAt },
      { onConflict: "base,quote,day" },
    );

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

// The first day the rupee history reaches back to: far enough for the
// payments recorded since the household started using Rokda.
const FX_HISTORY_FROM = "2025-01-01";

// Fills the rupee history for the days before the daily refresh began, once,
// from the ECB's reference rates (Frankfurter, keyless), converted through the
// dollar peg. A day the daily refresh already recorded is kept. Skipped once
// any ECB day is on record; a failure is reported and changes nothing, and
// the next run tries again.
async function backfillFxHistory(): Promise<{ ok: boolean; added?: number; skipped?: boolean; error?: string }> {
  const { count, error: countError } = await supabase
    .from("fx_rate_history")
    .select("day", { count: "exact", head: true })
    .eq("base", "AED")
    .eq("quote", "INR")
    .eq("source", "ecb");
  if (countError) return { ok: false, error: countError.message };
  if ((count ?? 0) > 0) return { ok: true, skipped: true };
  try {
    const res = await fetch(`https://api.frankfurter.dev/v1/${FX_HISTORY_FROM}..?base=USD&symbols=INR`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = historyRowsFromEcb(await res.json());
    if (!rows.length) throw new Error("Response had no INR rates");
    const { error } = await supabase.from("fx_rate_history").upsert(rows, { onConflict: "base,quote,day", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    return { ok: true, added: rows.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

type Holding = {
  id: string;
  currency: string;
  price_symbol: string;
  price_provider: "twelvedata" | "coingecko" | "mfapi" | "yahoo";
  price_fetch_fail_count: number;
};

// quotedAt is when the provider says the price was quoted: an exchange's last
// trade, or the date a fund's NAV is for. It is what priced_at records, so a
// stale quote reads as stale however recently it was fetched. Null when the
// provider gave no usable time.
type PriceResult = { price: number; dayChangePct: number | null; quotedAt: string | null } | { error: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Twelve Data's free tier caps at 8 credits/minute, and each symbol in a
// multi-symbol /quote call consumes its own credit — a batch of 12 blows
// straight past that limit and comes back as a global error (every symbol
// then reads as "not found", not a real per-symbol result). Chunk to 8 per
// call and pace a minute apart so real batches larger than 8 still succeed
// instead of failing outright.
const TWELVEDATA_BATCH_SIZE = 8;
const TWELVEDATA_BATCH_DELAY_MS = 61_000;

async function fetchTwelveDataBatch(symbols: string[]): Promise<Record<string, PriceResult>> {
  const out: Record<string, PriceResult> = {};
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
      out[s] = Number.isFinite(price) ? { price, dayChangePct: pct, quotedAt: quoteTime(row.last_quote_at ?? row.timestamp) } : { error: "No price in response" };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const s of symbols) out[s] = { error: message };
  }
  return out;
}

async function fetchTwelveData(symbols: string[]): Promise<Record<string, PriceResult>> {
  if (!TWELVEDATA_API_KEY) {
    const out: Record<string, PriceResult> = {};
    for (const s of symbols) out[s] = { error: "TWELVEDATA_API_KEY not configured" };
    return out;
  }
  const out: Record<string, PriceResult> = {};
  for (let i = 0; i < symbols.length; i += TWELVEDATA_BATCH_SIZE) {
    if (i > 0) await sleep(TWELVEDATA_BATCH_DELAY_MS);
    Object.assign(out, await fetchTwelveDataBatch(symbols.slice(i, i + TWELVEDATA_BATCH_SIZE)));
  }
  return out;
}

async function fetchCoinGecko(ids: string[]): Promise<Record<string, PriceResult>> {
  const out: Record<string, PriceResult> = {};
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids.join(","))}&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    for (const id of ids) {
      const row = body[id];
      if (!row || typeof row.usd !== "number") {
        out[id] = { error: "Coin not found" };
        continue;
      }
      out[id] = {
        price: row.usd,
        dayChangePct: typeof row.usd_24h_change === "number" ? row.usd_24h_change : null,
        quotedAt: quoteTime(row.last_updated_at),
      };
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
    return Number.isFinite(price) ? { price, dayChangePct, quotedAt: navQuoteTime(rows[0].date) } : { error: "No NAV in response" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// Yahoo Finance's undocumented chart endpoint — no key, no published rate
// limit, but no SLA either: it's here only because Twelve Data's free tier
// doesn't reach NSE-listed India equities or DFM-listed UAE equities at
// all. US/global equities and commodities stay on Twelve Data, which is
// documented and already verified working. Symbol is Yahoo's own ticker
// (e.g. "RELIANCE.NS" for NSE, "EMAAR.AE" for Dubai, plain "AAPL" for US).
async function fetchYahoo(symbol: string): Promise<PriceResult> {
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" },
    });
    const body = await res.json();
    if (!res.ok || body?.chart?.error) {
      throw new Error(body?.chart?.error?.description ?? `HTTP ${res.status}`);
    }
    const meta = body?.chart?.result?.[0]?.meta;
    const price = Number(meta?.regularMarketPrice);
    const pct = meta?.regularMarketChangePercent != null ? Number(meta.regularMarketChangePercent) : null;
    return Number.isFinite(price) ? { price, dayChangePct: pct, quotedAt: quoteTime(meta?.regularMarketTime) } : { error: "No price in response" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function refreshHoldings() {
  // A holding sold to zero is closed: it keeps its history and needs no price.
  const { data: holdings, error } = await supabase
    .from("holdings")
    .select("id, currency, price_symbol, price_provider, price_fetch_fail_count")
    .not("price_symbol", "is", null)
    .not("price_provider", "is", null)
    .or("quantity.is.null,quantity.gt.0");
  if (error || !holdings) return { updated: 0, failed: 0, historyCaptured: 0 };

  const byProvider = new Map<string, Holding[]>();
  for (const h of holdings as Holding[]) {
    if (!byProvider.has(h.price_provider)) byProvider.set(h.price_provider, []);
    byProvider.get(h.price_provider)!.push(h);
  }

  const results = new Map<string, PriceResult>(); // holding id -> result
  const twelvedata = byProvider.get("twelvedata") ?? [];
  if (twelvedata.length) {
    // Multiple holdings (different lots) can share the same symbol —
    // dedupe before spending API credits, then fan the shared result back
    // out to every holding that uses it.
    const uniqueSymbols = [...new Set(twelvedata.map((h) => h.price_symbol))];
    const prices = await fetchTwelveData(uniqueSymbols);
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
  const yahoo = byProvider.get("yahoo") ?? [];
  for (const h of yahoo) {
    results.set(h.id, await fetchYahoo(h.price_symbol));
  }

  let updated = 0;
  let failed = 0;
  let historyCaptured = 0;
  const nowIso = new Date().toISOString();

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
    // set_holding_price writes the price and works the AED value, and today's
    // history point (dated the household's day), from the holding's units as
    // they are at that moment, under a row lock. Working it here from units
    // read at the start of the run could write over a trade saved since
    // (docs/decisions.md, "The price feed values a holding as it writes"). A
    // holding with no units, or a rupee one with no rate, keeps its entered
    // value: nothing is guessed.
    //
    // priced_at is how old the price is, and staleness (isStale,
    // daysSincePriced) is measured against it: the provider's quote time,
    // not this run's. A quote with no usable time leaves priced_at where
    // it was, so the holding goes on ageing rather than looking fresh.
    // The holdings_sync_priced_at trigger mirrors priced_at onto
    // last_refreshed for any remaining legacy reader.
    const { data: valueAed, error: writeError } = await supabase.rpc("set_holding_price", {
      p_holding_id: h.id,
      p_price: result.price,
      p_day_change_pct: result.dayChangePct,
      p_quoted_at: result.quotedAt ?? null,
      p_fetched_at: nowIso,
    });
    if (!writeError && valueAed !== null) historyCaptured++;
  }
  return { updated, failed, historyCaptured };
}

// The Wealth screen calls this from the browser (supabase.functions.invoke),
// which sends a CORS preflight first. The preflight is answered here without
// doing any work. The handler used to treat every request alike, so a
// preflight that reached it ran a whole refresh, and no answer carried CORS
// headers, which a browser needs before it hands the result to the page.
// CORS is not the security boundary -- the token check below is.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

// Two callers may refresh: the weekday job, which sends the vault's scheduler
// secret, and a signed-in member of a household pressing Refresh. verify_jwt
// is off (the job sends no JWT), so anyone who can reach the URL gets here:
// the publishable key's anonymous role, any login, or no credentials at all,
// each able to spend the price feed's daily quota and rewrite every
// household's FX rate. A request that presents a scheduler secret is judged
// on that alone, so a wrong secret is refused even beside a valid login. A
// user token is checked with the Auth server, which verifies its signature,
// before its membership is looked up.
async function callerMayRefresh(req: Request): Promise<boolean> {
  const presented = presentedSchedulerSecret(req);
  if (presented !== null) return await schedulerSecretMatches(presented, () => supabase.rpc("get_scheduler_secret"));
  const token = bearerToken(req);
  if (!token) return false;
  const { data: auth, error } = await supabase.auth.getUser(token);
  if (error || !auth?.user) return false;
  const { data: member, error: memberError } = await supabase
    .from("household_members")
    .select("id")
    .eq("user_id", auth.user.id)
    .limit(1)
    .maybeSingle();
  return !memberError && member !== null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
  if (!(await callerMayRefresh(req))) return jsonResponse({ error: "forbidden" }, 403);

  // Sequential, not parallel: holdings priced in INR are valued in the
  // database from the household's rate, which refreshFx stores first (or the
  // last good one stays).
  const fx = await refreshFx();
  const fxHistory = await backfillFxHistory();
  const holdings = await refreshHoldings();
  return jsonResponse({ fx, fxHistory, holdings });
});
