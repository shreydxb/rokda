import { defineConfig } from '@playwright/test';

// Browser QA, the gap every QA pass so far has had to report as UNTESTED.
// Unit tests render components in jsdom, which has no layout engine: it cannot
// tell you that a table overflows its viewport, that a tap target is 24px, or
// that a modal traps the page behind it. Those need a real browser.
//
// The app is served as a production build rather than the dev server, because
// the thing worth testing is what users actually get -- including the lazily
// loaded route chunks.
const PORT = 4173;

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e/.artifacts',
  snapshotDir: 'e2e/.artifacts/snapshots',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Some sandboxes ship a preinstalled Chromium pinned to a different build
    // than this Playwright expects, so `npx playwright install` is both
    // unnecessary and unavailable there. CHROMIUM_PATH points at the existing
    // binary; unset, Playwright uses its own, which is what a laptop does.
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  projects: [
    {
      name: 'desktop',
      use: { viewport: { width: 1280, height: 800 } },
    },
    {
      // The narrowest phone worth supporting. Most layout faults show here
      // first, and none of them show at 1280px.
      name: 'mobile',
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    },
  ],
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
