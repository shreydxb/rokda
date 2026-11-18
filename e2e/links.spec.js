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

// A yearly check that is due opens its own note (the revamp, phase 6c):
// Overview's reminder used to open the Notes tab, where every note was shown
// in full and the one due had to be found.
test("Overview's yearly reminder opens the note that is due", async ({ page }) => {
  const due = (n, title) => ({ id: `a3a3a3a3-0000-4000-8000-00000000004${n}`, household_id: 'hh', title, body: `${title} body.`, position: n, updated_by: null, updated_at: '2026-09-28T10:00:00Z', check_yearly: true, checked_on: null });
  await stubSupabase(page, { tables: { household_notes: [due(1, 'Insurance'), due(2, 'Wills')] } });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.om-main .ov-skel')).toHaveCount(0, { timeout: 15_000 });
  await page.getByRole('button', { name: /^Show all/ }).click();
  await page.getByRole('listitem').filter({ hasText: 'Wills' }).getByRole('link', { name: 'Open note' }).click();
  await expect(page).toHaveURL(/\/planning\?tab=notes&note=a3a3a3a3-0000-4000-8000-000000000042$/);
  await expect(page.getByRole('region', { name: 'Wills' })).toContainText('Wills body.');
});
