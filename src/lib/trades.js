// A holding's trades as the app shows them (SHR-371; docs/decisions.md,
// "Trades are the record of a holding" and "Trades in the app"). Every figure a
// trade produces -- units and average after it, its profit, its fund's
// movement, its warnings -- is worked out by the database (preview_trade and
// the replay behind it). This file only words those figures, and adds up the
// profit sales have already recorded; it never works out a trade itself.

import { formatMoney } from './money';
import { estimateAed } from './fxHistory';
import { scopedValue } from './scope';
import { householdToday } from './day';

export const TRADE_KIND_LABELS = { opening: 'Opening', buy: 'Buy', sell: 'Sell', split: 'Split' };

// The replay's order (private.replay_entries): trade date; on one day the
// opening first; then the time of the trade where known, untimed ones last;
// then when it was recorded; then the id. Shown newest first, so the list
// reads as the exact reverse of how the database adds it up.
function replayOrder(a, b) {
  if (a.trade_date !== b.trade_date) return a.trade_date < b.trade_date ? -1 : 1;
  const aOpening = a.kind === 'opening';
  const bOpening = b.kind === 'opening';
  if (aOpening !== bOpening) return aOpening ? -1 : 1;
  const byLater = (x, y) => (x === y ? 0 : x == null ? 1 : y == null ? -1 : x < y ? -1 : 1);
  return byLater(a.traded_at, b.traded_at) || byLater(a.created_at, b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function tradesOfHolding(trades, holdingId) {
  return (trades ?? []).filter((t) => t.holding_id === holdingId).sort(replayOrder).reverse();
}

// Only a buy or a sale stops a holding being deleted (the database's guard);
// its opening entry and splits go with it.
export function hasBuysOrSales(trades, holdingId) {
  return (trades ?? []).some((t) => t.holding_id === holdingId && (t.kind === 'buy' || t.kind === 'sell'));
}

const unitsFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 8 });

// Units are kept to eight decimals because a fractional US share has them; a
// rounded figure would not match the broker's, and selling "all" of a rounded
// holding would read as selling more than is held.
export function formatUnits(n) {
  return unitsFormat.format(Number(n) || 0);
}

const money2 = (n) => formatMoney(n, { decimals: 2 });
const signedMoney = (currency, n) => `${currency} ${Number(n) < 0 ? '-' : ''}${money2(n)}`;

// A stored `date` is a calendar day: read it at UTC midnight and format it in
// UTC, so no browser time zone moves it to the day before.
function dayLabel(date, withYear) {
  const opts = { day: 'numeric', month: 'short', timeZone: 'UTC', ...(withYear ? { year: 'numeric' } : {}) };
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', opts);
}

// The two lines a trade shows in the holding editor: what it was, then when,
// with its brokerage, tax and what it made.
export function tradeRow(trade, currency) {
  const title =
    trade.kind === 'split'
      ? `Split ${formatUnits(trade.units)} for 1`
      : `${TRADE_KIND_LABELS[trade.kind] ?? trade.kind} ${formatUnits(trade.units)} at ${currency} ${money2(trade.price)}`;
  const parts = [dayLabel(trade.trade_date, true)];
  if (Number(trade.fees) > 0) parts.push(`brokerage ${money2(trade.fees)}`);
  if (Number(trade.tax_withheld) > 0) parts.push(`tax ${money2(trade.tax_withheld)}`);
  if (trade.kind === 'sell' && trade.realised != null) {
    parts.push(Number(trade.realised) < 0 ? `loss ${money2(-Number(trade.realised))}` : `profit ${money2(trade.realised)}`);
  }
  if (trade.tax_to_confirm) parts.push('tax to confirm');
  return { title, detail: parts.join(' · ') };
}

const round2 = (n) => Math.round(n * 100) / 100;

// What sales on the given holdings made, in dirhams: each sale's recorded
// profit at its own date's rate (dollars at the peg, rupees at that day's
// rate or, failing any, the household's), scoped like every other figure on
// Investments. A sale with no rate to value it at makes the whole figure
// unknown rather than guessed. `from` is inclusive and `to` exclusive, as
// YYYY-MM-DD; either may be left out.
export function salesProfit(trades, holdings, { from = null, to = null, scopeMemberId = null, fxHistory = [], inrPerAed = null } = {}) {
  const byId = new Map((holdings ?? []).map((h) => [h.id, h]));
  let available = true;
  let profit = 0;
  let tax = 0;
  let sales = 0;
  let taxToConfirm = 0;
  for (const t of trades ?? []) {
    const holding = byId.get(t.holding_id);
    if (t.kind !== 'sell' || !holding) continue;
    if ((from && t.trade_date < from) || (to && t.trade_date >= to)) continue;
    sales += 1;
    if (t.tax_to_confirm) taxToConfirm += 1;
    const value = estimateAed(Number(t.realised ?? 0), holding.currency, t.trade_date, fxHistory, inrPerAed);
    const taxValue = estimateAed(Number(t.tax_withheld ?? 0), holding.currency, t.trade_date, fxHistory, inrPerAed);
    if (!value || !taxValue) {
      available = false;
      continue;
    }
    profit += scopedValue(value.aed, holding, scopeMemberId);
    tax += scopedValue(taxValue.aed, holding, scopeMemberId);
  }
  return { available, profitAed: round2(profit), taxAed: round2(tax), sales, taxToConfirm };
}

