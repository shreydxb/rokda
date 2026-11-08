import { test, expect } from '@playwright/test';
import { data, ids, stubSupabase } from './fixtures.js';

// Dividend tax years: the Tax years section of Wealth → Dividends in a real
// browser, on a desktop and on a phone. The figures are the stub's, fixed:
// this is about the screen. A sold Indian holding with a long name still
// shows its year; one share differs from 26AS; the return's form and a
// dividend's tax year save through the database's functions.

const H_LONG = 'abcabcab-2222-4000-8000-000000000001';
const LONG_NAME = 'Long Name Industries Limited Equity Shares Of Face Value One';
const at = (dayString) => `${dayString}T09:00:00+00:00`;

const HOLDING = {
  id: H_LONG, household_id: ids.HH, owner_member_id: ids.ME, is_shared: false, name: LONG_NAME, asset_class: 'india_equity', currency: 'INR', sector: null,
  quantity: 0, avg_price: 400, current_price: 500, value_aed: 0, invested_value_aed: 0, day_change_pct: 0, price_symbol: 'LNG.NS', price_provider: 'yahoo',
  price_fetch_error: null, price_fetch_fail_count: 0, priced_at: at('2026-11-01'), price_fetched_at: at('2026-11-01'), last_refreshed: at('2026-11-01'),
  trades_version: 2, split_asked_for: null, dividend_tax_pct: 20.8, dividend_fee_per_share: 0, funds_account_id: null, created_at: at('2025-01-01'), updated_at: at('2026-11-01'),
};
const dividend = (n, credited) => ({
  id: `d2d2d2d2-0000-4000-8000-00000000000${n}`, household_id: ids.HH, holding_id: H_LONG, event_id: null, ex_date: null, record_date: null, pay_date: null, currency: 'INR',
  units: 10, units_basis: 'trades', per_share: 100, tax_pct: 20.8, expected_gross: 1000, expected_tax: 208, expected_fees: 0, expected_net: 792, received_gross: 1000,
  received_tax: 208, received_fees: 0, received_net: 792, status: 'received', evidence: 'intimation', credited_on: credited, credited_on_estimated: false, credited_at: null,
  paid_into_account_id: null, review_reason: null, review_event_id: null, review_baseline: null, fixed: false, source: 'import', import_ref: null, proposal_id: null,
  version: 1, note: null, asked_at: null, created_at: at(credited), updated_at: at(credited), updated_by: null, tax_financial_year: null, tax_year_basis: null,
});
const statement = (id, source) => ({ id, household_id: ids.HH, member_id: ids.ME, financial_year: 2025, source, as_of: '2026-06-15', imported_at: at('2026-11-01'), revision: 1 });
const RETURN = {
  id: 'fe100000-0000-4000-8000-000000000001', household_id: ids.HH, member_id: ids.ME, financial_year: 2025, claim_basis: 'treaty', claim_rate_pct: 10, revision: 1,
  filed_on: '2026-07-20', dividend_income: 2000, dividend_tax: 200, dividend_tds_claimed: 420, tds_claimed_total: 5000, note: null, version: 1,
  created_at: at('2026-07-20'), updated_at: at('2026-07-20'), updated_by: null,
};
const EVENTS = [
  { id: 'fe500000-0000-4000-8000-000000000001', household_id: ids.HH, return_id: RETURN.id, revision: 1, kind: 'processed', happened_on: '2026-09-01',
    refund_determined: 5000, refund_interest: 0, tds_allowed_total: 5000, amount: null, note: null, created_at: at('2026-09-01'), updated_at: at('2026-09-01'), updated_by: null },
  { id: 'fe500000-0000-4000-8000-000000000002', household_id: ids.HH, return_id: RETURN.id, revision: 1, kind: 'refund_credited', happened_on: '2026-10-05',
    refund_determined: null, refund_interest: null, tds_allowed_total: null, amount: 5000, note: null, created_at: at('2026-10-05'), updated_at: at('2026-10-05'), updated_by: null },
];

async function documentOverflows(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
}

