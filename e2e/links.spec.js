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
const lastMonth = () => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
};

test("Overview's Recurring link opens the Recurring tab, and Back returns", async ({ page }) => {
  await open(page, '/');
  await page.locator('.ov-next30').getByText('Recurring →').last().click();
  await expect(page).toHaveURL(/\/money\?tab=recurring$/);
  await expect(activeTab(page)).toHaveText('Recurring');
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
});

test('an Insights figure opens its month and category in Activity, through Back and reload', async ({ page }) => {
  await open(page, '/money?tab=insights');
  await expect(activeTab(page)).toHaveText('Insights');
  await page.getByRole('button', { name: '← Prev' }).click();
  await page.locator('.ins-cmp-row').filter({ hasText: 'Groceries' }).click();

  await expect(page).toHaveURL(/tab=activity&cat=[^&]+&from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-\d{2}$/);
  const summary = page.locator('.mn-count');
  await expect(summary).toContainText(`1 posted record · ${lastMonth()} · Net spend AED 300`);
  await expect(page.getByRole('combobox', { name: 'Dates' })).toHaveValue('last-month');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(summary).toContainText('Net spend AED 300');

  await page.goBack();
  await expect(activeTab(page)).toHaveText('Insights');
});

test("a budget's records open from its editor, for its month and category", async ({ page }) => {
  await open(page, '/money?tab=budget');
  await page.locator('.bud-tr').filter({ hasText: 'Groceries' }).first().click();
  await page.getByRole('button', { name: 'See the records →' }).click();
  await expect(page).toHaveURL(/tab=activity&cat=[^&]+&from=\d{4}-\d{2}-01&to=/);
  await expect(page.getByRole('combobox', { name: 'Category' }).locator('option:checked')).toHaveText('Groceries');
});
