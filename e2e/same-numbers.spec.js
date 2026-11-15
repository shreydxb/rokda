import { test, expect } from '@playwright/test';
import { stubSupabase, txn, dayThisMonth, ids, pickInShell } from './fixtures.js';

// The same money reads the same way on every view (product review, 15
// October). The reviewer's case: a shared expense of 100 and a shared refund
// of 20. Under Me that is 40 spent and nothing earned, in the list and on the
// calendar alike; the calendar used to say 100 spent and 20 of income.

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
const nextWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const TRANSACTIONS = [
  txn('77777777-7777-4777-8777-000000000001', ids.A_CARD, ids.C_GROCERIES, -100, dayThisMonth(1), { merchant: 'Grocer' }),
  txn('77777777-7777-4777-8777-000000000002', ids.A_CARD, ids.C_GROCERIES, 20, dayThisMonth(1), { merchant: 'Grocer', kind: 'refund' }),
  txn('77777777-7777-4777-8777-000000000003', ids.A_CARD, ids.C_GROCERIES, -500, iso(lastMonth), { merchant: 'Old shop' }),
  txn('77777777-7777-4777-8777-000000000004', ids.A_CARD, ids.C_GROCERIES, -900, iso(nextWeek), { merchant: 'Planned' }),
];

async function openMoney(page, tab) {
  await stubSupabase(page, { tables: { transactions: TRANSACTIONS } });
  await page.goto('/money', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.om-main .ov-skel')).toHaveCount(0, { timeout: 15_000 });
  if (tab) await page.locator('.mn-tabs').getByRole('button', { name: tab }).click();
}

test('Activity and its calendar agree under Me, net of the refund', async ({ page }) => {
  await openMoney(page);
  await pickInShell(page, 'Household scope', 'Me');

  const summary = page.locator('.mn-summary');
  await expect(summary).toContainText('1 scheduled not counted');
  // Activity shows this month; the search narrows it to the pair.
  await page.getByPlaceholder('Search merchant, note or amount').fill('Grocer');
  await expect(page.getByRole('region', { name: '2 transactions' })).toBeVisible();
  await expect(summary).toContainText('Spent 40');
  await expect(summary).toContainText('Income 0');
  await page.getByRole('button', { name: 'About these totals' }).click();
  await expect(page.getByRole('note')).toContainText('Spent is purchases 50 less refunds 10.');

  await page.getByRole('button', { name: 'Calendar' }).click();
  const first = page.locator('.cal-cell').filter({ has: page.locator('.cal-daynum', { hasText: /^1$/ }) });
  await expect(first.locator('.cal-spend')).toHaveText('−40');
  await expect(first.locator('.cal-income')).toHaveCount(0);
});

// Insights' top merchants are Activity's Merchants view (the revamp, phase
// 4b): the month the stepper shows, net of refunds.
test("Activity's Merchants follows the month the stepper shows", async ({ page }) => {
  await openMoney(page);
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Merchants' }).click();
  const card = page.getByRole('region', { name: /^Merchants · / });
  await expect(card.locator('.ds-bl-row').filter({ hasText: 'Grocer' })).toContainText('80');
  await expect(card.locator('.ds-bl-row').filter({ hasText: 'Old shop' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Previous month' }).click();
  await expect(card.locator('.ds-bl-row').filter({ hasText: 'Old shop' })).toContainText('500');
  await expect(card.locator('.ds-bl-row').filter({ hasText: 'Grocer' })).toHaveCount(0);
});

test('Money says its amounts are AED when another display currency is picked', async ({ page }) => {
  await openMoney(page);
  await pickInShell(page, 'Display currency', 'USD');
  await expect(page.getByRole('note')).toContainText('Amounts here are in AED, as recorded');
});
