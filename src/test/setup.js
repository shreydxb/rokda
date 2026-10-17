// Vitest global setup. Build-time constants are defined by vite.config.js for
// the app build; tests get the same globals so components can render.
globalThis.__BUILD_SHA__ = globalThis.__BUILD_SHA__ ?? 'test'
globalThis.__BUILD_TIME__ = globalThis.__BUILD_TIME__ ?? '1970-01-01T00:00:00.000Z'

// The selected person is remembered in localStorage (lib/ScopeContext.jsx);
// each test starts from Both, as a new browser does.
import { beforeEach } from 'vitest'
beforeEach(() => {
  try {
    globalThis.localStorage?.clear()
  } catch {
    // A node-environment test has no storage to clear.
  }
})
