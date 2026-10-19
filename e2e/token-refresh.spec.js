import { test, expect } from '@playwright/test';
import { stubSupabase } from './fixtures.js';

// A signed-in member's token is refreshed about hourly, and a refresh in one
// tab reaches every tab of the same browser. Each new token is checked again
// for its second step, and while that check ran the app showed the two-step
// screen in place of every page, closing an open editor and losing what had
// been typed in it.

test('an open editor and what was typed in it survive a new token from another tab', async ({ page, context, baseURL }) => {
  await stubSupabase(page);
  await page.goto('/money?tab=activity', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.om-main .ov-skel')).toHaveCount(0, { timeout: 15_000 });
  await page.locator('.om-tx-row').first().click();
  const editor = page.getByRole('dialog', { name: 'Edit transaction' });
  const note = editor.locator('textarea');
  await note.fill('half-typed correction');

  // The second tab signs in with a token of its own, as a refresh does, and
  // stores it where every tab of this browser reads its session.
  const other = await context.newPage();
  await stubSupabase(other);
  await other.goto(new URL('/', baseURL).href, { waitUntil: 'domcontentloaded' });
  await expect(other.getByRole('navigation')).toBeVisible({ timeout: 15_000 });
  await page.bringToFront();

  // Long enough for this tab to hear of the new token and check it.
  await page.waitForTimeout(1_000);
  await expect(page.getByRole('heading', { name: 'Enter your code' })).toHaveCount(0);
  await expect(editor).toBeVisible();
  await expect(note).toHaveValue('half-typed correction');
});
