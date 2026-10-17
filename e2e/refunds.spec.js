import { test, expect } from '@playwright/test';
import { stubSupabase, dayThisMonth, ids, txn } from './fixtures.js';

// A refund linked to the purchase it returns (SHR-234). The fixtures have a
// Spinneys purchase on the card and a Spinneys refund the day after.

const PURCHASE = '77777777-0000-4000-8000-000000000003';
const REFUND = '77777777-0000-4000-8000-000000000005';

async function openActivity(page, { links = [], onRest } = {}) {
  await stubSupabase(page, { tables: { transaction_links: links }, onRest });
  await page.goto('/money?tab=activity&dates=all', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.om-main .ov-skel')).toHaveCount(0, { timeout: 15_000 });
}

test('a refund is linked to the purchase it returns from its editor', async ({ page }) => {
  const calls = [];
  await openActivity(page, {
    onRest: (request) => {
      if (request.url().includes('/rpc/link_refund')) calls.push(request.postDataJSON());
    },
  });
  await page.locator('.om-tx-row').filter({ hasText: 'refund' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit transaction' });
  const group = dialog.getByRole('group', { name: 'Refund for' });
  await group.getByRole('button', { name: /Spinneys/ }).click();
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toHaveCount(0);
  expect(calls).toEqual([{ p_purchase_id: PURCHASE, p_refund_id: REFUND }]);
});

test('a linked refund and its purchase say so in the list', async ({ page }) => {
  const links = [{ id: '99999999-7777-4777-8777-0000000000f1', household_id: ids.HH, kind: 'refund', from_transaction_id: PURCHASE, to_transaction_id: REFUND, created_by: ids.ME, created_at: `${dayThisMonth(12)}T09:00:00+00:00` }];
  await openActivity(page, { links });
  await expect(page.locator('.om-tx-row').filter({ hasText: 'refund for Spinneys' })).toHaveCount(1);
  await expect(page.locator('.om-tx-row').filter({ hasText: 'part refunded' })).toHaveCount(1);
});

// QA regression check, 17 October: a linked split refund's amount couldn't be
// changed, because the editor held its old lines to the new amount and the
// lines are the purchase's to set. The database shares them out again.
test("a linked split refund's amount can be changed, and only the amount is sent", async ({ page }) => {
  const P = '77777777-7777-4777-8777-0000000000b1';
  const R = '77777777-7777-4777-8777-0000000000b2';
  const lines = (a, b) => [{ category_id: ids.C_GROCERIES, amount: a }, { category_id: ids.C_DINING, amount: b }];
  const transactions = [
    txn(P, ids.A_CARD, null, -100, dayThisMonth(1), { merchant: 'Split purchase', is_split: true, transaction_splits: lines(-75, -25) }),
    txn(R, ids.A_CARD, null, 20, dayThisMonth(2), { merchant: 'Split refund', kind: 'refund', is_split: true, transaction_splits: lines(15, 5) }),
  ];
  const patches = [];
  await stubSupabase(page, {
    tables: { transactions, transaction_links: [{ id: 'refund-link', household_id: ids.HH, kind: 'refund', from_transaction_id: P, to_transaction_id: R }] },
    onRest: (request) => {
      if (request.method() === 'PATCH') patches.push(request.postDataJSON());
    },
  });
  await page.goto('/money?tab=activity', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.om-main .ov-skel')).toHaveCount(0, { timeout: 15_000 });
  await page.locator('.om-tx-row').filter({ hasText: 'Split refund' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit transaction' });
  await dialog.getByPlaceholder('0').fill('30');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toHaveCount(0);
  expect(patches).toHaveLength(1);
  expect(patches[0]).toMatchObject({ amount: 30, kind: 'refund' });
  expect(patches[0]).not.toHaveProperty('category_id');
});
