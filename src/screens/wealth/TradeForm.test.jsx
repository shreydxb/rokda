import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, cleanup, within } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';
import { householdToday } from '../../lib/day';

// The trade functions, answered per name. Each test sets what the database
// says; every call is recorded so a test can check exactly what was sent.
const calls = [];
let answers = {};
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    rpc: async (name, args) => {
      calls.push({ name, args });
      const answer = answers[name];
      const data = typeof answer === 'function' ? answer(args, calls.filter((c) => c.name === name).length) : answer;
      return { data: data ?? null, error: null };
    },
  },
}));

const { default: TradeForm } = await import('./TradeForm');

const TODAY = householdToday();
const ABC = { id: 'h-abc', name: 'ABC', currency: 'USD', asset_class: 'us_equity', quantity: 15, avg_price: 110, current_price: 140, trades_version: 3, funds_account_id: 'f-usd' };
const XYZ = { id: 'h-xyz', name: 'XYZ', currency: 'INR', asset_class: 'india_equity', quantity: 4, avg_price: 1000, current_price: 1100, trades_version: 2, funds_account_id: 'f-inr' };
const fund = (id, name, currency, extra = {}) => ({ id, name, type: 'broker_funds', currency, balance: 1000, balance_as_of: '2026-10-01T00:00:00Z', archived_at: null, ...extra });
const ACCOUNTS = [
  fund('f-other', 'Other broker funds', 'USD'),
  fund('f-usd', 'Dollar broker funds', 'USD'),
  fund('f-closed', 'Closed broker funds', 'USD', { archived_at: '2026-09-01T00:00:00Z' }),
  fund('f-inr', 'Rupee broker funds', 'INR'),
  { id: 'a-bank', name: 'Bank', type: 'checking', currency: 'USD', balance: 0, balance_as_of: null, archived_at: null },
];
const SALE_EFFECT = {
  ok: true, units: 6, price: 150, fees: 1, tax_withheld: 0, trades_version: 3, units_before: 15, avg_before: 110,
  holding_units_after: 9, holding_avg_after: 110, realised: 239, funds_account_id: 'f-usd', funds_delta: 899,
  funds_balance_after: 1899, warnings: [],
};

beforeEach(() => {
  calls.length = 0;
  answers = {};
  cleanup();
});

function open(holding = ABC, { accounts = ACCOUNTS, onSaved = vi.fn().mockResolvedValue(undefined), onCancel = vi.fn() } = {}) {
  renderScreen(<TradeForm holding={holding} trade={null} trades={[]} accounts={accounts} onCancel={onCancel} onSaved={onSaved} />);
  return { onSaved, onCancel };
}
const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
async function check() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
  });
}
async function save() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save trade' }));
  });
}
function fillSale() {
  fireEvent.click(screen.getByRole('button', { name: 'Sell' }));
  type('Units traded', '6');
  type('Price (USD)', '150');
  type('Brokerage (USD)', '1');
}

