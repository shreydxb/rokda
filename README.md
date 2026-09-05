# Rokda

A private household finance app — net worth, cash flow, budgets, investments, and planning in one place. Built with Vite + React + Supabase.

Implements the "Our Money — Command Center v3" design (Direction A · Private Ledger), in `design/`. Independent from any prior project; started from scratch.

## Stack

- Vite + React
- Supabase (Postgres, Auth, RLS)
- react-router-dom
- Vitest + Testing Library

## Development

```bash
npm install
npm run dev
```

## Checks

```bash
npm run lint     # application source only; design/ is generated and excluded
npm test         # vitest, including the QA regression suite
npm run build
```

CI (`.github/workflows/ci.yml`) runs a locked install, lint, tests and build for
every push to `main`/`dev`/`claude/**` and every pull request.

`design/` holds the exported Claude Design runtime. It is generated output: it is
excluded from lint and must never be hand-edited to satisfy a rule.

## Build identity

Every build knows its own commit. `vite.config.js` injects `__BUILD_SHA__` from
`VITE_COMMIT_SHA`, Netlify's `COMMIT_REF`, CI's `GITHUB_SHA`, or local `git rev-parse HEAD`,
and the sidebar footer renders it (`build abc1234`, with the full commit and build
time in its tooltip). A QA handoff names a preview URL; the preview names the commit
it was actually built from.

## QA and release

Claude implements, ChatGPT verifies. The process lives in the Linear project "Rokda"
(team Shreyash):

- **QA and release contract** — the handoff and verdict templates.
- **QA review — 2026-09-05 — 9bd6a59** — the findings this correction pass addresses.
- **QA regression reproductions — 9bd6a59** — the synthetic checks, now ported into
  `src/**/*.test.js`.

Status flow: Todo/Backlog → In Progress → In Review (`Rokda: Ready for QA`) → QA
verified (`Rokda: QA passed`) → Done (`Rokda: Released`). Claude never sets
`Rokda: QA passed` itself, and a green CI run is not QA approval.

See `docs/environments.md` for the database and preview environments a handoff
must name.

## Planning

Tracked in Linear, project "Rokda" (team Shreyash).
