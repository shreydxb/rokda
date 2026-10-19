import { execSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { contentSecurityPolicy } from './scripts/csp.mjs'

// The deployed build has to be able to name its own commit — a QA handoff that
// says "preview URL X" is worthless if the preview can't prove what it is.
// Cloudflare Pages sets CF_PAGES_COMMIT_SHA; CI sets GITHUB_SHA; locally we
// ask git.
function commitSha() {
  const fromEnv = process.env.VITE_COMMIT_SHA || process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA
  if (fromEnv) return fromEnv
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

// Every production build carries its Content-Security-Policy as the first
// thing in <head>, so it is in force before the page loads anything (see
// scripts/csp.mjs for why it is a meta tag). Build only: the dev server runs
// inline scripts for hot reload, which the policy exists to forbid.
function contentSecurityPolicyMeta() {
  let content = ''
  return {
    name: 'rokda-content-security-policy',
    apply: 'build',
    configResolved(config) {
      const env = loadEnv(config.mode, config.envDir || process.cwd(), 'VITE_')
      content = contentSecurityPolicy(env.VITE_SUPABASE_URL)
    },
    transformIndexHtml() {
      return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content }, injectTo: 'head-prepend' }]
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), contentSecurityPolicyMeta()],
  // Every host serves this app from the domain root. GitHub Pages served it
  // from /rokda/ until it was retired (docs/decisions.md, "One locked address").
  base: '/',
  define: {
    __BUILD_SHA__: JSON.stringify(commitSha()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    rolldownOptions: {
      output: {
        // Without this the dependencies land in whichever shared chunk the
        // bundler happens to build first and the file is named after some
        // arbitrary module inside it -- a 222 kB chunk called
        // "LoadFailure-<hash>.js", after a small error component that is
        // nowhere near that size. The bytes were right and the label was
        // actively misleading: the next person measuring what the app ships
        // reads that name and draws the wrong conclusion. Naming the group
        // makes the build say what it is.
        advancedChunks: {
          groups: [{ name: 'vendor', test: /[\\/]node_modules[\\/]/ }],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // supabase/functions/_shared/applib is plain ESM the Edge Functions import
    // directly, so its pure logic is unit-testable here alongside the app's.
    // Before this, nothing in supabase/functions had a test at all -- which is
    // how the fast-confirm targeting bug (QA #2) stayed invisible.
    include: [
      'src/**/*.test.{js,jsx}',
      'scripts/**/*.test.mjs',
      'supabase/functions/**/*.test.js',
    ],
    setupFiles: ['./src/test/setup.js'],
  },
})
