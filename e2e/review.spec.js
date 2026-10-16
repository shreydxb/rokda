import { test, expect } from '@playwright/test';
import { stubSupabase } from './fixtures.js';

// The monthly review: what to settle before a month's totals go into history,
// each check linked to where it is done (docs/decisions.md, "A month is
// reviewed, then closed").

async function open(page, url) {
  await stubSupabase(page);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.om-main .ov-skel')).toHaveCount(0, { timeout: 15_000 });
}

test('the month just ended lists what is left, and each check opens where it is done', async ({ page }) => {
  await open(page, '/money?tab=review');
  // The fixtures closed last month and categorised its records; the card's
  // statement for it has not been checked.
  await expect(page.locator('.rv-progress')).toHaveText('4 of 5 done');
  const statements = page.getByTestId('review-statements');
  await expect(statements).toContainText('Platinum card');
  await expect(statements).toContainText('Not checked');
  await statements.getByRole('link', { name: 'Check statements' }).click();
  await expect(page).toHaveURL(/\/wealth\?tab=statements$/);
});

test('Activity can show just the records with no category', async ({ page }) => {
  await open(page, '/money?tab=activity&cat=none&dates=all');
  await expect(page.getByLabel('Category')).toHaveValue('none');
  const rows = page.locator('.om-tx-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Unknown');
});
