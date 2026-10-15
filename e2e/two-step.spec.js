import { test, expect } from '@playwright/test';
import { stubSupabase } from './fixtures.js';

// Signing in takes a password and a code (SHR-312). A password-only session
// sees the two-step screen whatever path it opens, and the app reads nothing
// of the household until it has passed: not one request to the data API.

for (const path of ['/', '/money', '/settings']) {
  test(`a password-only session opening ${path} is asked for its code and reads nothing`, async ({ page }) => {
    const reads = [];
    await stubSupabase(page, { aal: 'aal1', onRest: (request) => reads.push(request.url()) });
    await page.goto(path, { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
    await expect(page.getByRole('navigation')).toHaveCount(0);
    // Nothing of the household: not an account name, not a figure's heading.
    await expect(page.locator('body')).not.toContainText(/Current account|Needs attention/);
    expect(reads).toEqual([]);
  });
}

test('a member with no authenticator is shown how to add one, and reads nothing', async ({ page }, testInfo) => {
  const reads = [];
  await stubSupabase(page, { aal: 'aal1', factors: [], onRest: (request) => reads.push(request.url()) });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { name: 'Add an authenticator' })).toBeVisible();
  await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
  await expect(page.getByTestId('totp-secret')).toHaveText('JBSWY3DPEHPK3PXP');
  await page.screenshot({ path: testInfo.outputPath(`two-step-enroll-${testInfo.project.name}.png`), fullPage: true });

  // A phone-width page must not scroll sideways around the key.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
  expect(reads).toEqual([]);
});
