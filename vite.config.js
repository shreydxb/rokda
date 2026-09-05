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
  define: {
    __BUILD_SHA__: JSON.stringify(commitSha()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  // Vitest transforms test files with esbuild; tell it to use the automatic
  // JSX runtime so component tests don't need a React import.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{js,jsx}'],
    setupFiles: ['./src/test/setup.js'],
  },
})
