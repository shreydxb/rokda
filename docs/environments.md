# Environments

Every QA handoff names the exact commit, preview URL, and database it was
verified against. This file records what those names refer to.

## Application

| Role | Where | Notes |
| --- | --- | --- |
| Production | https://rokda-app.netlify.app | Netlify, deploys from the default branch |
| Preview | Not provisioned/verified yet | PR #1 targets dev; confirm base-branch deploy eligibility and preview configuration |

The correction build identifies itself in the sidebar footer (`build <short sha>`,
full commit and build time in the tooltip). Netlify supplies `COMMIT_REF`, which
`vite.config.js` reads; no extra configuration is required for the SHA to appear.

Before enabling preview or dev branch builds, configure their Supabase variables
to use an isolated synthetic-data database. Configure both `deploy-preview` and
any enabled `branch-deploy`/dev context; neither should inherit household data
settings. An absent GitHub check alone does not establish why a preview is missing.

### Build environment variables

`VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (see `.env.example`) are
required to *build*, not only to run. Vite inlines them, so without them the
top-level throw in `src/lib/supabaseClient.js` folds to a constant, the bundler
eliminates every statement after it, and `npm run build` reports success while
emitting a vendor-only chunk that renders nothing. `npm run verify:build`
asserts the application actually survived into the bundle; CI runs it after
every build with placeholder values.

## Database

| Role | Supabase project | Ref |
| --- | --- | --- |
| Live household data | `rokda` | `erggbzbbutsvhleqcddq` |
| Older, superseded | `our-rokda` | `wrxqgfbolryveivgdjia` |
| Paused, superseded | `our-money` | `azvoxekvcdngnmasossy` (INACTIVE) |

The live project has **no Supabase development branches**. A Git branch is not a
separate database: work on `claude/**` still points at whatever
`VITE_SUPABASE_URL` is configured for the build.

### Isolated environment for mutation tests — decision required

Write, retry, and concurrency tests (account archival, Inbox approval
idempotency, month-close idempotency) must not run against live household
records. None of the existing projects is a safe target: `rokda` is live, and
the other two hold real historical data.

Options, for the owner to choose — creating any of these is a deployment/billing
decision and is deliberately **not** made by this correction pass:

1. **A Supabase development branch on `rokda`.** Closest to production, branches
   are a paid feature, and merging a branch back changes the live schema.
2. **A separate free-tier Supabase project `rokda-test`.** Isolated by
   construction; schema is rebuilt from `supabase/migrations/`, seeded with
   synthetic fixtures only. Recommended.
3. **A local stack (`supabase start`).** Free and fully isolated; does not prove
   anything about hosted configuration (RLS is the same, platform settings are not).

Until one exists, mutation behaviour in this repo is covered by unit and
component tests over pure functions and mocked Supabase clients, and every
handoff says so under "Known limitations".

## Migrations

`supabase/migrations/` is the repository's history, and its filenames now carry
the same version identifiers as the applied migrations on
`erggbzbbutsvhleqcddq`. `docs/migration-reconciliation.md` records how that was
established and what the comparison found.

```bash
npm run compare:migrations   # repository vs docs/applied-migrations.json
npm run verify:migrations    # build a throwaway database from the migrations
```

`verify:migrations` needs a PostgreSQL to talk to (libpq environment: PGHOST,
PGPORT, PGUSER). It creates and drops its own database and never touches an
existing one. CI runs both against a PostgreSQL 17 service container.

## Edge Functions — environment secrets

Three values the functions read at runtime are set on the platform, per
project, and are in no dump, no repository and not in the vault either. They
were missing from the recovery runbook entirely until QA #1 — the functions
deploy and run fine without them, and every outbound call fails.

| secret | without it |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | the bot cannot send a single message |
| `OPENROUTER_API_KEY` | every parse and every question falls back to "check the Inbox" |
| `TWELVEDATA_API_KEY` | the nightly price refresh fetches nothing and holdings quietly stop moving |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform and
must not be set by hand.

Nothing in CI can check these: reading them back is not something the
Management API offers, and a check that could read them would be a check that
could leak them. They are verified by use — see the rehearsal checklist in
`docs/backup-restore.md` §5, which is the only thing that actually exercises
all three.

## Edge Functions — deployment parity

The 10 September QA re-run found `telegram-webhook` running an 8 September
build while `main` had moved on: the deployed bundle was missing the
`alerts_enabled` filter on budget alerts and carried a copy of the shared
recurring helper that ignored `interval_count`. It had been that way for five
days with CI green throughout, because CI compared the repository against
itself and never against production.

`npm run verify:functions` closes that. It answers one question — *are the
Edge Functions running in production the ones in this commit?* — in both
directions:

| state | meaning | blocks? |
| --- | --- | --- |
| `in-sync` | deployed source matches this commit | no |
| `stale-deployment` | deployed, but the source differs | **yes** |
| `orphan-deployment` | deployed with no source in this repository | **yes** |
| `not-deployed` | in this repository, never deployed | no |
| `unreadable` | deployed, but its source could not be downloaded | **yes** |

Both directions are needed. Source → deployment is the drift above.
Deployment → source is the other half: when this was written
`telegram-setup-check` and `deploy-test-scratch` were both live in production
and present in no commit anywhere, so a check that only asked "is `main`
deployed?" would have passed while those ran.

### No snapshot, on purpose

There is deliberately no committed record of deployed state. A snapshot is the
failure this check exists to catch: `docs/applied-migrations.json` silently
covered 32 of 38 migrations and made six live migrations read as "awaiting
deployment" while the summary said `0 drifting`. Deployed state is one API
call, so it is always fetched fresh and there is nothing to go stale.

For the same reason, *not checked* never reads as *passed*. Without
credentials the script exits non-zero rather than skipping, and CI separates
the two cases: on `main` a missing token fails the job; on other refs it
emits a warning that says parity was not established. A fork's pull request
cannot have the token, and that must not look like a clean bill.

### What it compares

A function is its entrypoint plus the transitive closure of its **relative**
imports — `jsr:`, `npm:` and `https:` specifiers are resolved by the Deno
runtime and are not files this repository controls. Paths are canonicalised
relative to the entrypoint's own directory, because the two sides genuinely
differ in layout: the repository keeps the entrypoint at `<slug>/index.ts`
while the platform reports CLI-deployed functions at `<slug>/source/index.ts`
with `_shared` nested beside it. Keyed from the functions root, every path
would differ and an identical deployment would read as drift.

### Running it

```
SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=erggbzbbutsvhleqcddq npm run verify:functions
```

CI reads both from repository secrets of the same names. The comparison
itself (`scripts/compare-functions.mjs`) is pure and unit-tested; the fetching
lives in `scripts/verify-function-parity.sh`, the same split as
`compare-migrations.mjs` and `verify-migrations.sh`.

## Release gating

Two things decide whether a commit can reach users: whether publishing waits
for verification, and whether anything can reach `main` without being verified
at all. The first is solved in the workflows; the second is a repository
setting, and settings that live only in a web UI are exactly the kind of thing
that drifts silently. `docs/main-ruleset.json` is that setting written down.

### Publishing waits for CI

`.github/workflows/pages.yml` triggers on `workflow_run` of CI, not on `push`.
Both used to fire on a push to `main` and ran in parallel, so they raced: on the
merge of #7, Pages finished at 15:46:54 and CI at 15:47:03 -- the site published
nine seconds before the tests meant to gate it. Harmless only because CI passed.

Two details carry the guarantee, and both are easy to lose in a refactor:

- The checkout is pinned to `github.event.workflow_run.head_sha`. A
  `workflow_run` workflow does NOT check out the commit that was verified; it
  defaults to the tip of the default branch, which by then may be a later,
  unverified commit.
- `VITE_COMMIT_SHA` uses that same `head_sha`. It is embedded in the bundle and
  is how a QA pass identifies which build a host is serving, so `github.sha`
  there would stamp the artifact with a commit it was not built from.

`workflow_dispatch` remains and deliberately does not consult CI -- it is the
"Netlify is out of minutes, publish now" escape hatch Pages exists for. The run
summary records which of the two paths published.

Verified on the merge of #8: CI finished at 16:26:03 and the Pages run started
at 16:26:05, with `event: workflow_run`.

### `main` accepts only verified merges

Recorded in `docs/main-ruleset.json`: a repository ruleset targeting the default
branch that restricts deletions, blocks force pushes, requires a pull request,
and requires all three CI jobs.

Three choices in it are deliberate rather than defaults:

- **Zero required approvals.** A pull request is required, but no approval is.
  The sole owner cannot approve their own pull request, so any higher number
  would make the branch unmergeable rather than more reviewed.
- **No bypass actors.** It applies to repository admins too. An exception for
  the only admin is the same as no rule, and "prevent an accidental direct push
  to `main`" is most of the point.
- **Strict / up to date.** A branch must carry current `main` before it merges,
  so a green result cannot be one that never saw what it is merging into.

Apply it with credentials that carry repository administration rights:

```
gh api --method POST repos/shreydxb/rokda/rulesets --input docs/main-ruleset.json
```

or Settings -> Rules -> Rulesets -> New branch ruleset, which takes the same
fields. Confirm afterwards with `gh api repos/shreydxb/rokda/rulesets`; an empty
array means nothing is enforced, whatever this file says.

The three required contexts must match the CI job names exactly
(`install / lint / test / build`, `fresh database from supabase/migrations`,
`deployed Edge Functions match this commit`). A context named here but never
reported blocks every merge; a job renamed in `ci.yml` without being renamed
here stops gating silently, which is the worse of the two failures.

Netlify's checks are deliberately not required: they conclude `neutral`, which
is not success, and requiring them would block merges.

## Leaked password protection: not available, not forgotten

The security advisor flags `auth_leaked_password_protection` on every run. It
stays flagged, deliberately.

Supabase's own documentation is explicit: *"Leaked password protection is
available on the Pro Plan and above."* The `our-money` organisation is on the
free plan, so the setting is not switched off — it does not exist to switch.
Looking for it in the dashboard and failing to find it is the expected outcome,
and worth writing down so the next person does not go hunting again.

What it would buy is rejection of passwords known to appear in breach corpora,
via HaveIBeenPwned. This project has exactly one login. A password manager
produces the same outcome for that one account at no cost, which is why the
plan is not being upgraded for this alone.

What IS available on the free plan, on the same settings page
(Authentication → Sign In / Providers → Email), and worth setting:

- a minimum password length above the 8-character default;
- required character classes — digits, lower and uppercase, symbols.

Revisit if the household ever grows past people who can be told to use a
password manager, or if the project moves to Pro for another reason.
