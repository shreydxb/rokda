import { test, expect } from '@playwright/test';
import { stubSupabase, txn, dayThisMonth, ids, data } from './fixtures.js';

// Context survives the round trip (QA re-review, 17 October): the month and
// person a page was showing come back after Back and reload, the monthly
// review's links open the records they counted, and a save that changed no row
// is not reported as saved. Each test reproduced a defect before the fix.

async function open(page, path, options = {}) {
  await stubSupabase(page, options);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.om-main .ov-skel')).toHaveCount(0, { timeout: 15_000 });
}

const scope = (page, name) => page.getByRole('group', { name: 'Household scope' }).getByRole('button', { name, exact: true });

test('Back from an Insights figure returns to the month it came from', async ({ page }) => {
  await open(page, '/money?tab=insights');
  const label = page.locator('.cal-nav .fig');
  const current = await label.innerText();
  await page.getByRole('button', { name: '← Prev' }).click();
  // The address changes a render before the label does.
  await expect(label).not.toHaveText(current);
  const chosen = await label.innerText();
  await page.locator('.ins-cmp-row').filter({ hasText: 'Groceries' }).click();
  await expect(page).toHaveURL(/tab=activity/);
  await page.goBack();
  await expect(label).toHaveText(chosen);
});

test('reload keeps the person whose figures were shown', async ({ page }) => {
  const transactions = [
    txn('77777777-7777-4777-8777-000000000001', ids.A_CARD, ids.C_GROCERIES, -100, dayThisMonth(1)),
    txn('77777777-7777-4777-8777-000000000002', ids.A_CARD, ids.C_GROCERIES, 20, dayThisMonth(1), { kind: 'refund' }),
  ];
  await open(page, '/money?tab=activity', { tables: { transactions } });
  await scope(page, 'Me').click();
  await expect(page.locator('.mn-count')).toContainText('Net spend AED 40');
  await page.reload();
  await expect(page.locator('.mn-count')).toContainText('Net spend AED 40');
  await expect(scope(page, 'Me')).toHaveAttribute('data-active', 'true');
});

test("the review's records link opens the partner's records it counted while viewing Me", async ({ page }) => {
  const d = new Date();
  const last = new Date(d.getFullYear(), d.getMonth() - 1, 5);
  const day = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-05`;
  const transactions = [txn('77777777-7777-4777-8777-000000000001', ids.A_CARD, ids.C_GROCERIES, -100, day, { is_shared: false, owner_member_id: data.household_members[1].id, needs_review: true, merchant: 'Partner purchase' })];
  await open(page, '/money?tab=review', { tables: { transactions } });
  await scope(page, 'Me').click();
  const check = page.getByTestId('review-review');
  await expect(check).toContainText('1 record');
  await check.getByRole('link', { name: 'Open the records' }).click();
  await expect(page.locator('.om-tx-row')).toHaveCount(1);
});

test("an old month's statement link opens the statements that closed that month", async ({ page }) => {
  const accounts = data.accounts.map((a) => ({ ...a, created_at: '2024-01-01T00:00:00Z' }));
  await open(page, '/money?tab=review&month=2025-03', { tables: { accounts } });
  await page.getByTestId('review-statements').getByRole('link', { name: 'Check statements' }).click();
  await expect(page.getByText('Statements that closed in March 2025')).toBeVisible();
  await expect(page.getByTestId('statement-row').filter({ hasText: 'Closed 10 Mar' })).toHaveCount(1);
});

test('a save that matched no row stays open with an error', async ({ page }) => {
  let attempted = false;
  await open(page, '/money?tab=activity');
  await page.route('**/rest/v1/transactions*', async (route) => {
    if (route.request().method() === 'PATCH') {
      attempted = true;
      return route.fulfill({ status: 200, json: [], headers: { 'content-range': '*/0' } });
    }
    return route.fallback();
  });
  await page.locator('.om-tx-row').first().click();
  const editor = page.getByRole('dialog', { name: 'Edit transaction' });
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => attempted).toBe(true);
  await expect(editor.getByRole('alert')).toContainText("This record wasn't saved");
});
