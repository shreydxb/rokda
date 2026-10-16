import { test, expect } from '@playwright/test';
import { stubSupabase, dayThisMonth, ids } from './fixtures.js';

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
