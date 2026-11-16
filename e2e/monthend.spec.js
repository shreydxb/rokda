import { test, expect } from '@playwright/test';
import { stubSupabase, data } from './fixtures.js';

// Money -> Month end (the revamp, phase 4d; docs/decisions.md, "Month end,
// in place of Review and Statements"): the running month with the card
// statements still open, the month just ended as three steps, and a closed
// month on a page.

async function open(page, url, options = {}) {
  await stubSupabase(page, options);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.om-main .ov-skel')).toHaveCount(0, { timeout: 15_000 });
}

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const LAST = `${last.getFullYear()}-${pad(last.getMonth() + 1)}`;
const LAST_NAME = last.toLocaleDateString('en-GB', { month: 'long' });

test('the running month lists the card statements still open', async ({ page }) => {
  await open(page, '/money?tab=monthend');
  await expect(page.getByRole('heading', { name: /is still running$/ })).toBeVisible();
  // The fixtures closed last month, so there is nothing to close.
  await expect(page.getByRole('link', { name: /^Close / })).toHaveCount(0);
  const statements = page.getByRole('region', { name: 'Card statements' });
  await expect(statements.getByRole('link', { name: 'Platinum card →' }).first()).toBeVisible();
  await expect(statements.getByRole('button', { name: 'Mark done' }).first()).toBeVisible();
});

test('an old link to the review or to Statements opens Month end', async ({ page }) => {
  await open(page, '/money?tab=review');
  await expect(page.getByRole('heading', { name: /is still running$/ })).toBeVisible();
  await page.goto(`/wealth?tab=statements&month=${LAST}`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(new RegExp(`/money\\?tab=monthend&month=${LAST}&step=2$`));
});

test('the month just ended is three steps, and a balance to confirm leads back to it', async ({ page }) => {
  // Last month not closed yet, and the current account's balance not
  // confirmed since it ended.
  const accounts = data.accounts.map((a) => (a.name === 'Current account' ? { ...a, balance_as_of: `${LAST}-20T09:00:00+00:00` } : a));
  const netWorthSnapshots = data.net_worth_snapshots.filter((s) => !s.snapshot_date.startsWith(LAST));
  await open(page, `/money?tab=monthend&month=${LAST}`, { tables: { accounts, net_worth_snapshots: netWorthSnapshots } });
  await expect(page.getByRole('heading', { name: `Close ${LAST_NAME}` })).toBeVisible();
  await expect(page.getByText(/^\d of 3 steps done$/)).toBeVisible();
  const check = page.locator('.me-step').filter({ hasText: 'Check statements and balances' });
  await expect(check.getByRole('button', { expanded: true })).toBeVisible();
  // The card's statement that closed last month, in the statements table.
  await expect(check.getByRole('region', { name: 'Statements to check' })).toContainText('Platinum card');
  await check.getByRole('link', { name: 'Confirm balance' }).click();
  await expect(page).toHaveURL(new RegExp(`/wealth\\?tab=accounts&reviewing=${LAST}$`));
  await page.getByRole('link', { name: `← Back to Month end for ${LAST_NAME}` }).click();
  await expect(page).toHaveURL(new RegExp(`/money\\?tab=monthend&month=${LAST}$`));
  await expect(page.getByRole('heading', { name: `Close ${LAST_NAME}` })).toBeVisible();
});

test('a closed month reads as the month on a page', async ({ page }) => {
  await open(page, `/money?tab=monthend&month=${LAST}`);
  await expect(page.getByText('The month on a page')).toBeVisible();
  await expect(page.getByText('Net worth at close')).toBeVisible();
  await expect(page.getByRole('region', { name: /^Biggest (changes|categories)$/ })).toContainText('Groceries');
  await expect(page.getByRole('region', { name: 'Against budget' })).toBeVisible();
});

test('Activity can show just the records with no category', async ({ page }) => {
  await open(page, '/money?tab=activity&cat=none&dates=all');
  await expect(page.getByRole('combobox', { name: 'Category', exact: true })).toHaveValue('none');
  const rows = page.locator('.om-tx-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Unknown');
});
