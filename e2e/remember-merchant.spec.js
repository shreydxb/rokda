import { test, expect } from '@playwright/test';
import { stubSupabase, ids, data } from './fixtures.js';

// "Remember this merchant" while correcting a record's category: the record is
// saved first, then the household rule, and only the rule is ever retried.
// Writes are answered by the stub and recorded here; nothing is persisted
// except the rules this file keeps, so Settings can show the one added.

const NEW_RULE = 'b2b2b2b2-0000-4000-8000-0000000000aa';
const scope = (page, name) => page.getByRole('group', { name: 'Household scope' }).getByRole('button', { name, exact: true });

async function open(page, path, { failRuleInserts = 0 } = {}) {
  const writes = [];
  const added = [];
  let failuresLeft = failRuleInserts;
  await stubSupabase(page, {
    onRest: (request) => {
      if (request.method() === 'GET') return;
      const table = new URL(request.url()).pathname.split('/rest/v1/')[1].split('?')[0];
      writes.push(`${request.method()} ${table}`);
    },
  });
  // Rules added here are kept, and an added rule comes back with its id. This
  // route is answered before the stub's, so it records its own calls.
  await page.route('**/rest/v1/category_rules*', async (route) => {
    const request = route.request();
    writes.push(`${request.method()} category_rules`);
    if (request.method() === 'POST') {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return route.fulfill({ status: 503, json: { code: '503', message: 'upstream unavailable', details: null, hint: null } });
      }
      const body = request.postDataJSON();
      added.push({ id: NEW_RULE, archived: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...body });
      return route.fulfill({ status: 201, json: { id: NEW_RULE } });
    }
    if (request.method() === 'GET') {
      const rows = [...data.category_rules, ...added];
      return route.fulfill({ json: rows, headers: { 'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` } });
    }
    return route.fallback();
  });
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.om-main .ov-skel')).toHaveCount(0, { timeout: 15_000 });
  return { writes, added };
}

const categorySelect = (editor) => editor.locator('select').filter({ has: editor.page().locator('option', { hasText: 'Uncategorised' }) });

test('a corrected merchant is remembered after the record saves, and Activity keeps its place', async ({ page }) => {
  const { writes, added } = await open(page, '/money?tab=activity&q=Carrefour&sort=largest');
  await scope(page, 'Me').click();
  await page.locator('.om-tx-row').first().click();
  const editor = page.getByRole('dialog', { name: 'Edit transaction' });
  const remember = editor.getByRole('checkbox', { name: /Remember this merchant/ });
  await expect(remember).toHaveCount(0);

  await categorySelect(editor).selectOption({ label: 'Dining out' });
  await expect(remember).not.toBeChecked();
  await remember.check();
  const panel = editor.getByRole('group', { name: 'Merchant rule' });
  await expect(panel.getByLabel('Merchant pattern')).toHaveValue('Carrefour');
  await expect(panel.getByRole('button', { name: 'Contains' })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel).toContainText('Future entries whose merchant contains “Carrefour” go to Dining out, whatever the letter case');
  await expect(panel).toContainText('household’s');

  writes.length = 0;
  await editor.getByRole('button', { name: 'Save and add rule' }).click();
  await expect(editor).toHaveCount(0);
  const notice = page.getByRole('status').filter({ hasText: 'remembered' });
  await expect(notice).toContainText('future entries whose merchant contains “Carrefour” go to Dining out');
  expect(writes.slice(0, 4)).toEqual(['PATCH transactions', 'POST transaction_edits', 'GET category_rules', 'POST category_rules']);
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ household_id: ids.HH, pattern: 'Carrefour', match_type: 'contains', category_id: ids.C_DINING });

  // Same filters, same person.
  await expect(page).toHaveURL(/tab=activity&q=Carrefour&sort=largest$/);
  await expect(page.getByLabel('Search')).toHaveValue('Carrefour');
  await expect(scope(page, 'Me')).toHaveAttribute('data-active', 'true');

  await notice.getByRole('link', { name: 'See the rule in Settings' }).click();
  await expect(page).toHaveURL(/\/settings\?tab=categories&rule=/);
  const ruleEditor = page.getByRole('dialog', { name: 'Edit rule' });
  await expect(ruleEditor.locator('.te-title')).toHaveText('"Carrefour"');
  await ruleEditor.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.mn-row').filter({ hasText: 'Contains "Carrefour" → Dining out' })).toHaveCount(1);
  await page.goBack();
  await expect(page).toHaveURL(/tab=activity&q=Carrefour&sort=largest$/);
});

