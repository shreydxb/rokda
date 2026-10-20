import { test, expect } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { stubSupabase, ids } from './fixtures.js';

// Importing a statement from a CSV file (SHR-302): the file is read in the
// browser, its columns checked, every line reviewed, and the kept lines sent
// together in one call. Synthetic statement only.
const STATEMENT = ['Bank statement export', 'Date,Details,Money out,Money in', '05/09/2026,Grocer,120.50,', '09/09/2026,Transfer to savings,2000.00,', '25/09/2026,SALARY,,10000.00', '31/09/2026,Broken line,5.00,'].join('\n');

test('a statement is reviewed line by line and imported in one call', async ({ page }) => {
  const sent = [];
  await stubSupabase(page);
  await page.route('**/rest/v1/rpc/commit_import', async (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ json: { batch_id: 'b1', imported: 3, already: 0 } });
  });
  await page.goto('/money?tab=import', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Export a statement from your bank')).toBeVisible({ timeout: 15_000 });

  await page.getByLabel('Account', { exact: true }).selectOption({ label: 'Current account' });
  await page.getByLabel('Statement file').setInputFiles({ name: 'september.csv', mimeType: 'text/csv', buffer: Buffer.from(STATEMENT) });
  await expect(page.getByText('How the columns are read')).toBeVisible();
  await page.getByRole('button', { name: 'Read the lines' }).click();

  await expect(page.getByText('"31/09/2026" isn\'t a date written day first (31/01/2026).')).toBeVisible();
  const importButton = page.getByRole('button', { name: 'Import 3 records' });
  await expect(importButton).toBeDisabled();
  await page.getByLabel('Line 4 other account').selectOption({ label: 'To Savings' });
  await importButton.click();

  await expect(page.getByRole('status')).toHaveText('Imported 3 records into Current account.');
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ p_account_id: ids.A_CURRENT, p_file_name: 'september.csv', p_row_count: 4 });
  expect(sent[0].p_rows.map((r) => `${r.kind} ${r.amount}`)).toEqual(['expense -120.5', 'transfer -2000', 'income 10000']);
  expect(sent[0].p_rows[1].other_account_id).toBe(ids.A_SAVINGS);
});
