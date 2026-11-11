import { test, expect } from '@playwright/test';
import { data, ids, stubSupabase } from './fixtures.js';

// SHR-366: the Dividends tab in a real browser, on a desktop and on a phone.
// The database is the stub's: the figures are fixed, so this is about the
// screen: a long holding name, a receipt with no ex-date, one market's checks
// failing, and Record and Fix working through it.

const H_ABC = 'abcabcab-0000-4000-8000-000000000001';
const H_XYZ = 'abcabcab-0000-4000-8000-000000000002';
const H_QUIET = 'abcabcab-0000-4000-8000-000000000003';
const F_USD = 'f0f0f0f0-1111-4000-8000-000000000001';
const F_INR = 'f0f0f0f0-1111-4000-8000-000000000002';
const A_INR = 'f0f0f0f0-1111-4000-8000-000000000003';
const LONG_NAME = 'ABC Holdings Incorporated Common Stock Class A Ordinary Shares';

const day = (offset) => {
  const d = new Date(Date.now() + 4 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const at = (offset) => `${day(offset)}T09:00:00+00:00`;

const holding = (id, extra) => ({
  id, household_id: ids.HH, owner_member_id: null, is_shared: true, sector: null, value_aed: 4000, last_refreshed: at(-1), created_at: at(-400),
  updated_at: at(-1), avg_price: 40, invested_value_aed: 3000, day_change_pct: 0.5, price_fetch_error: null, price_fetch_fail_count: 0,
  priced_at: at(-1), price_fetched_at: at(-1), trades_version: 1, split_asked_for: null, dividend_fee_per_share: 0, ...extra,
});
const ABC = holding(H_ABC, { name: LONG_NAME, asset_class: 'us_equity', currency: 'USD', quantity: 10, current_price: 50, price_symbol: 'ABC', price_provider: 'stub',
  funds_account_id: F_USD, sector: 'technology', dividend_tax_pct: 30 });
const XYZ = holding(H_XYZ, { name: 'XYZ', asset_class: 'india_equity', currency: 'INR', quantity: 100, current_price: 500, avg_price: 400, price_symbol: 'XYZ.NS',
  price_provider: 'yahoo', funds_account_id: F_INR, dividend_tax_pct: 20.8 });
// A holding the feed checks and finds nothing for: it goes in a fold.
const QUIET = holding(H_QUIET, { name: 'QUIET', asset_class: 'us_equity', currency: 'USD', quantity: 5, current_price: 20, price_symbol: 'QUIET', price_provider: 'stub',
  funds_account_id: F_USD, dividend_tax_pct: 30 });
const account = (id, name, type, currency, extra = {}) => ({
  id, household_id: ids.HH, owner_member_id: null, name, type, currency, balance: 100, is_shared: true, created_at: at(-400), updated_at: at(-1),
  credit_limit: null, statement_day: null, due_day: null, principal: null, interest_rate_pct: null, compounding: null, opened_date: null, maturity_date: null,
  fd_status: 'active', balance_aed: 367.25, archived_at: null, balance_as_of: null, brokerage_in_average: false, dividends_into_account_id: null, ...extra,
});
const ACCOUNTS = [
  account(F_USD, 'Dollar broker funds', 'broker_funds', 'USD'),
  account(F_INR, 'Rupee broker funds', 'broker_funds', 'INR', { dividends_into_account_id: A_INR }),
  account(A_INR, 'Rupee bank', 'checking', 'INR'),
];
const dividend = (n, holdingRow, extra) => ({
  id: `d1d1d1d1-0000-4000-8000-00000000000${n}`, household_id: ids.HH, holding_id: holdingRow.id, event_id: null, ex_date: null, record_date: null, pay_date: null,
  currency: holdingRow.currency, units: 10, units_basis: 'trades', per_share: 1, tax_pct: 30, expected_gross: 10, expected_tax: 3, expected_fees: 0, expected_net: 7,
  received_gross: null, received_tax: null, received_fees: null, received_net: null, status: 'earned', evidence: null, credited_on: null,
  credited_on_estimated: false, credited_at: null, paid_into_account_id: F_USD, review_reason: null, review_event_id: null, review_baseline: null, fixed: false,
  source: 'feed', import_ref: null, proposal_id: null, version: 1, note: null, asked_at: null, created_at: at(-60), updated_at: at(-1), updated_by: null, ...extra,
});
const DIVIDENDS = [
  // The feed changed its amount after this was recorded: Needs you asks for a look.
  dividend(1, ABC, { status: 'received', ex_date: day(-60), credited_on: day(-40), received_gross: 10, received_tax: 3, received_fees: 0, received_net: 7, evidence: 'member',
    review_reason: 'feed_changed' }),
  // Added by hand from a statement that gave no ex-date.
  dividend(2, ABC, { status: 'received', credited_on: day(-20), received_gross: 10, received_tax: 3, received_fees: 0, received_net: 7, evidence: 'member', source: 'app' }),
  dividend(3, ABC, { status: 'earned', ex_date: day(-5), pay_date: day(5) }),
  dividend(4, XYZ, { status: 'presumed', ex_date: day(-90), credited_on: day(-60), currency: 'INR', units: 100, per_share: 5, tax_pct: 20.8, expected_gross: 500,
    expected_tax: 104, expected_net: 396, credited_on_estimated: true, paid_into_account_id: A_INR }),
];
const event = (n, symbol, ex_date, amount, extra = {}) => ({
  id: `e1e1e1e1-0000-4000-8000-${String(n).padStart(12, '0')}`, symbol, ex_date, amount, source_amount: amount, source_factor: 1, source_fetched_on: day(-1), currency: 'USD',
  pay_date: null, record_date: null, declared_on: null, source: 'alphavantage', first_seen_at: at(-300), last_seen_at: at(-1), superseded_by: null, missed_checks: 0, ...extra,
});
// ABC pays quarterly, one payment five times its usual (a one-off to ask
// about); XYZ pays yearly.
const EVENTS = [
  ...[-690, -600, -510, -420, -330, -240].map((d, i) => event(i + 1, 'ABC', day(d), 1)),
  event(7, 'ABC', day(-150), 5), event(8, 'ABC', day(-60), 1), event(9, 'ABC', day(25), 1, { pay_date: day(40) }),
  event(10, 'XYZ.NS', day(-400), 5, { currency: 'INR', source: 'yahoo' }), event(11, 'XYZ.NS', day(-90), 5, { currency: 'INR', source: 'yahoo' }),
];
const FEED_STATUS = [
  { symbol: 'ABC', provider: 'alphavantage', kind: 'dividends', last_success_at: at(-3), last_failure_at: at(-1), fail_count: 2, covered_from: '2010-01-01' },
  { symbol: 'XYZ.NS', provider: 'yahoo', kind: 'dividends', last_success_at: at(-1), last_failure_at: null, fail_count: 0, covered_from: '2005-01-01' },
  { symbol: 'QUIET', provider: 'alphavantage', kind: 'dividends', last_success_at: at(-1), last_failure_at: null, fail_count: 0, covered_from: '2015-01-01' },
];
const TRADES = [
  { id: 'abcabcab-1111-4000-8000-000000000001', household_id: ids.HH, holding_id: H_ABC, member_id: ids.ME, kind: 'opening', trade_date: day(-300), traded_at: null,
    units: 10, price: 40, fees: 0, tax_withheld: 0, tax_to_confirm: false, funds_account_id: null, cash_amount: 0, units_after: null, avg_after: null, realised: null,
    source: 'opening', proposal_id: null, note: null, created_at: at(-300), created_by: ids.ME },
];
const PREVIEW = {
  ok: true, dividend: { ...DIVIDENDS[2], status: 'received', received_net: 7, credited_on: day(5) }, movements: [{ account_id: F_USD, account_name: 'Dollar broker funds',
    currency: 'USD', delta: 7, balance_after: 107 }], confirmations: { [F_USD]: null }, version: 1, asks: null, warnings: [],
};

async function documentOverflows(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
}

test('the Dividends tab: headline, coming up, by month and holding, freshness; Record and Fix', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const saves = [];
  const answers = [];
  await stubSupabase(page, {
    tables: {
      holdings: [...data.holdings, ABC, XYZ, QUIET], accounts: [...data.accounts, ...ACCOUNTS], holding_dividends: DIVIDENDS, holding_trades: TRADES,
      dividend_events: EVENTS, dividend_splits: [], dividend_special_parts: [],
    },
    rpc: { dividend_feed_status: FEED_STATUS, preview_dividend: PREVIEW, save_dividend: { ...PREVIEW, version: 2 }, set_special_part: { ok: true } },
    onRest: (request) => {
      if (request.url().includes('/rpc/save_dividend')) saves.push(request.postDataJSON());
      if (request.url().includes('/rpc/set_special_part')) answers.push(request.postDataJSON());
    },
  });
  await page.goto('/wealth', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.om-main')).toBeVisible();
  await expect(page.locator('.om-main .ov-skel')).toHaveCount(0);
  await page.getByRole('button', { name: 'Dividends', exact: true }).first().click();

  const tab = page.locator('.dv-tab');
  await expect(tab.getByRole('region', { name: 'Dividends at a glance' })).toBeVisible();
  // The holding was opened about 300 days ago, so received counts from then.
  await expect(tab.getByRole('region', { name: 'Dividends at a glance' }).getByText(/^Received since /)).toBeVisible();
  expect(await documentOverflows(page), 'the tab scrolls the page sideways').toBe(false);

  const shoot = async (name) => {
    const region = tab.getByRole('region', { name });
    await region.scrollIntoViewIfNeeded();
    await region.screenshot({ path: testInfo.outputPath(`dividends-${name.replace(/\W+/g, '-').toLowerCase()}-${testInfo.project.name}.png`) });
  };
  for (const name of ['Dividends at a glance', 'Coming up', 'Needs you', 'By month', 'By holding', 'Where it comes from', 'How fresh this is']) await shoot(name);

  // Every control on the tab, the folds' summaries included, is a thumb's height on a phone.
  if (testInfo.project.name === 'mobile') {
    const controls = await tab.locator('button, summary').all();
    expect(controls.length).toBeGreaterThan(8);
    for (const control of controls) {
      const box = await control.boundingBox();
      expect(box.height, `${await control.textContent()} is under 44px tall`).toBeGreaterThanOrEqual(44);
    }
  }

  // The quarterly share reads as one, and the quiet one sits in its fold.
  const byHolding = tab.getByRole('region', { name: 'By holding' });
  await expect(byHolding.getByText(`${LONG_NAME} · Quarterly`)).toBeVisible();
  await expect(byHolding.getByText(/^No dividends found since /)).toBeVisible();

  // Needs you: the one-off question answers through the database, and the
  // flagged dividend opens the holding's dividends.
  const needs = tab.getByRole('region', { name: 'Needs you' });
  await expect(needs.getByText(/ paid USD 5\.00 a share on .*, more than twice its usual\. Was part of it a one-off\?$/)).toBeVisible();
  await needs.getByRole('button', { name: 'Yes, part was a one-off' }).click();
  await expect.poll(() => answers.length).toBe(1);
  expect(answers[0]).toEqual({ p_event_id: EVENTS[6].id, p_special_per_share: 4 });
  await expect(needs.getByText("The feed's amount per share has changed since this was recorded.")).toBeVisible();
  await needs.getByRole('button', { name: 'Review' }).click();
  await expect(needs.getByRole('button', { name: 'Fix' }).first()).toBeVisible();

  // The long name wraps inside its row; nothing is pushed past the screen.
  const longRow = tab.getByRole('region', { name: 'By holding' }).getByRole('button', { name: new RegExp(`^${LONG_NAME}`) });
  const box = await longRow.boundingBox();
  const width = page.viewportSize().width;
  expect(box.x + box.width, 'the long name pushes its row off the screen').toBeLessThanOrEqual(width + 1);

  // The receipt with no ex-date is counted as not shown in the Earned view.
  const months = tab.getByRole('region', { name: 'By month' });
  await months.getByRole('button', { name: 'Earned' }).click();
  await expect(months.getByText("1 receipt with no ex-date isn't shown.")).toBeVisible();

  // One market failing while the other works.
  await expect(tab.getByRole('region', { name: 'How fresh this is' }).getByText(/^Checks failing for ABC since /)).toBeVisible();

  // Record the earned one from Coming up.
  const coming = tab.getByRole('region', { name: 'Coming up' });
  await coming.getByRole('button', { name: 'Record' }).click();
  await coming.getByRole('button', { name: 'Check' }).click();
  await expect(coming.getByText('Adds USD 7.00 to Dollar broker funds')).toBeVisible();
  await coming.getByRole('button', { name: 'Save dividend' }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]).toMatchObject({ p_dividend_id: DIVIDENDS[2].id, p_change: { action: 'record' }, p_expected_version: 1 });

  // Fix one from the holding's own dividends.
  await longRow.click();
  await byHolding.getByRole('button', { name: 'Fix' }).first().click();
  await expect(byHolding.getByText(/^Fix the /)).toBeVisible();
  expect(await documentOverflows(page), 'the open form scrolls the page sideways').toBe(false);
  await byHolding.screenshot({ path: testInfo.outputPath(`dividends-fix-${testInfo.project.name}.png`) });

  expect(errors).toEqual([]);
});