// Why the database did not save a trade, in plain words. A refusal that is
// about a particular trade (a sale it would oversell) names that trade's date,
// which the database gives as the entry's id: 'new' is the trade being typed.
export function refusalMessage(result, { holdingName, currency, trades = [], formDate = null } = {}) {
  const name = holdingName;
  const entryDate = () => {
    if (result?.entry_id === 'new') return formDate;
    return trades.find((t) => t.id === result?.entry_id)?.trade_date ?? null;
  };
  const say = (text) => `${text} Nothing was saved.`;
  switch (result?.error) {
    case 'exceeds_units': {
      const day = entryDate();
      return say(`This would sell more ${name} than was held${day ? ` on ${dayLabel(day, false)}` : ' at that point'}.`);
    }
    case 'before_opening': {
      const opening = trades.find((t) => t.kind === 'opening');
      return say(`That date is before ${name}'s trade history starts${opening ? ` on ${dayLabel(opening.trade_date, false)}` : ''}.`);
    }
    case 'whole_units_only':
      return say('Indian shares trade in whole units.');
    case 'fund_required':
      return say(`There is no ${currency} Broker funds account for this trade. Add one in Accounts.`);
    case 'stale':
      return say(`${name} changed since you checked this trade. Check it again.`);
    case 'currency_mismatch':
      return say(`That Broker funds account is in another currency from ${name}.`);
    case 'not_broker_funds':
      return say('A trade\'s money has to go through a Broker funds account.');
    case 'fund_archived':
      return say('That Broker funds account is closed.');
    case 'trade_not_found':
      return say('That trade was changed or deleted elsewhere. Close the holding and open it again.');
    case 'no_opening':
      return say(`${name} has no trade history yet.`);
    case 'opening_has_trades':
      return say('The opening entry can\'t go while other trades follow it.');
    case 'not_member':
      return say('Only a member of this household can change its trades.');
    case 'bad_input':
      return say('Those figures don\'t make a trade. Check them.');
    default:
      return say('Something went wrong with this trade.');
  }
}

// What the preview warns about, one line each, in the order the bot gives them.
// A fund nobody has confirmed a balance for yet (both funds start at 0 on
// go-live) would otherwise warn on every buy that it is going below zero;
// what is actually true is that its balance has not been set.
export function warningLines(effect, { holdingName, fundName, fundConfirmed, currency, lastPrice = null }) {
  const warnings = Array.isArray(effect?.warnings) ? effect.warnings.map(String) : [];
  const lines = [];
  if (warnings.includes('possible_duplicate')) {
    lines.push('This looks like a trade already saved: same stock, units and price within two days.');
  }
  if (warnings.includes('fund_below_zero')) {
    const after = signedMoney(currency, effect.funds_balance_after);
    lines.push(
      fundConfirmed
        ? `${fundName} would go to ${after}. If you added money, record that too.`
        : `${fundName} has no confirmed balance yet, so it would show ${after} until you set it.`,
    );
  }
  if (warnings.includes('price_off_market')) {
    lines.push(lastPrice ? `Check the price: ${holdingName} was last ${currency} ${money2(lastPrice)}.` : 'Check the price: it is far from the last price.');
  }
  if (warnings.includes('fund_confirmed_after')) {
    lines.push(`${fundName} is not moved: its balance was confirmed after this trade.`);
  }
  return lines;
}

const numberOrNull = (v) => (v === '' || v == null ? null : Number(v));

// The form as the trade functions take it, or what is missing. A split has a
// ratio and nothing else; an opening entry (only ever fixed) has units and a
// price; a buy or a sale goes through a fund. A rupee sale with no tax entered
// is marked to confirm from the broker's statement, as the bot marks it.
export function tradeArgs(form, holding) {
  const errors = {};
  const kind = form.kind;
  const priced = kind !== 'split';
  const traded = kind === 'buy' || kind === 'sell';

  if (!form.trade_date) errors.trade_date = 'Enter the date.';
  else if (form.trade_date > householdToday()) errors.trade_date = 'A trade can\'t be in the future.';

  const units = numberOrNull(form.units);
  if (units === null) errors.units = 'Enter the units.';
  else if (!(units > 0)) errors.units = 'Units must be above 0.';

  const price = priced ? numberOrNull(form.price) : null;
  if (priced && price === null) errors.price = 'Enter the price.';
  else if (priced && !(price >= 0)) errors.price = 'The price can\'t be below 0.';

  const fees = traded ? (numberOrNull(form.fees) ?? 0) : 0;
  if (!(fees >= 0)) errors.fees = 'Brokerage can\'t be below 0.';

  const taxEntered = kind === 'sell' ? numberOrNull(form.tax_withheld) : null;
  if (taxEntered !== null && !(taxEntered >= 0)) errors.tax_withheld = 'Tax can\'t be below 0.';

  if (Object.keys(errors).length) return { errors, args: null };
  return {
    errors,
    args: {
      p_kind: kind,
      p_trade_date: form.trade_date,
      p_units: units,
      p_price: price,
      p_fees: fees,
      p_tax_withheld: taxEntered ?? 0,
      p_funds_account_id: traded ? form.funds_account_id || null : null,
      p_tax_to_confirm: kind === 'sell' && holding?.currency === 'INR' && taxEntered === null,
    },
  };
}
