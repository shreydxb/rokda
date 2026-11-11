import { test, expect } from '@playwright/test';
import { data, dayThisMonth, ids, stubSupabase } from './fixtures.js';

// SHR-366: a share's dividends in its editor, and one recorded in the app,
// checked by the database before it is saved. The database is the stub's:
// previews and saves answer with fixed figures, so this is about the screens,
// on a desktop and on a phone, not about the sums.

const H_ABC = 'abcabcab-0000-4000-8000-000000000001';
const F_USD = 'f0f0f0f0-1111-4000-8000-000000000001';
const at = (day) => `${day}T09:00:00+00:00`;

const HOLDING = {
  id: H_ABC, household_id: ids.HH, owner_member_id: ids.ME, is_shared: false, name: 'ABC', asset_class: 'us_equity', sector: null,
  currency: 'USD', value_aed: 4958, last_refreshed: at(dayThisMonth(1)), created_at: at(dayThisMonth(1)), updated_at: at(dayThisMonth(1)),
  quantity: 40, avg_price: 110, current_price: 150, invested_value_aed: 3636, day_change_pct: 0.5, price_symbol: 'ABC', price_provider: 'stub',
  price_fetch_error: null, price_fetch_fail_count: 0, priced_at: at(dayThisMonth(1)), price_fetched_at: at(dayThisMonth(1)),
  funds_account_id: F_USD, trades_version: 0, split_asked_for: null, dividend_tax_pct: 30, dividend_fee_per_share: 0,
};
const FUND = {
  id: F_USD, household_id: ids.HH, owner_member_id: ids.ME, name: 'Dollar broker funds', type: 'broker_funds', currency: 'USD',
  balance: 100, is_shared: false, created_at: at(dayThisMonth(1)), updated_at: at(dayThisMonth(1)), credit_limit: null, statement_day: null,
  due_day: null, principal: null, interest_rate_pct: null, compounding: null, opened_date: null, maturity_date: null, fd_status: 'active',
  balance_aed: 367.25, archived_at: null, balance_as_of: at(dayThisMonth(1)), brokerage_in_average: false, dividends_into_account_id: null,
};
const dividend = (n, over) => ({
  id: `d1d1d1d1-0000-4000-8000-00000000000${n}`, household_id: ids.HH, holding_id: H_ABC, event_id: `e1e1e1e1-0000-4000-8000-00000000000${n}`,
  ex_date: '2026-03-14', record_date: null, pay_date: '2026-04-01', currency: 'USD', units: 40, units_basis: 'trades', per_share: 0.25, tax_pct: 30,
  expected_gross: 10, expected_tax: 3, expected_fees: 0, expected_net: 7, received_gross: null, received_tax: null, received_fees: null, received_net: null,
  status: 'earned', evidence: null, credited_on: null, credited_on_estimated: false, credited_at: null, paid_into_account_id: F_USD, review_reason: null,
  review_event_id: null, review_baseline: null, fixed: false, source: 'feed', import_ref: null, proposal_id: null, version: 1, note: null, asked_at: null,
  created_at: at(dayThisMonth(1)), updated_at: at(dayThisMonth(1)), updated_by: null, ...over,
});
const DIVIDENDS = [
  dividend(1, { ex_date: '2026-06-12', pay_date: '2026-07-01', review_reason: 'feed_changed', version: 2 }),
  dividend(2, {
    status: 'received', received_gross: 10, received_tax: 3, received_fees: 0, received_net: 7, evidence: 'member', credited_on: '2026-04-01',
  }),
];
const PREVIEW = {
  ok: true, dividend: { ...DIVIDENDS[0], status: 'received', received_net: 7, credited_on: '2026-07-01' },
  movements: [{ account_id: F_USD, account_name: 'Dollar broker funds', currency: 'USD', delta: 7, balance_after: 107 }],
  confirmations: { [F_USD]: '2026-06-01 05:00:00+00' }, version: 2, asks: null, warnings: [],
};

async function documentOverflows(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
}

test("a share's dividends are listed in its editor, and one is checked before it is recorded", async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const saves = [];
  await stubSupabase(page, {
    tables: { holdings: [...data.holdings, HOLDING], accounts: [...data.accounts, FUND], holding_dividends: DIVIDENDS, dividend_special_parts: [] },
    rpc: { preview_dividend: PREVIEW, save_dividend: { ...PREVIEW, version: 3 } },
    onRest: (request) => {
      if (request.url().includes('/rpc/save_dividend')) saves.push(request.postDataJSON());
    },
  });
  await page.goto('/wealth', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.om-main')).toBeVisible();
  await expect(page.locator('.om-main .ov-skel')).toHaveCount(0);
  await page.getByRole('button', { name: 'Investments', exact: true }).first().click();
  await page.locator('.wl-holdrow', { hasText: 'ABC' }).click();

  const editor = page.getByRole('dialog', { name: 'Edit holding' });
  const list = editor.getByRole('list', { name: 'Dividends' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByRole('listitem').first()).toContainText("The feed's amount per share has changed since this was recorded.");
  await expect(list.getByRole('listitem').last()).toContainText('Received · 40 × USD 0.25');
  expect(await documentOverflows(page), 'the dividends list scrolls the page sideways').toBe(false);
  await list.screenshot({ path: testInfo.outputPath(`dividends-${testInfo.project.name}.png`) });

  if (testInfo.project.name === 'mobile') {
    for (const button of await list.getByRole('button').all()) {
      const box = await button.boundingBox();
      expect(box.height, `${await button.textContent()} is under 44px tall`).toBeGreaterThanOrEqual(44);
    }
  }

  await list.getByRole('listitem').first().getByRole('button', { name: 'Record' }).click();
  await editor.getByRole('button', { name: 'Check' }).click();
  await expect(editor.getByText('Net USD 7.00')).toBeVisible();
  await expect(editor.getByText('Adds USD 7.00 to Dollar broker funds')).toBeVisible();
  expect(await documentOverflows(page), 'the dividend form scrolls the page sideways').toBe(false);
  await editor.screenshot({ path: testInfo.outputPath(`dividend-check-${testInfo.project.name}.png`) });

  await editor.getByRole('button', { name: 'Save dividend' }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]).toEqual({
    p_dividend_id: DIVIDENDS[0].id, p_change: { action: 'record' }, p_expected_version: 2, p_expected_confirmations: PREVIEW.confirmations,
  });
  expect(errors).toEqual([]);
});
