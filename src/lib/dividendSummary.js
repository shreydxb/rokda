// What the Dividends tab shows, in dirhams and in the screen's scope
// (SHR-366, spec 4.2, 4.5 and 6). Pure: buildDividendInput reads the screen's
// data once, and every summary takes the object it builds.
//
// Dirhams are worked out when read, never stored: earned and expected figures
// at the ex-date's rate, received ones at the credit date's, projections at
// today's. A rupee figure with no rate at all is left out of a total, and the
// total says how many it left out.
import { estimateAed } from './fxHistory';
import { scopedValue } from './scope';
import { paysDividends, visibleHoldings } from './holdings';
import { closedMonths } from './forecast';
import { addMonths, marketOf, sharePayments, shareFrequency, usualGapDays } from './dividendHistory';
import { forecastHolding, nextYearYields } from './dividendForecast';
import { formatPerShare, reviewText, shortDate } from './dividends';

const round2 = (n) => Math.round(n * 100) / 100;
const MARKETS = ['IN', 'US'];
const RECEIVED = new Set(['received', 'presumed']);

// The feed's provider for a holding, as the database decides it
// (private.dividend_provider): Yahoo for an Indian share priced from Yahoo,
// Alpha Vantage for a US-listed share in dollars. Null when not followed.
export function feedProvider(holding) {
  if (!holding?.price_symbol) return null;
  if (holding.asset_class === 'india_equity' && holding.price_provider === 'yahoo') return 'yahoo';
  if ((holding.asset_class === 'us_equity' || holding.asset_class === 'intl_equity') && holding.currency === 'USD') return 'alphavantage';
  return null;
}

function statusOf(input, holding) {
  const provider = feedProvider(holding);
  return (input.feedStatus ?? []).find((s) => s.symbol === holding.price_symbol && s.provider === provider && s.kind === 'dividends') ?? null;
}

// Where a fund's dividends land: the account it names, while open, else the
// fund itself (as private.dividend_destination). Null with no fund.
export function dividendDestination(holding, accounts) {
  const fund = (accounts ?? []).find((a) => a.id === holding?.funds_account_id);
  if (!fund) return null;
  const target = (accounts ?? []).find((a) => a.id === fund.dividends_into_account_id);
  return target && !target.archived_at ? target.id : fund.id;
}

// Everything the summaries read, from the screen's data, once.
export function buildDividendInput({ data, household, scopeMemberId, today }) {
  const holdings = visibleHoldings(data.holdings ?? [], scopeMemberId, 'All').filter((h) => paysDividends(h.asset_class));
  const ids = new Set(holdings.map((h) => h.id));
  const dividends = (data.holdingDividends ?? []).filter((d) => ids.has(d.holding_id));
  const events = data.dividendEvents ?? [];
  const splits = data.dividendSplits ?? [];
  const specialParts = data.dividendSpecialParts ?? [];
  const feedStatus = data.dividendFeedStatus ?? [];
  const input = {
    holdings, dividends, events, splits, specialParts, feedStatus, trades: data.holdingTrades ?? [], accounts: data.accounts ?? [],
    scopeMemberId, fx: { fxHistory: data.fxRateHistory ?? [], inrPerAed: household?.inr_per_aed ?? null }, today, payments: {}, forecasts: {},
  };
  for (const symbol of new Set(holdings.map((h) => h.price_symbol).filter(Boolean))) {
    input.payments[symbol] = sharePayments(events, symbol, { splits, specialParts, today });
  }
  for (const h of holdings) {
    const payments = input.payments[h.price_symbol] ?? [];
    const coveredFrom = statusOf(input, h)?.covered_from ?? null;
    const frequency = shareFrequency(payments, coveredFrom, today);
    const declared = events.filter((e) => e.symbol === h.price_symbol && e.superseded_by == null && Number(e.missed_checks ?? 0) < 2 && e.ex_date > today);
    const earnedUnpaid = dividends.filter((d) => d.holding_id === h.id && d.status === 'earned');
    input.forecasts[h.id] = {
      ...forecastHolding({ holding: h, payments, frequency, gapDays: usualGapDays(payments), declared, earnedUnpaid, coveredFrom, today }),
      frequency,
    };
  }
  return input;
}

