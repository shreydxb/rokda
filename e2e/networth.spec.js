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

// The fresh review of 5a: at about 1100 px the ledger's figures were cut off
// as soon as a row said "Not confirmed" with Confirm.
test('the ledger fits a narrower window without cutting its figures off', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  const { data } = await import('./fixtures.js');
  const accounts = data.accounts.map((a) => (a.name === 'Savings' ? { ...a, balance_as_of: null } : a));
  await stubSupabase(page, { tables: { accounts } });
  await page.goto('/wealth', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.om-main .ov-skel')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole('region', { name: 'Assets', exact: true })).toContainText('Not confirmed');
  const overflow = await page.locator('.nw .ds-table-wrap').evaluateAll((wraps) => wraps.map((w) => w.scrollWidth - w.clientWidth));
  expect(overflow.every((px) => px <= 1)).toBe(true);
});
