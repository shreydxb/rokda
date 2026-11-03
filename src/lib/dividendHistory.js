// What a share has paid, read from the feed's events (SHR-366, spec 4.3):
// each payment on today's basis, its one-off part, how often the share pays,
// and how long it usually takes from ex-date to payment. Pure: the tab reads
// the events, splits and the household's answers, and passes them in.

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const toDate = (day) => new Date(`${day}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);

export function addDays(day, n) {
  const d = toDate(day);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}

// Whole months later (or earlier), the day clamped to the month's length.
export function addMonths(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))));
}

export function daysBetween(from, to) {
  return Math.round((toDate(to) - toDate(from)) / 86400000);
}

// Whole calendar months from one day to another.
function wholeMonths(from, to) {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// The market a share is listed in, for the shares the feeds cover.
export function marketOf(holding) {
  if (holding?.asset_class === 'india_equity') return 'IN';
  if (holding?.asset_class === 'us_equity' || holding?.asset_class === 'intl_equity') return 'US';
  return null;
}

// A split the feed lists and a split a member recorded as a trade are the
// same split when their ratios match and their dates are within a month: a
// member may record it when the new shares arrive, not on the effective day.
const SAME_SPLIT_DAYS = 31;
export function sameSplit(feedSplit, trade) {
  return Number(feedSplit.ratio) === Number(trade.units) && Math.abs(daysBetween(feedSplit.effective_date, trade.trade_date)) <= SAME_SPLIT_DAYS;
}

// The feed's splits, and each split the holdings' trades show that the feed
// has not listed yet (a US share's splits are checked only monthly). Without
// it, a past amount on the old basis would be projected at the new units.
export function splitsWithTrades(splits, trades, holdings) {
  const symbolOf = new Map((holdings ?? []).map((h) => [h.id, h.price_symbol]));
  const out = [...(splits ?? [])];
  for (const t of trades ?? []) {
    const symbol = symbolOf.get(t.holding_id);
    if (t.kind !== 'split' || !symbol || !(Number(t.units) > 0)) continue;
    if (out.some((s) => s.symbol === symbol && sameSplit(s, t))) continue;
    out.push({ symbol, effective_date: t.trade_date, ratio: Number(t.units) });
  }
  return out;
}

// What a past amount per share is divided by to put it on today's basis:
// the ratios of the share's splits after its ex-date. A split taking effect
// on the ex-date itself is that ex-date's own basis.
export function todayFactor(symbol, exDate, splits) {
  return (splits ?? [])
    .filter((s) => s.symbol === symbol && s.effective_date > exDate)
    .reduce((factor, s) => factor * Number(s.ratio), 1);
}

// A share's payments up to today, oldest first: the events the source still
// lists, each with its amount on today's basis and its one-off part. A
// member's answer rules; without one, a payment more than twice the median
// of the share's payments in the 24 months before it (at least three of
// them, on today's basis) is a candidate, its excess over that median left
// out until answered.
export function sharePayments(events, symbol, { splits = [], specialParts = [], today }) {
  const answers = new Map((specialParts ?? []).map((p) => [p.event_id, Number(p.special_per_share)]));
  const listed = (events ?? [])
    .filter((e) => e.symbol === symbol && e.superseded_by == null && Number(e.missed_checks ?? 0) < 2 && e.ex_date <= today)
    .sort((a, b) => (a.ex_date < b.ex_date ? -1 : a.ex_date > b.ex_date ? 1 : 0));
  const out = [];
  for (const e of listed) {
    const amount = Number(e.amount);
    const factor = todayFactor(symbol, e.ex_date, splits);
    const todayAmount = round6(amount / factor);
    let special = 0;
    let oneOff = null;
    if (answers.has(e.id)) {
      special = answers.get(e.id);
      oneOff = 'answered';
    } else {
      const from = addMonths(e.ex_date, -24);
      const earlier = out.filter((p) => p.exDate >= from && p.exDate < e.ex_date).map((p) => p.todayAmount);
      if (earlier.length >= 3) {
        const usual = median(earlier);
        if (todayAmount > 2 * usual) {
          oneOff = 'candidate';
          special = round6(amount - usual * factor);
        }
      }
    }
    const ordinary = round6(amount - special);
    out.push({
      eventId: e.id, exDate: e.ex_date, payDate: e.pay_date ?? null, amount, factor, todayAmount, special, ordinary,
      ordinaryToday: round6(ordinary / factor), oneOff,
    });
  }
  return out;
}

const KINDS = [['yearly', 1], ['half-yearly', 2], ['quarterly', 4], ['monthly', 12]];

// How often a share pays: its ordinary payments in the last 24 months, or
// over what the source covers when that is shorter, as payments a year. The
// nearest of yearly, half-yearly, quarterly and monthly when within a
// quarter of it, else irregular. Fewer than two payments in a shorter history
// is too new to say; none in 24 months, none found.
export function shareFrequency(payments, coveredFrom, today) {
  const since = addMonths(today, -24);
  const count = (payments ?? []).filter((p) => p.exDate > since && p.exDate <= today && p.ordinary > 0).length;
  const covered = coveredFrom ? Math.max(1, Math.min(24, wholeMonths(coveredFrom, today))) : 24;
  if (count < 2 && covered < 24) return { kind: 'too_new', perYear: null, intervalMonths: null };
  if (count === 0) return { kind: 'none', perYear: 0, intervalMonths: null };
  const perYear = round6((count * 12) / covered);
  const near = KINDS.find(([, v]) => Math.abs(perYear - v) / v < 0.25);
  return { kind: near ? near[0] : 'irregular', perYear, intervalMonths: round6(12 / perYear) };
}

// Days from ex-date to payment, as the share usually takes: the median of
// the gaps the source gives, or 30 days with none.
export function usualGapDays(payments) {
  const gaps = (payments ?? []).filter((p) => p.exDate && p.payDate).map((p) => daysBetween(p.exDate, p.payDate));
  return gaps.length ? Math.round(median(gaps)) : 30;
}