const holdingById = (input) => new Map(input.holdings.map((h) => [h.id, h]));
const inScope = (input) => {
  const byId = holdingById(input);
  return input.dividends.filter((d) => byId.has(d.holding_id) && d.status !== 'skipped');
};

// A dividend's net in dirhams, scoped: received ones at the credit date's
// rate (a presumed one at its expected figure), others at the ex-date's.
function rowAed(input, d, holding, basis = 'received') {
  const received = basis === 'received' && RECEIVED.has(d.status);
  const amount = d.status === 'received' ? d.received_net : d.expected_net;
  const day = received ? d.credited_on : d.ex_date ?? d.credited_on;
  const value = estimateAed(Number(amount), holding.currency, day, input.fx.fxHistory, input.fx.inrPerAed);
  return value ? scopedValue(value.aed, holding, input.scopeMemberId) : null;
}

// A forecast item in dirhams, scoped: an earned one at its ex-date's rate,
// anything still to come at today's.
function itemAed(input, item, holding) {
  const earned = item.dividendId ? input.dividends.find((d) => d.id === item.dividendId) : null;
  const day = earned?.ex_date ?? input.today;
  const value = estimateAed(Number(item.net), item.currency ?? holding.currency, day, input.fx.fxHistory, input.fx.inrPerAed);
  return value ? scopedValue(value.aed, holding, input.scopeMemberId) : null;
}

// Received over the last twelve months: rows by credit date in (from, today].
function receivedSince(input, from, filter = () => true) {
  const byId = holdingById(input);
  let aed = 0;
  let presumedAed = 0;
  let notCounted = 0;
  for (const d of inScope(input)) {
    const h = byId.get(d.holding_id);
    if (!RECEIVED.has(d.status) || !d.credited_on || d.credited_on <= from || d.credited_on > input.today || !filter(h)) continue;
    const value = rowAed(input, d, h);
    if (value === null) {
      notCounted += 1;
      continue;
    }
    aed += value;
    if (d.status === 'presumed') presumedAed += value;
  }
  return { aed: round2(aed), presumedAed: round2(presumedAed), notCounted };
}

function expectedOf(input, filter = () => true) {
  let aed = 0;
  let notCounted = 0;
  for (const h of input.holdings) {
    if (!filter(h)) continue;
    for (const item of input.forecasts[h.id]?.items ?? []) {
      const value = itemAed(input, item, h);
      if (value === null) notCounted += 1;
      else aed += value;
    }
  }
  return { aed: round2(aed), notCounted };
}

// Where a market's record starts: its holdings' earliest opening entry, or an
// earlier receipt (an imported one). Null when it has neither.
function coverageStart(input, market) {
  const ids = new Set(input.holdings.filter((h) => marketOf(h) === market).map((h) => h.id));
  const days = [
    ...input.trades.filter((t) => t.kind === 'opening' && ids.has(t.holding_id)).map((t) => t.trade_date),
    ...input.dividends.filter((d) => ids.has(d.holding_id) && RECEIVED.has(d.status) && d.credited_on).map((d) => d.credited_on),
  ].sort();
  return days[0] ?? null;
}

const marketsPresent = (input) => MARKETS.filter((m) => input.holdings.some((h) => marketOf(h) === m));

export function dividendHeadline(input) {
  const yearAgo = addMonths(input.today, -12);
  const sinceOf = (start) => (start && start > yearAgo ? start : null);
  const markets = marketsPresent(input).map((market) => {
    const isMarket = (h) => marketOf(h) === market;
    const start = coverageStart(input, market);
    return { market, receivedAed: receivedSince(input, yearAgo, isMarket).aed, expectedAed: expectedOf(input, isMarket).aed, since: sinceOf(start), start };
  });
  const starts = marketsPresent(input).map((m) => coverageStart(input, m)).filter(Boolean).sort();
  const expected = expectedOf(input);
  return {
    received: { ...receivedSince(input, yearAgo), since: sinceOf(starts[0] ?? null) },
    expected: { ...expected, monthlyAed: round2(expected.aed / 12) },
    markets,
    coverageDiffers: markets.length > 1 && markets[0].since !== markets[1].since,
  };
}

