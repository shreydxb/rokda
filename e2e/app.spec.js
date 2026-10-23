import { test, expect } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { data, stubSupabase } from './fixtures.js';

const ROUTES = [
  { path: '/', name: 'overview' },
  { path: '/money', name: 'money' },
  { path: '/wealth', name: 'wealth' },
  { path: '/planning', name: 'planning' },
  { path: '/settings', name: 'settings' },
];

// Errors the app cannot be blamed for: the stub answers everything, but a
// production build still pings for source maps and favicons.
const IGNORABLE = /favicon|sourcemap|\.map\b/i;

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !IGNORABLE.test(m.text())) errors.push(`console: ${m.text()}`); });
  return errors;
}

async function gotoReady(page, path) {
  // Deliberately NOT waitUntil:'networkidle'. supabase-js keeps an auth
  // refresh timer alive for the life of the page, so the network never goes
  // idle for 500ms and every navigation times out. Wait for the thing that
  // actually matters instead: the shell, then the route's own content.
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.om-main')).toBeVisible();

  // Assert readiness rather than best-effort waiting for it. The first version
  // swallowed the timeout and let the test assert on whatever was on screen,
  // so a route that was merely slow reported as "rendered a blank screen" --
  // a fake finding, and the worst kind, because it accuses the app of a bug
  // the harness invented. expect.poll retries and then fails saying what it
  // actually saw.
  await expect
    .poll(async () => (await page.locator('.om-main').innerText()).trim().length, {
      timeout: 15_000,
      message: `${path} never rendered content`,
    })
    .toBeGreaterThan(20);
  await expect(page.locator('.om-main .ov-skel')).toHaveCount(0);
}

// Anything wider than the viewport means a sideways scrollbar on a phone,
// which is the single most common real-world layout fault and completely
// invisible to jsdom.
async function horizontalOverflow(page) {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    const offenders = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > limit + 1) {
        const style = getComputedStyle(el);
        // An element allowed to scroll itself is not an overflow fault.
        const scrollable = ['auto', 'scroll'].includes(style.overflowX);
        const insideScroller = el.closest('[style*="overflow"], .om-scroll, table');
        if (!scrollable && !insideScroller) {
          offenders.push(`${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''} right=${Math.round(r.right)} limit=${limit}`);
        }
      }
    }
    return { documentOverflow: document.documentElement.scrollWidth > limit + 1, offenders: offenders.slice(0, 8) };
  });
}

for (const route of ROUTES) {
  test(`${route.name}: renders, no errors, no horizontal overflow`, async ({ page }, testInfo) => {
    const errors = watchErrors(page);
    await stubSupabase(page);
    await gotoReady(page, route.path);

    // It actually rendered something, not an empty shell.
    const text = (await page.locator('.om-main').innerText()).trim();
    expect(text.length, 'main region rendered no text').toBeGreaterThan(20);

    const { documentOverflow, offenders } = await horizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`${route.name}-${testInfo.project.name}.png`), fullPage: true });

    expect(text, `${route.path} leaked a raw value into the UI`).not.toMatch(/NaN|undefined|\[object Object\]/);
    expect(errors, `console/page errors on ${route.path}`).toEqual([]);
    expect(documentOverflow, `page scrolls sideways; offenders: ${offenders.join(' | ')}`).toBe(false);
  });
}

// One test per route rather than one loop over all five: a loop shares a
// single timeout budget across five navigations and fails as a timeout that
// says nothing about which screen is broken.
for (const route of ROUTES) {
  test(`${route.name}: empty household still says something`, async ({ page }, testInfo) => {
    const errors = watchErrors(page);
    await stubSupabase(page, { empty: true });
    await gotoReady(page, route.path);

    const text = (await page.locator('.om-main').innerText()).trim();
    await page.screenshot({ path: testInfo.outputPath(`${route.name}-empty-${testInfo.project.name}.png`), fullPage: true });

    // A brand-new household is a real state. A blank panel here is the bug
    // that only ever ships because nobody looked at it with no data.
    expect(text.length, `${route.path} rendered a blank screen with no data`).toBeGreaterThan(20);
    expect(text, `${route.path} leaked a raw value with no data`).not.toMatch(/NaN|undefined|\[object Object\]/);
    expect(errors, `console/page errors on ${route.path} with an empty household`).toEqual([]);
  });
}