describe('TradeForm: recording a trade', () => {
  it('checks a sale with the database and shows what it would do', async () => {
    answers.preview_trade = SALE_EFFECT;
    open();
    expect(screen.getByLabelText('Date').value).toBe(TODAY);
    fillSale();
    await check();
    expect(calls).toEqual([{
      name: 'preview_trade',
      args: { p_holding_id: 'h-abc', p_kind: 'sell', p_trade_date: TODAY, p_units: 6, p_price: 150, p_fees: 1, p_tax_withheld: 0, p_traded_at: null, p_funds_account_id: 'f-usd', p_replace_trade_id: null },
    }]);
    expect(screen.getByText('ABC: 15 → 9 shares, average USD 110.00')).toBeTruthy();
    expect(screen.getByText('Profit USD 239.00')).toBeTruthy();
    expect(screen.getByText('Dollar broker funds +USD 899.00')).toBeTruthy();
  });

  it('shows the average moving on a buy', async () => {
    answers.preview_trade = { ...SALE_EFFECT, units: 5, price: 130, fees: 0, units_before: 10, avg_before: 100, holding_units_after: 15, holding_avg_after: 110, realised: null, funds_delta: -650 };
    open();
    type('Units traded', '5');
    type('Price (USD)', '130');
    await check();
    expect(screen.getByText('ABC: 10 → 15 shares, average USD 100.00 → USD 110.00')).toBeTruthy();
    expect(screen.getByText('Dollar broker funds -USD 650.00')).toBeTruthy();
    expect(screen.queryByText(/^Profit/)).toBeNull();
  });

  it('saves exactly the checked trade, on the version it was checked against', async () => {
    answers.preview_trade = SALE_EFFECT;
    answers.record_trade = { ...SALE_EFFECT, trade_id: 't-new', trades_version: 4 };
    const { onSaved } = open();
    fillSale();
    await check();
    await save();
    const record = calls.find((c) => c.name === 'record_trade');
    expect(record.args).toEqual({ p_holding_id: 'h-abc', p_kind: 'sell', p_trade_date: TODAY, p_units: 6, p_price: 150, p_fees: 1, p_tax_withheld: 0, p_traded_at: null, p_funds_account_id: 'f-usd', p_expected_version: 3, p_tax_to_confirm: false });
    // A member's trade is the app's: only the bot passes either of these.
    expect(record.args).not.toHaveProperty('p_source');
    expect(record.args).not.toHaveProperty('p_proposal_id');
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('clears the check when a figure changes, and will not save until checked again', async () => {
    answers.preview_trade = SALE_EFFECT;
    open();
    fillSale();
    expect(screen.getByRole('button', { name: 'Save trade' }).disabled).toBe(true);
    await check();
    expect(screen.getByRole('button', { name: 'Save trade' }).disabled).toBe(false);
    type('Price (USD)', '151');
    expect(screen.queryByText('Profit USD 239.00')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save trade' }).disabled).toBe(true);
  });

  it('says what is missing before asking the database', async () => {
    open();
    await check();
    expect(screen.getByText('Enter the units.')).toBeTruthy();
    expect(screen.getByText('Enter the price.')).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it('says which date a sale would oversell on', async () => {
    answers.preview_trade = { ok: false, error: 'exceeds_units', entry_id: 'new' };
    open();
    fillSale();
    type('Date', '2026-10-24');
    await check();
    expect(screen.getByText('This would sell more ABC than was held on 24 Oct. Nothing was saved.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save trade' }).disabled).toBe(true);
  });

  it('refuses a save the holding moved under, and asks to check again', async () => {
    // A trade from Telegram lands between the check and the save.
    answers.preview_trade = (args, n) => ({ ...SALE_EFFECT, trades_version: n === 1 ? 3 : 4 });
    answers.record_trade = (args) => (args.p_expected_version === 3 ? { ok: false, error: 'stale', trades_version: 4 } : { ...SALE_EFFECT, trade_id: 't-new', trades_version: 5 });
    const { onSaved } = open();
    fillSale();
    await check();
    await save();
    expect(screen.getByText('ABC changed since you checked this trade. Check it again. Nothing was saved.')).toBeTruthy();
    expect(screen.queryByText('Profit USD 239.00')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save trade' }).disabled).toBe(true);
    // What was typed is kept, so checking again needs no retyping.
    expect(screen.getByLabelText('Units traded').value).toBe('6');
    expect(onSaved).not.toHaveBeenCalled();
    await check();
    await save();
    expect(calls.filter((c) => c.name === 'record_trade').map((c) => c.args.p_expected_version)).toEqual([3, 4]);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('marks a rupee sale with no tax as to confirm', async () => {
    answers.preview_trade = { ...SALE_EFFECT, units: 1, price: 1200, fees: 20, units_before: 4, avg_before: 1000, holding_units_after: 3, holding_avg_after: 1000, realised: 180, funds_account_id: 'f-inr', funds_delta: 1180 };
    answers.record_trade = { ok: true, trade_id: 't-new', trades_version: 3 };
    open(XYZ);
    fireEvent.click(screen.getByRole('button', { name: 'Sell' }));
    type('Units traded', '1');
    type('Price (INR)', '1200');
    type('Brokerage (INR)', '20');
    expect(screen.getByLabelText('Tax withheld (leave blank if not known yet)').value).toBe('');
    await check();
    expect(screen.getByText('Tax: to confirm from the broker\'s statement.')).toBeTruthy();
    await save();
    expect(calls.find((c) => c.name === 'record_trade').args).toMatchObject({ p_tax_withheld: 0, p_tax_to_confirm: true, p_funds_account_id: 'f-inr' });
  });

  it('offers only open Broker funds in the holding\'s currency, the holding\'s own first', () => {
    open();
    const options = within(screen.getByLabelText('Fund')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Dollar broker funds', 'Other broker funds']);
    expect(screen.getByLabelText('Fund').value).toBe('f-usd');
  });

  it('says when there is no fund to trade through', () => {
    open(ABC, { accounts: [fund('f-inr', 'Rupee broker funds', 'INR')] });
    expect(screen.getByText('There is no USD Broker funds account. Add one in Accounts.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check' }).disabled).toBe(true);
  });

  it('records a split with no price or brokerage', async () => {
    answers.preview_trade = { ...SALE_EFFECT, units: 10, price: null, fees: 0, units_before: 15, avg_before: 110, holding_units_after: 150, holding_avg_after: 11, realised: null, funds_account_id: null, funds_delta: 0 };
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Split' }));
    expect(screen.getByRole('button', { name: 'Split' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByLabelText('Price (USD)')).toBeNull();
    expect(screen.queryByLabelText('Brokerage (USD)')).toBeNull();
    expect(screen.queryByLabelText('Fund')).toBeNull();
    type('New units per old unit', '10');
    await check();
    expect(calls[0].args).toMatchObject({ p_kind: 'split', p_units: 10, p_price: null, p_fees: 0, p_funds_account_id: null });
    expect(screen.getByText('ABC: 15 → 150 shares, average USD 110.00 → USD 11.00')).toBeTruthy();
  });

  it('warns about an unconfirmed fund in the words the preview gives', async () => {
    answers.preview_trade = { ...SALE_EFFECT, realised: null, funds_delta: -650, funds_balance_after: -650, warnings: ['fund_below_zero'] };
    open(ABC, { accounts: [fund('f-usd', 'Dollar broker funds', 'USD', { balance: 0, balance_as_of: null })] });
    type('Units traded', '5');
    type('Price (USD)', '130');
    await check();
    expect(screen.getByText('Dollar broker funds has no confirmed balance yet, so it would show USD -650.00 until you set it.')).toBeTruthy();
  });

  it('runs the check on Enter instead of submitting the holding around it', async () => {
    answers.preview_trade = SALE_EFFECT;
    open();
    fillSale();
    let notPrevented;
    await act(async () => {
      notPrevented = fireEvent.keyDown(screen.getByLabelText('Price (USD)'), { key: 'Enter' });
    });
    expect(notPrevented).toBe(false);
    expect(calls.map((c) => c.name)).toEqual(['preview_trade']);
  });

  it('will not save twice while the screen reloads after a save', async () => {
    answers.preview_trade = SALE_EFFECT;
    answers.record_trade = { ...SALE_EFFECT, trade_id: 't-new', trades_version: 4 };
    // The reload the save asks for is still running.
    open(ABC, { onSaved: vi.fn(() => new Promise(() => {})) });
    fillSale();
    await check();
    await save();
    expect(screen.getByRole('button', { name: 'Save trade' }).disabled).toBe(true);
    await save();
    expect(calls.filter((c) => c.name === 'record_trade')).toHaveLength(1);
  });

  it('announces the preview through a region that was there before it', async () => {
    answers.preview_trade = SALE_EFFECT;
    open();
    const region = document.querySelector('[aria-live="polite"]');
    expect(region).toBeTruthy();
    expect(region.textContent).toBe('');
    fillSale();
    await check();
    expect(region.textContent).toContain('Profit USD 239.00');
  });

  it('goes back to the list without saving', () => {
    const { onCancel } = open();
    fireEvent.click(screen.getByRole('button', { name: 'Back to trades' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('TradeForm: fixing a trade', () => {
  const BUY = { id: 't-buy', holding_id: 'h-abc', kind: 'buy', trade_date: '2026-10-28', traded_at: '2026-10-28T09:30:00Z', created_at: '2026-10-28T10:00:00Z', units: 5, price: 130, fees: 2, tax_withheld: 0, tax_to_confirm: false, funds_account_id: 'f-usd', note: 'typed in the app', realised: null };
  const OPENING = { ...BUY, id: 't-open', kind: 'opening', trade_date: '2026-10-27', traded_at: null, units: 10, price: 100, fees: 0, funds_account_id: null, note: null };
  const SELL = { ...BUY, id: 't-sell', kind: 'sell', trade_date: '2026-10-29', traded_at: null, units: 6, price: 150, fees: 1, realised: 239, note: null };
  const fix = (trade, extra = {}) => {
    const onSaved = vi.fn().mockResolvedValue(undefined);
    renderScreen(<TradeForm holding={ABC} trade={trade} trades={[OPENING, BUY, SELL]} accounts={ACCOUNTS} onCancel={vi.fn()} onSaved={onSaved} {...extra} />);
    return { onSaved };
  };

  it('fixes a trade through the database, keeping its time and note', async () => {
    answers.preview_trade = { ...SALE_EFFECT, realised: null, units_before: 9, holding_units_after: 9, holding_avg_after: 110.4, funds_delta: -5 };
    answers.fix_trade = { ok: true, trade_id: 't-buy', trades_version: 4 };
    const { onSaved } = fix(BUY);
    expect(screen.queryByRole('group', { name: 'Kind of trade' })).toBeNull();
    expect(screen.getByLabelText('Units traded').value).toBe('5');
    expect(screen.getByLabelText('Price (USD)').value).toBe('130');
    expect(screen.getByLabelText('Brokerage (USD)').value).toBe('2');
    type('Price (USD)', '131');
    await check();
    expect(calls[0]).toEqual({
      name: 'preview_trade',
      args: { p_holding_id: 'h-abc', p_kind: 'buy', p_trade_date: '2026-10-28', p_units: 5, p_price: 131, p_fees: 2, p_tax_withheld: 0, p_traded_at: '2026-10-28T09:30:00Z', p_funds_account_id: 'f-usd', p_replace_trade_id: 't-buy' },
    });
    await save();
    expect(calls.find((c) => c.name === 'fix_trade').args).toEqual({
      p_trade_id: 't-buy', p_trade_date: '2026-10-28', p_units: 5, p_price: 131, p_fees: 2, p_tax_withheld: 0,
      p_traded_at: '2026-10-28T09:30:00Z', p_funds_account_id: 'f-usd', p_tax_to_confirm: false, p_note: 'typed in the app', p_expected_version: 3,
    });
    expect(calls.some((c) => c.name === 'record_trade')).toBe(false);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('lets an opening entry change its units and price, not its date', async () => {
    answers.preview_trade = { ...SALE_EFFECT, realised: null, funds_account_id: null, funds_delta: 0 };
    answers.fix_trade = { ok: true, trade_id: 't-open', trades_version: 4 };
    fix(OPENING);
    expect(screen.getByLabelText('Date').readOnly).toBe(true);
    expect(screen.queryByLabelText('Brokerage (USD)')).toBeNull();
    expect(screen.queryByLabelText('Fund')).toBeNull();
    type('Units traded', '12');
    await check();
    expect(calls[0].args).toMatchObject({ p_kind: 'opening', p_units: 12, p_price: 100, p_fees: 0, p_funds_account_id: null, p_replace_trade_id: 't-open' });
    await save();
    expect(calls.find((c) => c.name === 'fix_trade').args).toMatchObject({ p_trade_id: 't-open', p_trade_date: '2026-10-27', p_units: 12, p_funds_account_id: null, p_note: null });
  });

  it('keeps a rupee sale\'s tax confirmed as none when fixing something else', async () => {
    // A loss-making Indian sale has no tax withheld, and that was confirmed.
    const rupeeSale = { ...SELL, id: 't-xyz', holding_id: 'h-xyz', price: 900, units: 1, fees: 20, realised: -120, tax_withheld: 0, tax_to_confirm: false, funds_account_id: 'f-inr' };
    answers.preview_trade = { ...SALE_EFFECT, funds_account_id: 'f-inr', realised: -125 };
    answers.fix_trade = { ok: true, trade_id: 't-xyz', trades_version: 3 };
    renderScreen(<TradeForm holding={XYZ} trade={rupeeSale} trades={[rupeeSale]} accounts={ACCOUNTS} onCancel={vi.fn()} onSaved={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.getByLabelText('Tax withheld (leave blank if not known yet)').value).toBe('0');
    type('Brokerage (INR)', '25');
    await check();
    expect(screen.queryByText('Tax: to confirm from the broker\'s statement.')).toBeNull();
    await save();
    expect(calls.find((c) => c.name === 'fix_trade').args).toMatchObject({ p_tax_withheld: 0, p_tax_to_confirm: false });
  });

  it('leaves a rupee sale\'s tax blank while it is still to confirm', () => {
    const waiting = { ...SELL, id: 't-xyz', holding_id: 'h-xyz', tax_withheld: 0, tax_to_confirm: true, funds_account_id: 'f-inr' };
    renderScreen(<TradeForm holding={XYZ} trade={waiting} trades={[waiting]} accounts={ACCOUNTS} onCancel={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText('Tax withheld (leave blank if not known yet)').value).toBe('');
  });

  it('names the sale a fix would oversell', async () => {
    answers.preview_trade = { ok: false, error: 'exceeds_units', entry_id: 't-sell' };
    fix(BUY);
    type('Date', '2026-10-30');
    await check();
    expect(screen.getByText('This would sell more ABC than was held on 29 Oct. Nothing was saved.')).toBeTruthy();
  });
});