// Earned and declared dividends still to come in, soonest first. Only an
// earned one paid into a broker's fund can be recorded here: a bank's is
// presumed, and a declared one is not earned yet.
export function comingUp(input) {
  const byId = holdingById(input);
  const accounts = new Map((input.accounts ?? []).map((a) => [a.id, a]));
  const out = [];
  for (const d of inScope(input)) {
    if (d.status !== 'earned') continue;
    const h = byId.get(d.holding_id);
    out.push({
      kind: 'earned', holdingId: h.id, dividendId: d.id, day: d.pay_date ?? null, month: d.pay_date ? null : (d.ex_date ?? '').slice(0, 7) || null,
      net: Number(d.expected_net), currency: h.currency, netAed: rowAed(input, d, h, 'earned'), destinationAccountId: d.paid_into_account_id ?? null,
      canRecord: accounts.get(d.paid_into_account_id)?.type === 'broker_funds',
    });
  }
  for (const h of input.holdings) {
    for (const item of input.forecasts[h.id]?.items ?? []) {
      if (item.kind !== 'declared') continue;
      out.push({
        kind: 'declared', holdingId: h.id, eventId: item.eventId, day: item.day, month: null, net: item.net, currency: item.currency ?? h.currency,
        netAed: itemAed(input, item, h), destinationAccountId: dividendDestination(h, input.accounts), canRecord: false,
      });
    }
  }
  const when = (x) => x.day ?? `${x.month ?? '9999'}-32`;
  return out.sort((a, b) => (when(a) < when(b) ? -1 : when(a) > when(b) ? 1 : 0));
}

// Month by month: what came in (presumed receipts apart) over up to 24
// months, and what is expected over the next twelve. The earned view puts
// each dividend in its ex-date's month instead, and counts the receipts it
// cannot place for want of an ex-date.
export function dividendsByMonth(input, view = 'received') {
  const byId = holdingById(input);
  const current = input.today.slice(0, 7);
  const first = addMonths(`${current}-01`, -23).slice(0, 7);
  const last = addMonths(`${current}-01`, 12).slice(0, 7);
  const months = [];
  for (let m = `${first}-01`; m.slice(0, 7) <= last; m = addMonths(m, 1)) months.push({ month: m.slice(0, 7), actualAed: 0, presumedAed: 0, expectedAed: 0 });
  const at = new Map(months.map((m) => [m.month, m]));
  let leftOut = 0;
  for (const d of inScope(input)) {
    const h = byId.get(d.holding_id);
    if (view === 'earned') {
      if (!d.ex_date) {
        if (RECEIVED.has(d.status)) leftOut += 1;
        continue;
      }
      const bucket = at.get(d.ex_date.slice(0, 7));
      const value = rowAed(input, d, h, 'earned');
      if (bucket && bucket.month <= current && value !== null) bucket.actualAed += value;
    } else {
      if (!RECEIVED.has(d.status) || !d.credited_on) continue;
      const bucket = at.get(d.credited_on.slice(0, 7));
      const value = rowAed(input, d, h);
      if (!bucket || bucket.month > current || value === null) continue;
      if (d.status === 'presumed') bucket.presumedAed += value;
      else bucket.actualAed += value;
    }
  }
  for (const h of input.holdings) {
    for (const item of input.forecasts[h.id]?.items ?? []) {
      const month = item.month ?? item.day?.slice(0, 7);
      const bucket = month ? at.get(month) : null;
      const value = itemAed(input, item, h);
      if (bucket && month >= current && value !== null) bucket.expectedAed += value;
    }
  }
  const years = new Map();
  for (const m of months) {
    m.actualAed = round2(m.actualAed);
    m.presumedAed = round2(m.presumedAed);
    m.expectedAed = round2(m.expectedAed);
    if (m.month > current) continue;
    const year = Number(m.month.slice(0, 4));
    years.set(year, round2((years.get(year) ?? 0) + m.actualAed + m.presumedAed));
  }
  return { months, years: [...years].map(([year, aed]) => ({ year, aed })), leftOut };
}