// Views behind a tab, which the per-route loop above never opens: the
// Forecast headline row overflowed a phone for as long as it existed, unseen,
// because Planning lands on Plan. The fixture gets income and spend for four
// closed months so Forecast projects rather than showing its empty state.
const SUBVIEWS = [
  { name: 'forecast', path: '/planning', tabs: ['Forecast'], expectText: 'What it would take' },
  { name: 'goals', path: '/planning', tabs: ['Goals'], expectText: 'counts only the cash set aside for it' },
  { name: 'budget-year', path: '/money', tabs: ['Budget', 'Year'], expectText: 'Net saved each month' },
  { name: 'drawdown', path: '/planning', tabs: ['Drawdown', 'Fall in year 1'], expectText: 'The same fall, early or late' },
  // The fixture's own data: two closed months and a budget, so Drawdown
  // projects from the budget and must say so.
  { name: 'drawdown-from-budget', path: '/planning', tabs: ['Drawdown'], expectText: 'Your budget, for now', history: false },
  { name: 'life-plan', path: '/planning', tabs: ['Life plan'], expectText: 'The pot, year by year' },
  { name: 'life-plan-setup', path: '/planning', tabs: ['Life plan'], expectText: 'Set up your life plan', tables: { member_life: [] } },
  // A statement that does not match, opened for resolving: the reason box and
  // its buttons must fit a phone.
  { name: 'statements', path: '/wealth', tabs: ['Statements', 'Resolve…'], expectText: 'Mark resolved', history: false, tables: { statement_reconciliations: cardStatements } },
  { name: 'backups', path: '/settings', tabs: ['Backups'], expectText: 'Restore drill' },
  { name: 'starter-categories', path: '/settings', tabs: ['Categories & rules', 'Starter set'], expectText: 'Starter categories' },
  {
    name: 'notes',
    path: '/planning',
    tabs: ['Notes'],
    expectText: 'Shared costs by income',
    tables: {
      household_notes: [
        {
          id: 'a3a3a3a3-0000-4000-8000-000000000001',
          household_id: 'hh',
          title: 'Who pays what',
          body: '# Split\nShared costs by income.\n\n- **Rent**, utilities and groceries are shared\n- Each person keeps their own car, phone and family remittances, and a very long line that has to wrap on a phone without pushing the page sideways',
          position: 1,
          updated_by: null,
          updated_at: '2026-09-28T10:00:00Z',
        },
      ],
    },
  },
];

// The Platinum card's two latest statements (it closes on the 10th): the
// latest checked and not matching, by a cent, the one before marked done.
function cardStatements() {
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const back = new Date(now.getFullYear(), now.getMonth(), 10) >= today ? 1 : 0;
  const close = (n) => new Date(now.getFullYear(), now.getMonth() - back - n, 10);
  const start = (n) => new Date(now.getFullYear(), now.getMonth() - back - n - 1, 11);
  const card = data.accounts.find((a) => a.type === 'credit_card').id;
  const row = (n, over) => ({
    household_id: 'hh', account_id: card, statement_date: iso(close(n)), period_start: iso(start(n)), due_date: null,
    statement_balance: null, statement_spend: null, rokda_spend: null, note: null, closed_by_member_id: null, closed_at: null,
    asked_message_ids: [], last_asked_on: null, created_at: `${iso(close(n))}T09:00:00Z`, updated_at: `${iso(close(n))}T09:00:00Z`, ...over,
  });
  return [
    row(0, { id: 'a4a4a4a4-0000-4000-8000-000000000001', status: 'mismatch', statement_spend: 100.02, statement_balance: 3200.75, closed_at: `${iso(today)}T08:00:00Z`, note: 'Checked against the PDF' }),
    row(1, { id: 'a4a4a4a4-0000-4000-8000-000000000002', status: 'confirmed', closed_at: `${iso(close(1))}T12:00:00Z` }),
  ];
}

