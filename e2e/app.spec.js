import { test, expect } from '@playwright/test';
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
  { name: 'goals', path: '/planning', tabs: ['Goals'], expectText: 'a month to reach it by' },
  { name: 'budget-year', path: '/money', tabs: ['Budget', 'Year'], expectText: 'Net saved each month' },
];

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
    await stubSupabase(page, { tables: { transactions: closedMonthsOfHistory() } });
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

test('theme toggle switches and the page stays readable', async ({ page }) => {
  await stubSupabase(page);
  await gotoReady(page, '/');
  const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
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
