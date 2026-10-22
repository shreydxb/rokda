import { test, expect } from '@playwright/test';
import { stubSupabase, data, txn, dayThisMonth, ids } from './fixtures.js';

// An open page sees a change made elsewhere (by the bot or the other member)
// without a reload by hand, and without losing an edit in progress (product
// review, 15 October).

test('a record added elsewhere appears on an open page, and an open editor keeps its input', async ({ page }) => {
  const transactions = [...data.transactions];
  await page.clock.install();
  await stubSupabase(page, { tables: { transactions } });
  await page.goto('/money', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.om-main .ov-skel')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('.fresh')).toContainText(/Loaded \d{2}:\d{2}/);

  await page.getByRole('button', { name: '+ Add transaction' }).click();
  const merchant = page.getByPlaceholder('Type a merchant name');
  await merchant.fill('Half-typed');

  // The bot records an expense while the editor is open.
  transactions.push(txn('77777777-0000-4000-8000-0000000000aa', ids.A_CARD, ids.C_GROCERIES, -33, dayThisMonth(1), { merchant: 'Logged by the bot' }));
  await page.clock.fastForward('05:30');

  await expect(merchant).toHaveValue('Half-typed');
  // Closing asks before throwing the input away, as it always has.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByText('Logged by the bot')).toBeVisible();
});

test('Refresh reads the page again', async ({ page }) => {
  const transactions = [...data.transactions];
  await stubSupabase(page, { tables: { transactions } });
  await page.goto('/money', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.om-main .ov-skel')).toHaveCount(0, { timeout: 15_000 });

  transactions.push(txn('77777777-0000-4000-8000-0000000000ab', ids.A_CARD, ids.C_GROCERIES, -44, dayThisMonth(1), { merchant: 'Added by the partner' }));
  await expect(page.getByText('Added by the partner')).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText('Added by the partner')).toBeVisible();
});

test('Refresh keeps the page, and a note being written, on screen', async ({ page }) => {
  const note = { id: 'a3a3a3a3-0000-4000-8000-0000000000f1', household_id: ids.HH, title: 'Who pays what', body: 'Shared costs by income.', position: 1, updated_by: ids.ME, created_at: '2026-09-28T10:00:00Z', updated_at: '2026-09-28T10:00:00Z' };
  await stubSupabase(page, { tables: { household_notes: [note] } });
  await page.goto('/planning?tab=notes', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.om-main .ov-skel')).toHaveCount(0, { timeout: 15_000 });

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const title = page.getByPlaceholder('e.g. Who pays what');
  await title.fill('Who pays what, half-written');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('.fresh')).toContainText(/Loaded \d{2}:\d{2}/);
  // Refresh used to blank the whole page to its skeleton, and the draft went with it.
  await expect(title).toHaveValue('Who pays what, half-written');
});