// Each holding with dividends found, most expected first, and the holdings
// without: none found since the source's coverage, checks failing, or not
// checked yet (just added, or not followed by the feed).
export function dividendsByHolding(input) {
  const yearAgo = addMonths(input.today, -12);
  const rows = [];
  const none = [];
  const failing = [];
  const notChecked = [];
  let since = null;
  for (const h of input.holdings) {
    const payments = input.payments[h.price_symbol] ?? [];
    const hasDividends = payments.length > 0 || input.dividends.some((d) => d.holding_id === h.id);
    const status = statusOf(input, h);
    if (hasDividends) {
      const forecast = input.forecasts[h.id] ?? { items: [], status: 'none', next: null, ordinaryPerShareNextYear: 0, frequency: null };
      const lastOrdinary = payments.filter((p) => p.ordinary > 0).at(-1);
      rows.push({
        holding: h, frequency: forecast.frequency ?? null, lastOrdinaryPerShare: lastOrdinary ? lastOrdinary.ordinaryToday : null,
        receivedAed: receivedSince(input, yearAgo, (x) => x.id === h.id).aed, expectedAed: expectedOf(input, (x) => x.id === h.id).aed,
        yields: nextYearYields(h, forecast.ordinaryPerShareNextYear), next: forecast.next, status: forecast.status,
      });
    } else if (status && Number(status.fail_count) > 0) {
      failing.push(h);
    } else if (!status || !status.last_success_at) {
      notChecked.push(h);
    } else {
      none.push(h);
      if (status.covered_from && (!since || status.covered_from > since)) since = status.covered_from;
    }
  }
  rows.sort((a, b) => b.expectedAed - a.expectedAed);
  return { rows, none: { since, holdings: none }, failing, notChecked };
}

// Where the next twelve months' dividends come from: by listing market, with
// what is withheld there, and by sector, unknown last.
export function dividendSources(input) {
  const markets = new Map();
  const sectors = new Map();
  for (const h of input.holdings) {
    const market = marketOf(h);
    const sector = h.sector || 'unknown';
    for (const item of input.forecasts[h.id]?.items ?? []) {
      const value = itemAed(input, item, h);
      if (value === null) continue;
      const m = markets.get(market) ?? { market, expectedAed: 0, gross: 0, withheld: 0 };
      m.expectedAed += value;
      m.gross += Number(item.gross);
      m.withheld += Number(item.withheld);
      markets.set(market, m);
      sectors.set(sector, (sectors.get(sector) ?? 0) + value);
    }
  }
  return {
    markets: [...markets.values()]
      .map((m) => ({ market: m.market, expectedAed: round2(m.expectedAed), withholdingPct: m.gross > 0 ? Math.round((m.withheld / m.gross) * 1000) / 10 : null }))
      .sort((a, b) => b.expectedAed - a.expectedAed),
    sectors: [...sectors]
      .map(([sector, aed]) => ({ sector, expectedAed: round2(aed) }))
      .sort((a, b) => (a.sector === 'unknown') - (b.sector === 'unknown') || b.expectedAed - a.expectedAed),
  };
}

// Dividends beside recorded spending, as the Life plan counts it: received
// over the last twelve closed months once every market's record covers them,
// else expected over the next twelve against a year at the average month.
// None with fewer than three closed months or no spending.
export function spendingEquivalent(input, { transactions, now }) {
  const closed = [...closedMonths(transactions ?? [], now, input.scopeMemberId)].slice(-12);
  if (closed.length < 3) return null;
  const spend = closed.reduce((sum, [, m]) => sum + m.spend, 0);
  if (!(spend > 0)) return null;
  const firstMonth = closed[0][0];
  const starts = marketsPresent(input).map((m) => coverageStart(input, m));
  const covered = closed.length >= 12 && starts.length > 0 && starts.every((s) => s && s.slice(0, 7) <= firstMonth);
  if (covered) {
    const keys = new Set(closed.map(([k]) => k));
    const byId = holdingById(input);
    let aed = 0;
    for (const d of inScope(input)) {
      if (!RECEIVED.has(d.status) || !d.credited_on || !keys.has(d.credited_on.slice(0, 7))) continue;
      aed += rowAed(input, d, byId.get(d.holding_id)) ?? 0;
    }
    return { pct: Math.round((aed / spend) * 1000) / 10, basis: 'received' };
  }
  const yearly = (spend / closed.length) * 12;
  return { pct: Math.round((expectedOf(input).aed / yearly) * 1000) / 10, basis: 'expected' };
}