function closedMonthsOfHistory() {
  const now = new Date();
  const day = (back, d) => {
    const x = new Date(now.getFullYear(), now.getMonth() - back, d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  };
  const [salary, , groceries] = data.transactions;
  const rows = [];
  for (let back = 1; back <= 4; back++) {
    rows.push({ ...salary, id: `77777777-9999-4000-8000-00000000010${back}`, occurred_at: day(back, 1), created_at: `${day(back, 1)}T09:00:00+00:00` });
    rows.push({ ...groceries, id: `77777777-9999-4000-8000-00000000020${back}`, occurred_at: day(back, 9), created_at: `${day(back, 9)}T09:00:00+00:00` });
  }
  return [...data.transactions, ...rows];
}

for (const view of SUBVIEWS) {
  test(`${view.name}: renders, no errors, no horizontal overflow`, async ({ page }, testInfo) => {
    const errors = watchErrors(page);
    const tables = Object.fromEntries(Object.entries(view.tables ?? {}).map(([k, v]) => [k, typeof v === 'function' ? v() : v]));
    await stubSupabase(page, { tables: { ...(view.history === false ? {} : { transactions: closedMonthsOfHistory() }), ...tables } });
    await gotoReady(page, view.path);
    for (const tab of view.tabs) await page.getByRole('button', { name: tab, exact: true }).first().click();
    await expect(page.locator('.om-main')).toContainText(view.expectText);

    const text = (await page.locator('.om-main').innerText()).trim();
    const { documentOverflow, offenders } = await horizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`${view.name}-${testInfo.project.name}.png`), fullPage: true });

    expect(text, `${view.name} leaked a raw value into the UI`).not.toMatch(/NaN|undefined|\[object Object\]|Infinity/);
    expect(errors, `console/page errors on ${view.name}`).toEqual([]);
    expect(documentOverflow, `page scrolls sideways; offenders: ${offenders.join(' | ')}`).toBe(false);
  });
}

test('keyboard: tab reaches the nav and focus is visible', async ({ page }) => {
  await stubSupabase(page);
  await gotoReady(page, '/');

  const seen = [];
  let reachedNav = false;
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        inNav: !!el.closest('.om-nav-list'),
        // Something must mark focus: an outline, a ring, or a border change.
        marked: (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none',
        visible: r.width > 0 && r.height > 0,
      };
    });
    if (!info) continue;
    seen.push(info);
    if (info.inNav) reachedNav = true;
  }

  expect(seen.length, 'nothing was focusable by keyboard').toBeGreaterThan(3);
  expect(reachedNav, 'tabbing never reached the main navigation').toBe(true);
  const unmarked = seen.filter((s) => s.visible && !s.marked).length;
  expect(unmarked, `${unmarked} of ${seen.length} focused elements showed no visible focus indicator`).toBe(0);
});

// On a phone the household, currency and account controls once took a third
// of the first screen, and Overview's decisions sat under the chart, about
// 1,000px down. Now they fold behind one button and the decisions come first.
test('phone: the header folds and the decisions start on the first screen', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'phone layout only');
  await stubSupabase(page);
  await gotoReady(page, '/');

  const header = await page.locator('.om-side').boundingBox();
  expect(header.height, 'the phone header is taller than a bar and the nav').toBeLessThan(140);
  const scope = page.getByRole('group', { name: 'Household scope' });
  await expect(scope).toBeHidden();

  const attention = await page.locator('.ov-attn-col').boundingBox();
  expect(attention.y, 'Needs attention starts below the first screen').toBeLessThan(page.viewportSize().height);

  const toggle = page.locator('.om-sidetoggle');
  await expect(toggle).toHaveText(/Both · AED/);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(scope).toBeVisible();
  await scope.getByRole('button', { name: 'Me' }).click();
  await expect(toggle).toHaveText(/Me · AED/);
});