test("the Tax years section: rows, the check, the return and a dividend's year", async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const sent = [];
  await stubSupabase(page, {
    tables: {
      holdings: [...data.holdings, HOLDING], holding_dividends: [dividend(1, '2025-08-01'), dividend(2, '2025-11-01')], holding_trades: [], dividend_events: [],
      dividend_splits: [], dividend_special_parts: [], tax_returns: [RETURN], tax_return_events: EVENTS,
      tax_statements: [statement('fe200000-0000-4000-8000-000000000001', 'ais'), statement('fe200000-0000-4000-8000-000000000002', '26as')],
      tax_statement_lines: [
        { id: 'fe300000-0000-4000-8000-000000000001', household_id: ids.HH, statement_id: 'fe200000-0000-4000-8000-000000000001', symbol: 'LNG.NS', payer: 'Long Name Industries', gross: 2000, tds: null },
        { id: 'fe300000-0000-4000-8000-000000000002', household_id: ids.HH, statement_id: 'fe200000-0000-4000-8000-000000000002', symbol: 'LNG.NS', payer: 'Long Name Industries', gross: 2000, tds: 420 },
      ],
    },
    rpc: { dividend_feed_status: [], save_tax_return: { ok: true, id: RETURN.id, version: 2 }, set_dividend_tax_year: { ok: true, version: 2 } },
    onRest: (request) => {
      if (request.url().includes('/rpc/save_tax_return') || request.url().includes('/rpc/set_dividend_tax_year')) sent.push(request.postDataJSON());
    },
  });
  await page.goto('/wealth', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.om-main')).toBeVisible();
  await expect(page.locator('.om-main .ov-skel')).toHaveCount(0);
  await page.getByRole('button', { name: 'Dividends', exact: true }).first().click();

  const region = page.getByRole('region', { name: 'Tax years' });
  await region.scrollIntoViewIfNeeded();
  const row = region.getByRole('button', { name: /^FY 2025-26 \(AY 2026-27\)/ });
  await expect(row).toContainText('1 difference');
  await expect(row).toContainText('dividend tax surplus INR 220.00');
  expect(await documentOverflows(page), 'the section scrolls the page sideways').toBe(false);
  await region.screenshot({ path: testInfo.outputPath(`tax-years-closed-${testInfo.project.name}.png`) });

  await row.click();
  await expect(region.getByText(/^Original return, filed /)).toBeVisible();
  // Tax higher with gross equal: a possible extra deduction, offered as a possibility.
  await expect(region.getByText(/^Tax: Rokda INR 416\.00 · 26AS INR 420\.00 · 26AS INR 4\.00 more: possibly an additional deduction/)).toBeVisible();
  const name = region.getByText(LONG_NAME, { exact: true });
  const box = await name.boundingBox();
  expect(box.x + box.width, 'the long name runs off the screen').toBeLessThanOrEqual(page.viewportSize().width + 1);
  expect(await documentOverflows(page), 'the open year scrolls the page sideways').toBe(false);
  await region.screenshot({ path: testInfo.outputPath(`tax-years-open-${testInfo.project.name}.png`) });

  // Every control in the section is a thumb's height on a phone.
  if (testInfo.project.name === 'mobile') {
    for (const control of await region.locator('button, summary').all()) {
      const b = await control.boundingBox();
      expect(b.height, `${await control.textContent()} is under 44px tall`).toBeGreaterThanOrEqual(44);
    }
  }

  // The return's dividend tax, corrected through the form.
  await region.getByRole('button', { name: 'Edit', exact: true }).click();
  await region.getByLabel('Dividend tax', { exact: true }).fill('1000');
  expect(await documentOverflows(page), 'the open form scrolls the page sideways').toBe(false);
  await region.screenshot({ path: testInfo.outputPath(`tax-years-form-${testInfo.project.name}.png`) });
  await region.getByRole('button', { name: 'Save return', exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toEqual({ p_member_id: ids.ME, p_financial_year: 2025, p_change: { dividend_tax: 1000 }, p_expected_version: 1 });

  // A dividend's own tax year.
  await region.getByText('Dividends (2)').click();
  await region.getByRole('button', { name: 'Set tax year', exact: true }).first().click();
  await region.getByRole('button', { name: 'Save tax year', exact: true }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toMatchObject({ p_dividend_id: dividend(1, '').id, p_financial_year: 2025, p_basis: 'declared', p_expected_version: 1 });

  expect(errors).toEqual([]);
});
