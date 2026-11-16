import { test, expect } from '@playwright/test';
import { stubSupabase } from './fixtures.js';

// Wealth -> Net worth with the accounts ledger, and an account's drawer
// opened from its row or its address (the revamp, phase 5a).

async function open(page, url) {
  await stubSupabase(page);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.om-main .ov-skel')).toHaveCount(0, { timeout: 15_000 });
}

test('Net worth lists the accounts, and a card opens on its cycle with its statements a tab away', async ({ page }) => {
  await open(page, '/wealth');
  await expect(page.getByRole('region', { name: 'Assets', exact: true })).toContainText('Current account');
  await expect(page.getByRole('region', { name: 'Assets', exact: true })).toContainText('Investments');
  const liabilities = page.getByRole('region', { name: 'Liabilities', exact: true });
  await expect(liabilities).toContainText(/this cycle · closes (in \d+d|today)/);
  await liabilities.getByRole('button', { name: 'Platinum card' }).click();
  const drawer = page.getByRole('dialog', { name: 'Platinum card' });
  await expect(drawer.getByRole('tab', { name: 'This cycle' })).toHaveAttribute('aria-selected', 'true');
  await expect(drawer.getByText('Spent this cycle')).toBeVisible();
  await drawer.getByRole('tab', { name: 'Statements' }).click();
  await expect(page).toHaveURL(/\/wealth\?account=[^&]+&view=statements$/);
  await expect(drawer.getByRole('link', { name: 'Check statements in Month end' })).toBeVisible();
  await drawer.getByRole('button', { name: 'Close', exact: true }).first().click();
  await expect(page).toHaveURL(/\/wealth$/);
});

test('an old Accounts link opens Net worth, and + Account adds one', async ({ page }) => {
  await open(page, '/wealth?tab=accounts');
  await expect(page.getByRole('region', { name: 'Assets', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '+ Account' }).click();
  await expect(page.getByRole('dialog', { name: 'Add an account' })).toBeVisible();
});
