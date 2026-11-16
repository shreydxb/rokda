import { test, expect } from '@playwright/test';
import { stubSupabase, txn, dayThisMonth, ids, data, pickInShell } from './fixtures.js';

// Context survives the round trip (QA re-review, 17 October): the month and
// person a page was showing come back after Back and reload, Month end's
// links open the records they counted, and a save that changed no row is not
// reported as saved. Each test reproduced a defect before the fix.

async function open(page, path, options = {}) {
  await stubSupabase(page, options);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.om-main .ov-skel')).toHaveCount(0, { timeout: 15_000 });
}

// A CSS locator, not a role: on a phone the switches are folded away, and a
// hidden button has no role to find, but its state still counts.
const scope = (page, name) => page.locator('[aria-label="Household scope"] .om-scope', { hasText: new RegExp(`^${name}$`) });

// Insights is gone (the revamp, phase 4b): a budget line's records are the
// figure that opens Activity for a month now.
test("Back from a budget line's records returns to the month it came from", async ({ page }) => {
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const budgets = data.budgets.map((b) => ({ ...b, id: b.id.replace(/1$/, '9'), year: last.getFullYear(), month: last.getMonth() + 1 }));
  await open(page, '/money?tab=budget', { tables: { budgets: [...data.budgets, ...budgets] } });
  const label = page.locator('.ds-stepper-label');
  const current = await label.innerText();
  await page.getByRole('button', { name: 'Previous month' }).click();
  await expect(label).not.toHaveText(current);
  const chosen = await label.innerText();
  await page.getByRole('button', { name: 'Groceries', exact: true }).click();
  await page.getByRole('region', { name: 'Groceries this month' }).getByRole('button', { name: 'All in Activity →' }).click();
  await expect(page).toHaveURL(/tab=activity/);
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Budget', exact: true })).toHaveAttribute('data-active', 'true');
  await expect(label).toHaveText(chosen);
});

test('reload keeps the person whose figures were shown', async ({ page }) => {
  const transactions = [
    txn('77777777-7777-4777-8777-000000000001', ids.A_CARD, ids.C_GROCERIES, -100, dayThisMonth(1)),
    txn('77777777-7777-4777-8777-000000000002', ids.A_CARD, ids.C_GROCERIES, 20, dayThisMonth(1), { kind: 'refund' }),
  ];
  await open(page, '/money?tab=activity', { tables: { transactions } });
  await pickInShell(page, 'Household scope', 'Me');
  await expect(page.locator('.mn-summary')).toContainText('Spent 40');
  await page.reload();
  await expect(page.locator('.mn-summary')).toContainText('Spent 40');
  await expect(scope(page, 'Me')).toHaveAttribute('data-active', 'true');
});

test("Month end's records link opens the partner's records it counted while viewing Me", async ({ page }) => {
  const d = new Date();
  const last = new Date(d.getFullYear(), d.getMonth() - 1, 5);
  const month = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}`;
  const transactions = [txn('77777777-7777-4777-8777-000000000001', ids.A_CARD, ids.C_GROCERIES, -100, `${month}-05`, { is_shared: false, owner_member_id: data.household_members[1].id, needs_review: true, merchant: 'Partner purchase' })];
  // Not closed yet, so Month end shows its steps.
  const netWorthSnapshots = data.net_worth_snapshots.filter((s) => !s.snapshot_date.startsWith(month));
  await open(page, `/money?tab=monthend&month=${month}`, { tables: { transactions, net_worth_snapshots: netWorthSnapshots } });
  await pickInShell(page, 'Household scope', 'Me');
  const flagged = page.locator('.me-sub-h', { hasText: 'Flagged · 1' }).locator('xpath=following-sibling::div[1]');
  await expect(flagged).toContainText('1 record');
  await flagged.getByRole('link', { name: 'Open the records' }).click();
  await expect(page.locator('.om-tx-row')).toHaveCount(1);
});

test("an old link to a month's statements opens the ones that closed that month, on Month end", async ({ page }) => {
  const d = new Date();
  const before = new Date(d.getFullYear(), d.getMonth() - 2, 1);
  const month = `${before.getFullYear()}-${String(before.getMonth() + 1).padStart(2, '0')}`;
  const closeDay = new Date(before.getFullYear(), before.getMonth(), 10).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).replace('Sept', 'Sep');
  const accounts = data.accounts.map((a) => ({ ...a, created_at: '2024-01-01T00:00:00Z' }));
  // No month closed, so that month shows its steps rather than its page.
  await open(page, `/wealth?tab=statements&month=${month}`, { tables: { accounts, net_worth_snapshots: [] } });
  await expect(page).toHaveURL(new RegExp(`/money\\?tab=monthend&month=${month}&step=2$`));
  const statements = page.getByRole('region', { name: 'Statements to check' });
  await expect(statements.getByRole('button', { name: new RegExp(`– ${closeDay}$`) })).toHaveCount(1);
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
  await page.locator('.om-tx-row .mn-open').first().click();
  const editor = page.getByRole('dialog', { name: 'Edit transaction' });
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => attempted).toBe(true);
  await expect(editor.getByRole('alert')).toContainText("This record wasn't saved");
});
