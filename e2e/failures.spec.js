import { test, expect } from '@playwright/test';
import { stubSupabase } from './fixtures.js';

// A read or a save that fails must say so (QA, 15 October): never an empty
// list, a zero, or a "saved" in its place. The stub answers the named tables
// with a PostgREST error; everything else loads as usual.

// The browser logs the failed request itself as a console error. That one is
// expected; anything else is not.
function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|sourcemap|\.map\b|Failed to load resource/i.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return errors;
}

async function open(page, path) {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.om-main')).toBeVisible();
  await expect(page.locator('.om-main .ov-skel')).toHaveCount(0, { timeout: 15_000 });
}

const READS = [
  { name: 'transactions on Overview', path: '/', table: 'transactions', message: 'Couldn’t load transactions.' },
  { name: 'card statements on Wealth', path: '/wealth', table: 'statement_reconciliations', message: 'Couldn’t load card statements.', tab: 'Statements' },
  { name: 'goals on Planning', path: '/planning', table: 'goals', message: 'Couldn’t load goals.' },
  { name: 'household notes on Planning', path: '/planning', table: 'household_notes', message: 'Couldn’t load household notes.', tab: 'Notes' },
];

for (const read of READS) {
  test(`a failed read of ${read.name} is named, with a way to try again`, async ({ page }) => {
    const errors = watchErrors(page);
    await stubSupabase(page, { failReads: [read.table] });
    await open(page, read.path);
    if (read.tab) await page.getByRole('button', { name: read.tab, exact: true }).first().click();

    const alert = page.getByRole('alert').filter({ hasText: read.message });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible();
    // Named in words, never by the code's own key for it.
    await expect(page.locator('.om-main')).not.toContainText(/Couldn’t load [a-z]+[A-Z]/);
    expect(errors).toEqual([]);
  });
}

test('marking a statement done when the save fails says so, and leaves it unchecked', async ({ page }) => {
  const errors = watchErrors(page);
  await stubSupabase(page, { failWrites: ['statement_reconciliations'] });
  await open(page, '/wealth');
  await page.getByRole('button', { name: 'Statements', exact: true }).click();

  const row = page.getByTestId('statement-row').first();
  await expect(row).toContainText('Not checked');
  await row.getByRole('button', { name: 'Mark done' }).click();

  await expect(page.getByRole('alert')).toContainText('canceling statement due to statement timeout');
  await expect(row).toContainText('Not checked');
  expect(errors).toEqual([]);
});

test('saving a transaction when the save fails keeps the editor open and says why', async ({ page }) => {
  const errors = watchErrors(page);
  await stubSupabase(page, { failWrites: ['transactions'] });
  await open(page, '/money');

  await page.locator('.om-tx-row').first().click();
  const editor = page.getByRole('dialog', { name: 'Edit transaction' });
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: 'Save changes' }).click();

  await expect(editor.getByRole('alert')).toContainText('canceling statement due to statement timeout');
  await expect(editor).toBeVisible();
  expect(errors).toEqual([]);
});

test('Planning withholds what rests on goals and debts that never loaded', async ({ page }) => {
  const errors = watchErrors(page);
  await stubSupabase(page, { failReads: ['goals', 'debts'] });
  await open(page, '/planning');
  const main = page.locator('.om-main');
  // An unread list used to read as an empty one: "All clear", no goals, no
  // debts, and a stop year worked out without them.
  await expect(main).toContainText('Not all checked');
  await expect(main).not.toContainText('All clear');
  await expect(main).not.toContainText('No goals yet');
  await expect(main).not.toContainText('No debts on record');

  await page.goto('/planning?tab=goals', { waitUntil: 'domcontentloaded' });
  await expect(main).toContainText('Couldn’t load goals.');
  await expect(main).not.toContainText('Add a goal to start');
  expect(errors).toEqual([]);
});
