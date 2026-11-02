// What the dividend feed reads, and which checks it makes on a night.
//
// Yahoo's chart endpoint gives an NSE share's dividends (ex-date and amount,
// no payment date) and its splits, bonus issues included, in one call; its
// past amounts are adjusted for later splits, which the database undoes.
// Alpha Vantage gives a US-listed share's dividends with every date, as paid,
// and its splits in a separate call, on a free key of 25 calls a day. Every
// check asks for the whole history, so a gap of any length is caught up by one
// success, and what a check does not list the source no longer has.
//
// A response that does not read as the source's list, or has an item that
// cannot be read, is a failure, never an empty or shorter list: that would
// read as dividends the source had dropped.

export type DividendItem = {
  ex_date: string;
  amount: number;
  currency: string | null;
  pay_date: string | null;
  record_date: string | null;
  declared_on: string | null;
};

export type SplitItem = { effective_date: string; ratio: number };

export type FetchResult<T> = { ok: true; items: T[]; covered_from: string | null } | { ok: false; error: string };

// One share the feed follows, as dividend_symbols() returns it.
export type FollowedSymbol = {
  symbol: string;
  provider: "yahoo" | "alphavantage";
  held: boolean;
  dividends_last_success_at: string | null;
  splits_last_success_at: string | null;
  ex_passed_since_success: boolean;
  needs_splits: boolean;
};

export type AlphaVantageCall = { fn: "DIVIDENDS" | "SPLITS"; symbol: string };

export function yahooUrl(symbol: string): string {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=max&interval=1mo&events=div,split`;
}

export function alphaVantageUrl(fn: "DIVIDENDS" | "SPLITS", symbol: string, key: string): string {
  return `https://www.alphavantage.co/query?function=${fn}&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`;
}

