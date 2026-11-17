import { test, expect } from '@playwright/test';
import { dayThisMonth, ids, stubSupabase } from './fixtures.js';

// Wealth -> Investments at the narrow end of a desktop (the revamp, phase 5b;
// its fresh review): a household holding every kind of asset and a large
// total. The header's tools, with every group, must not push the page
// sideways, and Value, the strip's hero, must keep to its own column.

const at = (day) => `${day}T09:00:00+00:00`;
const CLASSES = ['us_equity', 'uae_equity', 'india_equity', 'crypto', 'commodity', 'sukuk', 'cash'];
const holding = (n, assetClass, value) => ({
  id: `abcabcab-5555-4000-8000-00000000000${n}`, household_id: ids.HH, owner_member_id: null, is_shared: true, name: `Holding ${n}`,
  asset_class: assetClass, sector: null, currency: 'AED', value_aed: value, last_refreshed: at(dayThisMonth(1)), created_at: at(dayThisMonth(1)),
  updated_at: at(dayThisMonth(1)), quantity: 10, avg_price: value / 12, current_price: value / 10, invested_value_aed: (value * 10) / 12,
  day_change_pct: 0.4, price_symbol: null, price_provider: null, price_fetch_error: null, price_fetch_fail_count: 0,
  priced_at: at(dayThisMonth(1)), price_fetched_at: null, trades_version: 0,
});
// About 4.7 million in all: a household total in dirhams, at its largest.
const HOLDINGS = CLASSES.map((c, i) => holding(i + 1, c, i === 0 ? 4_000_000 : 100_000 + i * 1_000));

async function openInvestments(page) {
  await stubSupabase(page, { tables: { holdings: HOLDINGS } });
  await page.goto('/wealth?tab=investments', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.om-main .ov-skel')).toHaveCount(0);
  await expect(page.locator('.inv-row').first()).toBeVisible();
}

for (const width of [1100, 1280]) {
  test(`at ${width}px, every group in the header and a seven-figure total keep to the page`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await openInvestments(page);
    await expect(page.getByRole('group', { name: 'Which holdings' }).getByRole('button')).toHaveCount(8);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'the header pushes the page sideways').toBeLessThanOrEqual(1);

    // Each figure keeps to its own column: the hero, and the four it made
    // room against.
    const kpis = await page.locator('.ds-kpi').evaluateAll((list) =>
      list.map((k) => {
        // The text's own extent: a figure's box keeps to its column while
        // the digits spill past it.
        const range = document.createRange();
        range.selectNodeContents(k.querySelector('.ds-hero, .ds-fig'));
        return { label: k.querySelector('dt').textContent, right: range.getBoundingClientRect().right, left: k.getBoundingClientRect().left };
      }),
    );
    for (let i = 0; i < kpis.length - 1; i += 1) {
      expect(kpis[i].right, `${kpis[i].label} runs into ${kpis[i + 1].label}`).toBeLessThanOrEqual(kpis[i + 1].left);
    }
  });
}
