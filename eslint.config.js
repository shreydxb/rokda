import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // `design/` holds the exported Claude Design runtime. It is generated output,
  // not application source: it is linted by nobody and must never be hand-edited
  // to satisfy a rule. Application lint covers src/ and the root config files.
  globalIgnores(['dist', 'design/**', 'coverage/**']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: { ...globals.browser, __BUILD_SHA__: 'readonly', __BUILD_TIME__: 'readonly' },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    // Config and test files run in Node, not the browser.
    files: ['*.config.js', 'src/test/**/*.js', 'src/**/*.test.{js,jsx}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // Context providers legitimately co-export a `use*` hook alongside the
    // component; that's the standard React context pattern, not a fast-refresh hazard.
    files: ['src/lib/*Context.jsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
