import { test, expect } from '@playwright/test';
import { data, dayThisMonth, ids, stubSupabase } from './fixtures.js';

// SHR-371: a traded holding's editor lists its trades, and a trade typed in
// the app is checked by the database before it is saved. The database is the
// stub's: previews and saves answer with fixed figures, so this is about the
// screens, on a desktop and on a phone, not about the sums.

const H_ABC = 'abcabcab-0000-4000-8000-000000000001';
const F_USD = 'f0f0f0f0-1111-4000-8000-000000000001';
const at = (day) => `${day}T09:00:00+00:00`;

const HOLDING = {
  id: H_ABC, household_id: ids.HH, owner_member_id: ids.ME, is_shared: false, name: 'ABC', asset_class: 'us_equity', sector: null,
  currency: 'USD', value_aed: 4958, last_refreshed: at(dayThisMonth(1)), created_at: at(dayThisMonth(1)), updated_at: at(dayThisMonth(1)),
  quantity: 9, avg_price: 110, current_price: 150, invested_value_aed: 3636, day_change_pct: 0.5, price_symbol: 'ABC', price_provider: 'stub',
  price_fetch_error: null, price_fetch_fail_count: 0, priced_at: at(dayThisMonth(1)), price_fetched_at: at(dayThisMonth(1)),
  funds_account_id: F_USD, trades_version: 3, split_asked_for: null,
};
const FUND = {
  id: F_USD, household_id: ids.HH, owner_member_id: ids.ME, name: 'Dollar broker funds', type: 'broker_funds', currency: 'USD',
  balance: 1000, is_shared: false, created_at: at(dayThisMonth(1)), updated_at: at(dayThisMonth(1)), credit_limit: null, statement_day: null,
  due_day: null, principal: null, interest_rate_pct: null, compounding: null, opened_date: null, maturity_date: null, fd_status: 'active',
  balance_aed: 3672.5, archived_at: null, closing_note: null, balance_as_of: at(dayThisMonth(1)), brokerage_in_average: false,
};
const trade = (n, kind, units, price, extra = {}) => ({
  id: `abcabcab-1111-4000-8000-00000000000${n}`, household_id: ids.HH, holding_id: H_ABC, member_id: ids.ME, kind,
  trade_date: dayThisMonth(1), traded_at: null, units, price, fees: 0, tax_withheld: 0, tax_to_confirm: false,
  funds_account_id: kind === 'buy' || kind === 'sell' ? F_USD : null, cash_amount: 0, units_after: null, avg_after: null, realised: null,
  source: kind === 'opening' ? 'opening' : 'bot', proposal_id: null, note: null, created_at: at(dayThisMonth(1)), created_by: ids.ME, ...extra,
});
const TRADES = [
  trade(1, 'opening', 10, 100, { created_at: `${dayThisMonth(1)}T08:00:00+00:00` }),
  trade(2, 'buy', 5, 130, { created_at: `${dayThisMonth(1)}T10:00:00+00:00` }),
  trade(3, 'sell', 6, 150, { fees: 1, realised: 239, created_at: `${dayThisMonth(1)}T11:00:00+00:00` }),
];
const EFFECT = {
  ok: true, units: 3, price: 150, fees: 1, tax_withheld: 0, trades_version: 3, units_before: 9, avg_before: 110,
  holding_units_after: 6, holding_avg_after: 110, realised: 119, funds_account_id: F_USD, funds_delta: 449,
  funds_balance_before: 1000, funds_balance_after: 1449, warnings: [],
};

async function openInvestments(page) {
  await page.goto('/wealth', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.om-main')).toBeVisible();
  await expect(page.locator('.om-main .ov-skel')).toHaveCount(0);
  await page.getByRole('button', { name: 'Investments', exact: true }).first().click();
  await expect(page.locator('.wl-holdrow', { hasText: 'ABC' })).toBeVisible();
}

async function documentOverflows(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
}

test('a traded holding shows its trades, and a sale is checked before it is saved', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const saves = [];
  await stubSupabase(page, {
    tables: { holdings: [...data.holdings, HOLDING], holding_trades: TRADES, accounts: [...data.accounts, FUND] },
    rpc: { preview_trade: EFFECT, record_trade: { ...EFFECT, trade_id: 'abcabcab-2222-4000-8000-000000000001', trades_version: 4 } },
    onRest: (request) => {
      if (request.url().includes('/rpc/record_trade')) saves.push(request.postDataJSON());
    },
  });
  await openInvestments(page);
  await page.locator('.wl-holdrow', { hasText: 'ABC' }).click();

  const editor = page.getByRole('dialog', { name: 'Edit holding' });
  const list = editor.getByRole('list', { name: 'Trades' });
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(list.getByRole('listitem').first()).toContainText('Sell 6 at USD 150.00');
  await expect(list.getByRole('listitem').last()).toContainText('Opening 10 at USD 100.00');
  expect(await documentOverflows(page), 'the trades list scrolls the page sideways').toBe(false);

  if (testInfo.project.name === 'mobile') {
    for (const button of await list.getByRole('button').all()) {
      const box = await button.boundingBox();
      expect(box.height, `${await button.getAttribute('aria-label')} is under 44px tall`).toBeGreaterThanOrEqual(44);
    }
  }

  await editor.getByRole('button', { name: 'Record a trade' }).click();
  await editor.getByRole('button', { name: 'Sell', exact: true }).click();
  await editor.getByLabel('Units traded').fill('3');
  await editor.getByLabel('Price (USD)', { exact: true }).fill('150');
  await editor.getByLabel('Brokerage (USD)').fill('1');
  await editor.getByRole('button', { name: 'Check' }).click();
  await expect(editor.getByText('ABC: 9 → 6 shares, average USD 110.00')).toBeVisible();
  await expect(editor.getByText('Profit USD 119.00')).toBeVisible();
  await expect(editor.getByText('Dollar broker funds +USD 449.00')).toBeVisible();
  expect(await documentOverflows(page), 'the trade form scrolls the page sideways').toBe(false);
  await editor.screenshot({ path: testInfo.outputPath(`trade-check-${testInfo.project.name}.png`) });

  if (testInfo.project.name === 'mobile') {
    for (const name of ['Back to trades', 'Check', 'Save trade', 'Sell']) {
      const box = await editor.getByRole('button', { name, exact: true }).boundingBox();
      expect(box.height, `${name} is under 44px tall`).toBeGreaterThanOrEqual(44);
    }
  }

  await editor.getByRole('button', { name: 'Save trade' }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]).toMatchObject({ p_holding_id: H_ABC, p_kind: 'sell', p_units: 3, p_price: 150, p_fees: 1, p_expected_version: 3, p_funds_account_id: F_USD });
  expect(saves[0]).not.toHaveProperty('p_source');
  expect(saves[0]).not.toHaveProperty('p_proposal_id');
  expect(errors).toEqual([]);
});