// A timestamp in seconds as a date in the exchange's own calendar: an Indian
// dividend's ex-date is the day in India, whatever the time in UTC.
function localDate(seconds: number, timeZone: string): string | null {
  if (!Number.isFinite(seconds)) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(seconds * 1000));
  } catch {
    return null;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Alpha Vantage writes a missing date as "None".
function avDate(value: unknown): string | null {
  return typeof value === "string" && ISO_DATE.test(value) ? value : null;
}

function earliest(dates: string[]): string | null {
  return dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null;
}

export function parseYahooChart(body: unknown): { dividends: FetchResult<DividendItem>; splits: FetchResult<SplitItem> } {
  // deno-lint-ignore no-explicit-any
  const chart = (body as any)?.chart;
  const result = chart?.result?.[0];
  if (!result || typeof result !== "object") {
    const error = String(chart?.error?.description ?? chart?.error?.code ?? "no chart in the response");
    return { dividends: { ok: false, error }, splits: { ok: false, error } };
  }
  const timeZone = typeof result.meta?.exchangeTimezoneName === "string" ? result.meta.exchangeTimezoneName : "UTC";
  const currency = typeof result.meta?.currency === "string" ? result.meta.currency : null;
  const coveredFrom = localDate(Number(result.meta?.firstTradeDate), timeZone);

  // A share that never paid has no events at all: no dividends, which the
  // database refuses as an answer for a share it has seen pay.
  let dividends: FetchResult<DividendItem> = { ok: true, items: [], covered_from: coveredFrom };
  for (const event of Object.values(result.events?.dividends ?? {}) as Array<{ amount?: unknown; date?: unknown }>) {
    const exDate = localDate(Number(event?.date), timeZone);
    const amount = Number(event?.amount);
    if (!exDate || !Number.isFinite(amount) || amount < 0) {
      dividends = { ok: false, error: "a dividend in the answer could not be read" };
      break;
    }
    // A zero entry pays nothing, so it earns nothing.
    if (amount > 0) dividends.items.push({ ex_date: exDate, amount, currency, pay_date: null, record_date: null, declared_on: null });
  }
  let splits: FetchResult<SplitItem> = { ok: true, items: [], covered_from: coveredFrom };
  for (const event of Object.values(result.events?.splits ?? {}) as Array<{ numerator?: unknown; denominator?: unknown; date?: unknown }>) {
    const effective = localDate(Number(event?.date), timeZone);
    const ratio = Number(event?.numerator) / Number(event?.denominator);
    if (!effective || !Number.isFinite(ratio) || ratio <= 0) {
      splits = { ok: false, error: "a split in the answer could not be read" };
      break;
    }
    splits.items.push({ effective_date: effective, ratio });
  }
  return { dividends, splits };
}

// Alpha Vantage answers a limit or a bad key at HTTP 200 with a note instead
// of a list ("Information", "Note", "Error Message").
function avList(body: unknown): { ok: true; data: Record<string, unknown>[] } | { ok: false; error: string } {
  // deno-lint-ignore no-explicit-any
  const b = body as any;
  if (b && Array.isArray(b.data)) return { ok: true, data: b.data };
  const note = b?.Information ?? b?.Note ?? b?.["Error Message"];
  return { ok: false, error: typeof note === "string" ? note : "no list in the response" };
}

export function parseAlphaVantageDividends(body: unknown): FetchResult<DividendItem> {
  const list = avList(body);
  if (!list.ok) return list;
  const items: DividendItem[] = [];
  for (const row of list.data) {
    const exDate = avDate(row.ex_dividend_date);
    const amount = Number(row.amount);
    if (!exDate || !Number.isFinite(amount) || amount < 0) return { ok: false, error: "a dividend in the answer could not be read" };
    // A zero entry pays nothing, so it earns nothing.
    if (amount === 0) continue;
    items.push({
      ex_date: exDate,
      amount,
      currency: null,
      pay_date: avDate(row.payment_date),
      record_date: avDate(row.record_date),
      declared_on: avDate(row.declaration_date),
    });
  }
  return { ok: true, items, covered_from: earliest(items.map((d) => d.ex_date)) };
}

export function parseAlphaVantageSplits(body: unknown): FetchResult<SplitItem> {
  const list = avList(body);
  if (!list.ok) return list;
  const items: SplitItem[] = [];
  for (const row of list.data) {
    const effective = avDate(row.effective_date);
    const ratio = Number(row.split_factor);
    if (!effective || !Number.isFinite(ratio) || ratio <= 0) return { ok: false, error: "a split in the answer could not be read" };
    items.push({ effective_date: effective, ratio });
  }
  return { ok: true, items, covered_from: earliest(items.map((s) => s.effective_date)) };
}

const DAY = 86_400_000;

function olderThan(at: string | null, days: number, now: Date): boolean {
  return at === null || now.getTime() - Date.parse(at) > days * DAY;
}

// Oldest success first; never checked before anything checked.
function byLastSuccess(key: "dividends_last_success_at" | "splits_last_success_at") {
  return (a: FollowedSymbol, b: FollowedSymbol) => (a[key] ?? "").localeCompare(b[key] ?? "");
}

// Yahoo has no published limit and the price feed already calls it for each
// Indian share every weekday night: every held share is checked every night,
// a sold one weekly.
export function planYahooSymbols(symbols: FollowedSymbol[], now: Date): string[] {
  return symbols
    .filter((s) => s.provider === "yahoo" && (s.held || olderThan(s.dividends_last_success_at, 7, now)))
    .map((s) => s.symbol);
}

// At most `budget` Alpha Vantage calls a night, a fifth of the free allowance.
// Dividends first: a share whose ex-date has just passed (so it is earned the
// next morning), then one never checked, then held shares not checked for
// three days, oldest first, then sold ones weekly. While any share's splits
// are due, one call is kept for them: a share whose past amounts just changed
// first, then any not checked for 30 days.
export function planAlphaVantageCalls(symbols: FollowedSymbol[], now: Date, budget = 5): AlphaVantageCall[] {
  const av = symbols.filter((s) => s.provider === "alphavantage");
  const byDividends = byLastSuccess("dividends_last_success_at");
  const seen = new Set<string>();
  const dividends: string[] = [];
  const add = (list: FollowedSymbol[]) => {
    for (const s of list) if (!seen.has(s.symbol)) { seen.add(s.symbol); dividends.push(s.symbol); }
  };
  add(av.filter((s) => s.ex_passed_since_success).sort(byDividends));
  add(av.filter((s) => s.dividends_last_success_at === null));
  add(av.filter((s) => s.held && olderThan(s.dividends_last_success_at, 3, now)).sort(byDividends));
  add(av.filter((s) => !s.held && olderThan(s.dividends_last_success_at, 7, now)).sort(byDividends));

  const splits = [
    ...av.filter((s) => s.needs_splits),
    ...av.filter((s) => !s.needs_splits && olderThan(s.splits_last_success_at, 30, now)).sort(byLastSuccess("splits_last_success_at")),
  ].map((s) => s.symbol);

  const dividendCalls = dividends.slice(0, splits.length ? budget - 1 : budget);
  const splitCalls = splits.slice(0, budget - dividendCalls.length);
  return [
    ...dividendCalls.map((symbol) => ({ fn: "DIVIDENDS" as const, symbol })),
    ...splitCalls.map((symbol) => ({ fn: "SPLITS" as const, symbol })),
  ];
}