// What needs a member: rows the feed flagged, payments that look like a
// one-off, splits the trades do not show, and dividends the feed could not
// make (a pay date before the ex-date, or a split on the ex-date).
export function needsYou(input) {
  const out = [];
  const byId = holdingById(input);
  for (const d of inScope(input)) {
    if (d.review_reason) out.push({ kind: 'flagged', holdingId: d.holding_id, dividendId: d.id, text: reviewText(d) });
  }
  const twoYearsAgo = addMonths(input.today, -24);
  const seen = new Set();
  for (const h of input.holdings) {
    for (const p of input.payments[h.price_symbol] ?? []) {
      if (p.oneOff !== 'candidate' || p.exDate <= twoYearsAgo || seen.has(p.eventId)) continue;
      seen.add(p.eventId);
      out.push({
        kind: 'one_off', holdingId: h.id, eventId: p.eventId, special: p.special,
        text: `${h.name} paid ${formatPerShare(p.amount)} a share on ${shortDate(p.exDate, input.today)}, more than twice its usual. Was part of it a one-off?`,
      });
    }
    const opening = input.trades.find((t) => t.holding_id === h.id && t.kind === 'opening')?.trade_date;
    if (!opening) continue;
    const splitsOn = new Set((input.splits ?? []).filter((s) => s.symbol === h.price_symbol).map((s) => s.effective_date));
    for (const s of input.splits ?? []) {
      if (s.symbol !== h.price_symbol || s.effective_date <= opening || s.effective_date > input.today) continue;
      if (input.trades.some((t) => t.holding_id === h.id && t.kind === 'split' && t.trade_date === s.effective_date)) continue;
      out.push({
        kind: 'split_not_traded', holdingId: h.id,
        text: `${h.name} split ${Number(s.ratio)} for 1 on ${shortDate(s.effective_date, input.today)}, but its trades don't show it.`,
      });
    }
    for (const e of input.events ?? []) {
      if (e.symbol !== h.price_symbol || e.superseded_by != null || Number(e.missed_checks ?? 0) >= 2) continue;
      if (e.ex_date <= opening || e.ex_date > input.today) continue;
      const early = e.pay_date && e.pay_date < e.ex_date;
      if (!early && !splitsOn.has(e.ex_date)) continue;
      if (input.dividends.some((d) => d.holding_id === h.id && (d.event_id === e.id || d.ex_date === e.ex_date))) continue;
      const why = early ? 'its pay date is before its ex-date' : 'a split took effect that day';
      out.push({ kind: 'add_by_hand', holdingId: h.id, eventId: e.id, text: `${h.name}'s dividend of ${shortDate(e.ex_date, input.today)} needs adding by hand: ${why}.` });
    }
  }
  return out.filter((x) => byId.has(x.holdingId));
}

// How fresh each market's feed is: its last success, its shares failing and
// since when, the date from which all its shares are covered, and whether it
// has ever run.
export function feedFreshness(input) {
  return marketsPresent(input).map((market) => {
    const statuses = input.holdings
      .filter((h) => marketOf(h) === market && feedProvider(h))
      .map((h) => statusOf(input, h))
      .filter(Boolean);
    const unique = [...new Map(statuses.map((s) => [s.symbol, s])).values()];
    const successes = unique.map((s) => s.last_success_at).filter(Boolean).sort();
    const covered = unique.map((s) => s.covered_from).filter(Boolean).sort();
    return {
      market,
      lastSuccessAt: successes.at(-1) ?? null,
      coveredFrom: covered.at(-1) ?? null,
      failing: unique.filter((s) => Number(s.fail_count) > 0).map((s) => ({ symbol: s.symbol, since: s.last_success_at ?? null })),
      neverRun: successes.length === 0,
    };
  });
}
