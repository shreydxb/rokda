import { test, expect } from '@playwright/test';
import { stubSupabase, data, txn, dayThisMonth, ids } from './fixtures.js';

// One receipt across several categories: it stays one record, and each
// category counts only its line (SHR-233).

const RECEIPT = '77777777-7777-4777-8777-0000000000d1';
const transactions = [
  ...data.transactions,
  txn(RECEIPT, ids.A_CARD, null, -500, dayThisMonth(1), {
    merchant: 'Hypermarket',
    is_split: true,
    transaction_splits: [
      { id: 'l1', category_id: ids.C_GROCERIES, amount: -400 },
      { id: 'l2', category_id: ids.C_DINING, amount: -100 },
    ],
  }),
];

async function openActivity(page, url = '/money', onRest) {
  await stubSupabase(page, { tables: { transactions }, onRest });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.om-main .ov-skel')).toHaveCount(0, { timeout: 15_000 });
}

test('a split receipt shows its categories and counts only its line when narrowed to one', async ({ page }) => {
  await openActivity(page);
  await expect(page.locator('.om-tx-row').filter({ hasText: 'Hypermarket' })).toContainText('Groceries + Dining out');

  await openActivity(page, `/money?tab=activity&cat=${ids.C_DINING}`);
  const row = page.locator('.om-tx-row').filter({ hasText: 'Hypermarket' });
  await expect(row).toContainText('−500');
  await expect(row).toContainText('Dining out −100');
  // The fixtures' own dining (220) plus the receipt's 100 dining line.
  await expect(page.locator('.mn-count')).toContainText('Net spend AED 320');
});

test('a new receipt is split in one call after it is saved', async ({ page }) => {
  const calls = [];
  await openActivity(page, '/money', (request) => {
    if (request.url().includes('/rpc/split_transaction')) calls.push(request.postDataJSON());
  });
  await page.getByRole('button', { name: '+ Add transaction' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add transaction' });
  await dialog.getByPlaceholder('0').fill('500');
  await dialog.getByRole('button', { name: 'Split across categories' }).click();
  await dialog.getByLabel('Category 1').selectOption({ label: 'Groceries' });
  await dialog.getByLabel('Amount 1').fill('400');
  await dialog.getByLabel('Category 2').selectOption({ label: 'Dining out' });
  await dialog.getByLabel('Amount 2').fill('100');
  await expect(dialog.getByText('Adds up')).toBeVisible();
  await dialog.getByRole('button', { name: 'Add transaction' }).click();
  await expect(dialog).toHaveCount(0);
  expect(calls).toEqual([
    expect.objectContaining({ p_lines: [{ category_id: ids.C_GROCERIES, amount: 400 }, { category_id: ids.C_DINING, amount: 100 }], p_amount: 500 }),
  ]);
});
