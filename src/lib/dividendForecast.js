// The next twelve months of a holding's dividends, as a cash forecast
// (SHR-366, spec 4.4). Each item is the holding's whole figure in its own
// currency, before the screen's scope or dirhams. Labelled a projection on
// screen: it assumes today's units, the holding's current withholding and
// fees, and that a share keeps paying what it paid.
import { addDays, addMonths, daysBetween } from './dividendHistory';

// Four places in the holding's own currency, as the database keeps them
// (private.dividend_expected): rounding to two here and again after the
// conversion to dirhams moved a total by a fils or more (outside review,
// B-12). The screen rounds once, in what it shows.
const round4 = (n) => Math.round(n * 1e4) / 1e4;
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const DAYS_A_MONTH = 30.4375;

// An item's place in time, for ordering: a day, or the end of a month.
const when = (item) => item.day ?? (item.month ? `${item.month}-32` : '9999');

export function forecastHolding({ holding, payments = [], frequency, gapDays = 30, declared = [], earnedUnpaid = [], today }) {
  const units = Number(holding.quantity) || 0;
  const currency = holding.currency;
  const taxPct = Number(holding.dividend_tax_pct ?? 0);
  const feePerShare = Number(holding.dividend_fee_per_share ?? 0);
  const item = (kind, perShare, extra) => {
    const gross = round4(units * perShare);
    const withheld = round4((gross * taxPct) / 100);
    // Never more than is left after withholding, as the database caps them
    // (private.dividend_expected): a forecast is not a negative receipt.
    const fees = Math.min(round4(units * feePerShare), round4(gross - withheld));
    return { kind, day: null, month: null, gross, withheld, fees, net: round4(gross - withheld - fees), currency, ...extra };
  };

  // Earned and not yet received: what is owed, whatever is held now.
  const items = (earnedUnpaid ?? []).map((d) => ({
    kind: 'earned', dividendId: d.id, day: d.pay_date ?? null, month: d.pay_date ? null : addDays(d.ex_date, gapDays).slice(0, 7),
    gross: Number(d.expected_gross), withheld: Number(d.expected_tax), fees: Number(d.expected_fees), net: Number(d.expected_net), currency,
  }));
  // What a share pays in the next twelve months, for its yield: an earned one
  // pays in them too, so the yield reads the same either side of its ex-date.
  let perShareYear = (earnedUnpaid ?? []).reduce((sum, d) => sum + (Number(d.per_share) || 0), 0);
  let status;

  if (units <= 0) {
    status = 'not_held';
  } else {
    // Declared: counted in full, special part and all, since it is declared.
    for (const e of declared ?? []) {
      items.push(item('declared', Number(e.amount), { eventId: e.id, exDate: e.ex_date, day: e.pay_date ?? addDays(e.ex_date, gapDays) }));
      perShareYear += Number(e.amount);
    }
    const ordinaries = payments.filter((p) => p.ordinary > 0);
    const last = ordinaries.at(-1);
    if (frequency.kind === 'too_new') {
      status = 'not_enough_history';
    } else if (frequency.kind === 'none') {
      status = (declared ?? []).length ? 'ok' : 'none';
    } else if (!(declared ?? []).length && last && daysBetween(last.exDate, today) / DAYS_A_MONTH > 1.5 * frequency.intervalMonths) {
      status = 'may_have_stopped';
    } else if (frequency.kind === 'irregular') {
      const since = addMonths(today, -24);
      const perYear = round6(ordinaries.filter((p) => p.exDate > since).reduce((sum, p) => sum + p.ordinaryToday, 0) / 2);
      items.push(item('irregular', perYear, {}));
      perShareYear += perYear;
      status = 'irregular';
    } else {
      // Each ordinary payment of the last twelve months, a year on. A
      // declaration replaces at most one of them: the nearest by ex-date,
      // within half the share's usual interval.
      const since = addMonths(today, -12);
      const projected = ordinaries.filter((p) => p.exDate > since).map((p) => ({ exDate: addMonths(p.exDate, 12), perShare: p.ordinaryToday }));
      const halfInterval = (frequency.intervalMonths * DAYS_A_MONTH) / 2;
      for (const e of declared ?? []) {
        let best = -1;
        let bestGap = Infinity;
        projected.forEach((p, i) => {
          const gap = Math.abs(daysBetween(p.exDate, e.ex_date));
          if (gap <= halfInterval && gap < bestGap) {
            best = i;
            bestGap = gap;
          }
        });
        if (best >= 0) projected.splice(best, 1);
      }
      // Only what is paid within the twelve months: the payment earned and not
      // yet paid is counted as earned above, and its repeat a year on is paid
      // after them.
      const end = addMonths(today, 12);
      for (const p of projected) {
        const payDay = addDays(p.exDate, gapDays);
        if (payDay > end) continue;
        items.push(item('projected', p.perShare, { month: payDay.slice(0, 7) }));
        perShareYear += p.perShare;
      }
      status = 'ok';
    }
  }

  items.sort((a, b) => (when(a) < when(b) ? -1 : when(a) > when(b) ? 1 : 0));
  const dated = items.find((i) => i.day && (i.kind === 'earned' || i.kind === 'declared'));
  const monthly = items.find((i) => i.month);
  const next = dated ? { day: dated.day } : monthly ? { month: monthly.month } : null;
  return { items, status, next, ordinaryPerShareNextYear: round6(perShareYear) };
}

// The next twelve months' amount per share, before withholding, over today's
// price and over the average price paid. None without that price.
export function nextYearYields(holding, ordinaryPerShareNextYear) {
  const price = Number(holding.current_price);
  const cost = Number(holding.avg_price);
  const perShare = Number(ordinaryPerShareNextYear) || 0;
  return {
    onValue: price > 0 ? round6(perShare / price) : null,
    onCost: cost > 0 ? round6(perShare / cost) : null,
  };
}
