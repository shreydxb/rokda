// SHR-366: the nightly dividend run. Reads what each followed share pays from
// Yahoo (Indian shares) and Alpha Vantage (US-listed shares), records each
// answer through record_dividend_fetch (which keeps every amount on its
// ex-date's share basis and marks what the source still lists), then has the
// database record what each holding earned (earn_dividends). Nothing here
// works out a dividend: the database does, from the trades.
//
// Only the daily job (daily-dividend-refresh) runs this, recognised by the
// scheduler secret it sends from the vault; verify_jwt is off, as for
// fd-accrual and price-refresh. Nothing in the app calls it.
import "jsr:@supabase/functions-js@2.117.2/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2.117.2";
import { presentedSchedulerSecret, schedulerSecretMatches } from "../_shared/requestAuth.ts";
import {
  alphaVantageUrl,
  type FetchResult,
  type FollowedSymbol,
  parseAlphaVantageDividends,
  parseAlphaVantageSplits,
  parseYahooChart,
  planAlphaVantageCalls,
  planYahooSymbols,
  redactSecrets,
  yahooUrl,
} from "./sources.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Alpha Vantage's free key is reported to allow five calls a minute, so its
// calls are spaced twelve seconds apart. Replaceable so tests need not wait.
export const timing = { sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };
const ALPHA_VANTAGE_SPACING_MS = 12_000;

const JSON_HEADERS = { "Content-Type": "application/json" };

// A response's JSON, or a thrown error when there is none to read. Yahoo
// answers an unknown symbol with a 404 that still carries its error, which
// the parser reads as a failure.
async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  if (body === null && !res.ok) throw new Error(`HTTP ${res.status}`);
  return body;
}

function failure(err: unknown): { ok: false; error: string } {
  return { ok: false, error: redactSecrets(err instanceof Error ? err.message : String(err)) };
}

async function record(symbol: string, provider: string, kind: "dividends" | "splits", result: FetchResult<unknown>): Promise<boolean> {
  const { error } = await supabase.rpc("record_dividend_fetch", { p_symbol: symbol, p_provider: provider, p_kind: kind, p_result: result });
  return !error && result.ok;
}

Deno.serve(async (req) => {
  if (!(await schedulerSecretMatches(presentedSchedulerSecret(req), () => supabase.rpc("get_scheduler_secret")))) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: JSON_HEADERS });
  }

  const { data: rows, error } = await supabase.rpc("dividend_symbols");
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: JSON_HEADERS });
  }
  const symbols = (Array.isArray(rows) ? rows : []) as FollowedSymbol[];
  const now = new Date();
  let yahoo = 0;
  let alphavantage = 0;
  let failures = 0;

  // Splits first, so the dividends recorded next are put back on their
  // ex-date's basis from splits the same answer gave.
  for (const symbol of planYahooSymbols(symbols, now)) {
    let parsed: ReturnType<typeof parseYahooChart>;
    try {
      parsed = parseYahooChart(await fetchJson(yahooUrl(symbol), {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" },
      }));
    } catch (err) {
      parsed = { dividends: failure(err), splits: failure(err) };
    }
    const splitsOk = await record(symbol, "yahoo", "splits", parsed.splits);
    const dividendsOk = await record(symbol, "yahoo", "dividends", parsed.dividends);
    yahoo += 1;
    if (!splitsOk || !dividendsOk) failures += 1;
  }

  const key = Deno.env.get("ALPHAVANTAGE_API_KEY");
  if (key) {
    const calls = planAlphaVantageCalls(symbols, now);
    for (let i = 0; i < calls.length; i++) {
      if (i > 0) await timing.sleep(ALPHA_VANTAGE_SPACING_MS);
      const { fn, symbol } = calls[i];
      let result: FetchResult<unknown>;
      try {
        const body = await fetchJson(alphaVantageUrl(fn, symbol, key));
        result = fn === "DIVIDENDS" ? parseAlphaVantageDividends(body) : parseAlphaVantageSplits(body);
      } catch (err) {
        result = failure(err);
      }
      const ok = await record(symbol, "alphavantage", fn === "DIVIDENDS" ? "dividends" : "splits", result);
      alphavantage += 1;
      if (!ok) failures += 1;
    }
  }

  const { data: earned, error: earnError } = await supabase.rpc("earn_dividends");
  return new Response(
    JSON.stringify({ yahoo, alphavantage, failures, alphavantage_key: Boolean(key), earned: earnError ? { error: earnError.message } : earned }),
    { headers: JSON_HEADERS },
  );
});
