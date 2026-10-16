import { test, expect } from '@playwright/test';
import { stubSupabase, data, txn, dayThisMonth, ids } from './fixtures.js';

// Money moved between the household's own accounts is a transfer: two sides,
// one link, and neither income nor spending (SHR-234).

const OUT = '77777777-7777-4777-8777-0000000000c1';
const IN = '77777777-7777-4777-8777-0000000000c2';
const transactions = [
  ...data.transactions,
  txn(OUT, ids.A_CURRENT, null, -5000, dayThisMonth(1), { kind: 'transfer', merchant: null }),
  txn(IN, ids.A_SAVINGS, null, 5000, dayThisMonth(1), { kind: 'transfer', merchant: null }),
];
const links = [{ id: '99999999-7777-4777-8777-000000000001', household_id: ids.HH, kind: 'transfer', from_transaction_id: OUT, to_transaction_id: IN, created_by: ids.ME, created_at: `${dayThisMonth(1)}T09:00:00+00:00` }];

async function openActivity(page, onRest) {
  await stubSupabase(page, { tables: { transactions, transaction_links: links }, onRest });
  await page.goto('/money', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.om-main .ov-skel')).toHaveCount(0, { timeout: 15_000 });
}

test('a transfer shows where the money went and stays out of the totals', async ({ page }) => {
  await openActivity(page);
  await expect(page.locator('.om-tx-row').filter({ hasText: 'To Savings' })).toHaveCount(1);
  await expect(page.locator('.om-tx-row').filter({ hasText: 'From Current account' })).toHaveCount(1);
  // The fixtures' own income and spending, unchanged by the 5,000 moved.
  await expect(page.locator('.mn-count')).toContainText('Income AED 18,000 · 2 transfers between accounts, in neither');

  await page.locator('.om-tx-row').filter({ hasText: 'To Savings' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit transfer' })).toBeVisible();
  await expect(page.getByLabel('Amount')).toHaveValue('5000');
});

test('a new transfer is recorded as both sides in one call', async ({ page }) => {
  const calls = [];
  await openActivity(page, (request) => {
    if (request.url().includes('/rpc/record_transfer')) calls.push(request.postDataJSON());
  });
  await page.getByRole('button', { name: '+ Add transaction' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Transfer', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add transfer' });
  await dialog.getByLabel('Amount').fill('750');
  await dialog.getByLabel('From account').selectOption({ label: 'Current account' });
  await dialog.getByLabel('To account').selectOption({ label: 'Savings' });
  await dialog.getByRole('button', { name: 'Add transfer' }).click();
  await expect(dialog).toHaveCount(0);
  expect(calls).toEqual([expect.objectContaining({ p_from_account_id: ids.A_CURRENT, p_to_account_id: ids.A_SAVINGS, p_amount: 750 })]);
});