// A finger needs about 44px (Planning audit, 0b-F). Every control on these
// screens is that tall on a phone, or is a text link with an invisible 44px
// margin around it (its ::after).
test('phone: every control is big enough for a finger', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'phone layout only');
  await stubSupabase(page);
  for (const path of ['/planning', '/planning?tab=life', '/planning?tab=debt', '/money?tab=inbox']) {
    await gotoReady(page, path);
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('.om-main button, .om-main a')]
        .filter((el) => {
          const box = el.getBoundingClientRect();
          if (!box.width || !box.height) return false;
          const reach = getComputedStyle(el, '::after');
          const height = reach.content === 'none' ? box.height : Math.max(box.height, parseFloat(reach.height) || 0);
          return height < 43.5;
        })
        .map((el) => `${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)} (${Math.round(el.getBoundingClientRect().height)}px)`),
    );
    expect(small, `controls under 44px on ${path}`).toEqual([]);
  }
});

// An editor drawer is a modal in fact: it takes focus, Tab stays inside it,
// and closing it gives focus back to what opened it (lib/useDrawerFocus.js).
test('a drawer holds keyboard focus and gives it back', async ({ page }) => {
  await stubSupabase(page);
  await gotoReady(page, '/planning?tab=debt');
  const opener = page.getByRole('button', { name: '+ Debt', exact: true });
  await opener.focus();
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'Add debt' });
  await expect(drawer).toBeFocused();
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press(i % 7 === 6 ? 'Shift+Tab' : 'Tab');
    expect(await drawer.evaluate((d) => d.contains(document.activeElement)), `Tab ${i + 1} left the drawer`).toBe(true);
  }
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(drawer).toBeHidden();
  await expect(opener).toBeFocused();
});

test('theme toggle switches and the page stays readable', async ({ page }) => {
  await stubSupabase(page);
  await gotoReady(page, '/');
  const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  // On a phone the theme toggle is folded behind the household button.
  const folded = page.locator('.om-sidetoggle');
  if (await folded.isVisible()) await folded.click();
  const toggle = page.locator('button', { hasText: /dark|light|theme/i }).first();
  if (await toggle.count()) {
    await toggle.click();
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(after, 'theme toggle did not change the background').not.toBe(before);
    const text = await page.evaluate(() => getComputedStyle(document.body).color);
    expect(text, 'body text colour unset after theme switch').toBeTruthy();
  }
});

// The Content-Security-Policy (scripts/csp.mjs) ships in the build this suite
// serves, so every test above fails if the policy blocks something the app
// needs on the screens it opens: the browser reports each blocked load as a
// console error. That covers only what the fixtures make the app load, which
// is why the receipt-photo test below exists. This one proves the policy is
// enforced at all, rather than present and inert.
test('the Content-Security-Policy is in force: an injected script does not run', async ({ page }) => {
  await stubSupabase(page);
  const violations = [];
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) violations.push(m.text()); });
  await gotoReady(page, '/');

  const ran = await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.__injected = true';
    document.head.appendChild(script);
    return window.__injected === true;
  });
  expect(ran, 'an inline script injected into the page ran').toBe(false);
  expect(violations.length, 'the blocked script was not reported as a policy violation').toBeGreaterThan(0);

  // The app's own requests are not blocked: it reached the stubbed Supabase
  // origin the build was made against, and rendered.
  await expect(page.locator('.om-main')).toBeVisible();
});

// A receipt photo in the Inbox is an <img> from a signed Storage URL on the
// Supabase origin, not the app's. The policy above once blocked it while every
// test passed, because no fixture had a photo; this one does.
test('the Inbox shows a receipt photo under the Content-Security-Policy', async ({ page }) => {
  const errors = watchErrors(page);
  const [entry] = data.intake;
  await stubSupabase(page, { tables: { intake: [{ ...entry, photo_path: 'receipts/receipt.png' }] } });
  // A 1x1 PNG, served for the signed URL the Inbox asks for.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await page.route('**/storage/v1/object/sign/telegram-receipts/**', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ json: { signedURL: '/object/sign/telegram-receipts/receipts/receipt.png?token=t' } })
      : route.fulfill({ status: 200, contentType: 'image/png', body: png }));

  await gotoReady(page, '/money');
  await page.getByRole('button', { name: /^Inbox/ }).click();
  const photo = page.getByRole('img', { name: 'Receipt' });
  await expect(photo).toBeVisible();
  await expect.poll(() => photo.evaluate((img) => img.complete && img.naturalWidth), { message: 'the receipt image never loaded' }).toBe(1);
  expect(errors, 'console/page errors in the Inbox').toEqual([]);
});
