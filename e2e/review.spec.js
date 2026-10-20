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
  await expect(page).toHaveURL(/\/wealth\?tab=statements&month=(\d{4}-\d{2})&reviewing=\1$/);
  // The page the review opened leads back to it.
  await page.getByRole('link', { name: /^← Back to the \w+ review$/ }).click();
  await expect(page).toHaveURL(/\/money\?tab=review&month=\d{4}-\d{2}$/);
  await expect(page.locator('.rv-progress')).toHaveText('4 of 5 done');
});

test('the review leads with the next check and ends in what goes into history', async ({ page }) => {
  await open(page, '/money?tab=review');
  const next = page.getByRole('region', { name: 'Next step' });
  await expect(next).toContainText('Card statements');
  await expect(next.getByRole('link', { name: 'Check statements' })).toBeVisible();
  const history = page.getByRole('region', { name: /What (goes|went) into history/ });
  await expect(history).toContainText('Net worth');
  await expect(page.getByRole('region', { name: 'What to do next' })).toBeVisible();
});

test('Activity can show just the records with no category', async ({ page }) => {
  await open(page, '/money?tab=activity&cat=none&dates=all');
  await expect(page.getByLabel('Category')).toHaveValue('none');
  const rows = page.locator('.om-tx-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Unknown');
});
