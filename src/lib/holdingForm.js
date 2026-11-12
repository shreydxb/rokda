// The holding editor's form, as data: what it opens with, what is wrong with
// it, and what a save writes. Moved out of screens/wealth/HoldingEditor.jsx
// (the round 2 cleanup, SHR-383).
import { hasSector, paysDividends } from './holdings';
import { isPendingValuation, nextPricedAt, valueFieldFor, valuationChanged } from './valuation';

export function initialForm(holding) {
  if (holding) {
    return {
      name: holding.name,
      asset_class: holding.asset_class,
      sector: holding.sector ?? '',
      currency: holding.currency ?? 'AED',
      value_aed: valueFieldFor(holding),
      owner: holding.is_shared ? 'shared' : (holding.owner_member_id ?? ''),
      quantity: holding.quantity != null ? String(holding.quantity) : '',
      avg_price: holding.avg_price != null ? String(holding.avg_price) : '',
      current_price: holding.current_price != null ? String(holding.current_price) : '',
      invested_value_aed: holding.invested_value_aed != null ? String(holding.invested_value_aed) : '',
      day_change_pct: holding.day_change_pct != null ? String(holding.day_change_pct) : '',
      price_provider: holding.price_provider ?? '',
      price_symbol: holding.price_symbol ?? '',
      dividend_tax_pct: holding.dividend_tax_pct != null ? String(holding.dividend_tax_pct) : '',
      dividend_fee_per_share: holding.dividend_fee_per_share != null ? String(holding.dividend_fee_per_share) : '',
    };
  }
  return {
    name: '', asset_class: 'us_equity', sector: '', currency: 'USD', value_aed: '', owner: 'shared',
    quantity: '', avg_price: '', current_price: '', invested_value_aed: '', day_change_pct: '',
    price_provider: '', price_symbol: '', dividend_tax_pct: '', dividend_fee_per_share: '',
  };
}

const numberOrNull = (text) => (text.trim() === '' ? null : Number(text));

// Matches how the database values a priced holding (set_holding_price):
// only these currencies have a real conversion path, and units are required
// to turn a per-unit price into a total value.
export function isAutoValued(form) {
  return !!form.price_provider && form.quantity.trim() !== '' && ['AED', 'USD', 'INR'].includes((form.currency || '').toUpperCase());
}

// The figures the form holds, as a save writes them.
export function formValuation(form) {
  return {
    value_aed: Number(form.value_aed) || 0,
    quantity: numberOrNull(form.quantity),
    avg_price: numberOrNull(form.avg_price),
    current_price: numberOrNull(form.current_price),
    invested_value_aed: numberOrNull(form.invested_value_aed),
    day_change_pct: numberOrNull(form.day_change_pct),
    price_provider: form.price_provider || null,
    price_symbol: form.price_provider && form.price_symbol.trim() !== '' ? form.price_symbol.trim() : null,
  };
}

// What is wrong with each field, or '' when nothing is. Withholding is a
// default per holding, not a fact (SHR-366): a US-listed share of a foreign
// company is withheld by its home country. Left empty, a new holding takes
// its class's default and an existing one keeps its rate.
export function holdingProblems(form) {
  const dividendFields = paysDividends(form.asset_class);
  const taxRate = numberOrNull(form.dividend_tax_pct);
  const feePerShare = numberOrNull(form.dividend_fee_per_share);
  return {
    name: form.name.trim() === '' ? 'Name it.' : '',
    symbol: form.price_provider && form.price_symbol.trim() === '' ? 'Enter the symbol this provider expects.' : '',
    rate: dividendFields && taxRate !== null && !(taxRate >= 0 && taxRate <= 100) ? 'Enter a rate from 0 to 100.' : '',
    fee: dividendFields && feePerShare !== null && !(feePerShare >= 0) ? 'Enter a fee of 0 or more.' : '',
  };
}

// What a save writes: the holding's row, the figures it holds, and whether a
// dated history point goes with them.
export function holdingSave(form, { holding, householdId, asOf, confirmUnchanged }) {
  const valuation = formValuation(form);
  const autoValued = isAutoValued(form);
  // An auto-valued holding whose value field is blank because it is disabled
  // and nothing has priced it yet confirms nothing (QA #6).
  const pendingValuation = isPendingValuation({ holding, valueField: form.value_aed, autoValued });
  // Once a holding has its opening entry, its units and average price come
  // only from its trades (SHR-367).
  const traded = (holding?.trades_version ?? 0) > 0;
  const dividendFields = paysDividends(form.asset_class);
  const taxRate = numberOrNull(form.dividend_tax_pct);
  const feePerShare = numberOrNull(form.dividend_fee_per_share);

  // priced_at moves when the numbers actually change, or when the reviewer
  // explicitly reconfirms an unchanged value as of the date above. A rename
  // or a reload does neither, so a stale holding stays stale (QA-04).
  const repriced = !holding || valuationChanged(holding, valuation);
  const explicitlyConfirmed = !repriced && holding && confirmUnchanged;
  // A pending valuation confirms nothing, so it moves no date and records no
  // history point. priced_at stays null, which every reader already treats
  // as "never valued" -- the staleness banner, the editor's own copy, and
  // now holdingGain (QA #6). The price feed sets it on the first successful
  // refresh, and a failed refresh correctly leaves it unset rather than
  // leaving a fresh-looking zero behind.
  const nextPriced = pendingValuation
    ? null
    : repriced
      ? nextPricedAt(holding, valuation, { confirmedAsOf: asOf })
      : explicitlyConfirmed
        ? nextPricedAt(holding, holding, { confirmedAsOf: asOf })
        : (holding?.priced_at ?? null);
  // A traded holding the feed prices is valued by the database, from its
  // units under the holding's lock, whenever a trade or a price lands. The
  // figures this editor loaded may already be older than that, so it sends
  // none of them and records no value point (SHR-367).
  const feedValued = traded && autoValued;
  const writesHistory = !feedValued && !pendingValuation && (repriced || !!explicitlyConfirmed);
  const payload = {
    household_id: householdId,
    name: form.name.trim(),
    asset_class: form.asset_class,
    // Only shares and share funds have a sector.
    sector: hasSector(form.asset_class) ? form.sector || null : null,
    currency: form.currency || 'AED',
    is_shared: form.owner === 'shared',
    owner_member_id: form.owner === 'shared' ? null : form.owner,
    ...valuation,
    ...(nextPriced ? { priced_at: nextPriced } : {}),
    ...(dividendFields && taxRate !== null ? { dividend_tax_pct: taxRate } : {}),
    ...(dividendFields && feePerShare !== null ? { dividend_fee_per_share: feePerShare } : {}),
  };
  // A traded holding's units and average come only from its trades, and the
  // database refuses them from anywhere else (SHR-367), so they are never sent.
  if (traded) {
    delete payload.quantity;
    delete payload.avg_price;
  }
  if (feedValued) {
    delete payload.value_aed;
    delete payload.current_price;
    delete payload.day_change_pct;
    delete payload.priced_at;
  }
  return { payload, valuation, writesHistory };
}
