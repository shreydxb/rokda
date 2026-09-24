import { execSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The deployed build has to be able to name its own commit — a QA handoff that
// says "preview URL X" is worthless if the preview can't prove what it is.
// Netlify sets COMMIT_REF; CI sets GITHUB_SHA; locally we ask git.
function commitSha() {
  const fromEnv = process.env.VITE_COMMIT_SHA || process.env.COMMIT_REF || process.env.GITHUB_SHA
  if (fromEnv) return fromEnv
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Netlify serves this app from its domain root, so base stays '/' there.
  // GitHub Pages (the credit-free fallback when Netlify runs out of build
  // minutes) serves a project site from /<repo>/ instead -- the Pages
  // workflow sets GH_PAGES=true so only that build picks up the prefix.
  base: process.env.GH_PAGES ? '/rokda/' : '/',
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
