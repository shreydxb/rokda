import { test, expect } from '@playwright/test';
import { stubSupabase } from './fixtures.js';

// Links keep their context (product review, 15 October): a summary opens the
// tab and the records it is about, and Back and reload keep them. Overview's
// Recurring link used to open Money's first tab, and Insights opened all of a
// category's history for a monthly figure.

async function open(page, path) {
  await stubSupabase(page);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.om-main .ov-skel')).toHaveCount(0, { timeout: 15_000 });
}

const activeTab = (page) => page.locator('.mn-tabs button[data-active="true"]');
test("Overview's Recurring link opens the Recurring tab, and Back returns", async ({ page }) => {
  await open(page, '/');
  await page.locator('.ov-next30').getByText('Recurring →').last().click();
  await expect(page).toHaveURL(/\/money\?tab=recurring$/);
  await expect(activeTab(page)).toHaveText('Recurring');
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
});

// Insights is gone (the revamp, phase 4b): an old link opens Activity's
// Merchants for its month, and a merchant opens its records.
test("an old Insights link opens Activity's Merchants for its month", async ({ page }) => {
  await open(page, '/money?tab=insights');
  await expect(page).toHaveURL(/\/money\?tab=activity&view=merchants$/);
  await expect(activeTab(page)).toHaveText('Activity');
  const merchants = page.getByRole('region', { name: /^Merchants · / });
  await merchants.getByRole('button', { name: /^Landlord/ }).click();
  await expect(page).toHaveURL(/tab=activity&q=Landlord$/);
  await expect(page.getByRole('region', { name: '1 transaction' })).toBeVisible();
});

test("a budget line's records open in Activity, for its month and category", async ({ page }) => {
  await open(page, '/money?tab=budget');
  await page.getByRole('button', { name: 'Groceries', exact: true }).click();
  await page.getByRole('region', { name: 'Groceries this month' }).getByRole('button', { name: 'All in Activity →' }).click();
  await expect(page).toHaveURL(/tab=activity&cat=[^&]+&from=\d{4}-\d{2}-01&to=/);
  await expect(page.getByRole('combobox', { name: 'Category', exact: true }).locator('option:checked')).toHaveText('Groceries');
});