test('a rule that fails is retried alone, without saving the record again', async ({ page }) => {
  const { writes, added } = await open(page, '/money?tab=activity&q=Carrefour', { failRuleInserts: 1 });
  await page.locator('.om-tx-row').first().click();
  const editor = page.getByRole('dialog', { name: 'Edit transaction' });
  await categorySelect(editor).selectOption({ label: 'Dining out' });
  await editor.getByRole('checkbox', { name: /Remember this merchant/ }).check();
  writes.length = 0;
  await editor.getByRole('button', { name: 'Save and add rule' }).click();
  await expect(editor.getByRole('alert')).toContainText('Transaction saved; merchant rule wasn’t saved.');
  await expect(editor.getByRole('alert')).toContainText('upstream unavailable');
  await editor.getByRole('button', { name: 'Try the rule again' }).click();
  await expect(editor).toHaveCount(0);
  expect(writes.filter((w) => w === 'PATCH transactions')).toHaveLength(1);
  expect(writes.filter((w) => w === 'POST transaction_edits')).toHaveLength(1);
  expect(added).toHaveLength(1);
});

test('a rule that files the merchant elsewhere is explained and linked, and the correction saves without a new rule', async ({ page, browser, baseURL }) => {
  const { writes, added } = await open(page, '/money?tab=activity&q=Spinneys&kind=expense');
  await page.locator('.om-tx-row').first().click();
  const editor = page.getByRole('dialog', { name: 'Edit transaction' });
  await categorySelect(editor).selectOption({ label: 'Dining out' });
  await editor.getByRole('checkbox', { name: /Remember this merchant/ }).check();
  const panel = editor.getByRole('group', { name: 'Merchant rule' });
  await expect(panel).toContainText('Contains “spinneys” already files “Spinneys” under Groceries');
  // It opens in a new tab, so the record stays open as typed. That tab is
  // opened here at the link's address in a browser of its own: the stub signs
  // each page in afresh, and a second sign-in in the same browser would hand
  // this tab a new token.
  const link = panel.getByRole('link', { name: 'Open that rule in Settings' });
  await expect(link).toHaveAttribute('target', '_blank');
  const href = await link.getAttribute('href');
  expect(href).toBe(`/settings?tab=categories&rule=${data.category_rules[0].id}`);
  const other = await browser.newContext();
  const settings = await other.newPage();
  await stubSupabase(settings);
  await settings.goto(new URL(href, baseURL).href, { waitUntil: 'domcontentloaded' });
  await expect(settings.getByRole('dialog', { name: 'Edit rule' }).locator('.te-title')).toHaveText('"spinneys"');
  await other.close();

  // The correction is still as it was typed.
  await expect(categorySelect(editor)).toHaveValue(ids.C_DINING);
  writes.length = 0;
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Saved without a merchant rule' })).toBeVisible();
  expect(writes).toContain('PATCH transactions');
  expect(writes).not.toContain('POST category_rules');
  expect(added).toHaveLength(0);
});

test('a refund is not offered a merchant rule', async ({ page }) => {
  await open(page, '/money?tab=activity&q=Spinneys&kind=refund');
  await page.locator('.om-tx-row').first().click();
  const editor = page.getByRole('dialog', { name: 'Edit transaction' });
  await categorySelect(editor).selectOption({ label: 'Dining out' });
  await expect(editor.getByRole('checkbox', { name: /Remember this merchant/ })).toHaveCount(0);
});
