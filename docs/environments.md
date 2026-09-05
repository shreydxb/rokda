# Environments

Every QA handoff names the exact commit, preview URL, and database it was
verified against. This file records what those names refer to.

## Application

| Role | Where | Notes |
| --- | --- | --- |
| Production | https://rokda-app.netlify.app | Netlify, deploys from the default branch |
| Preview | Netlify deploy preview per branch/PR | Same build; the sidebar footer shows the commit |

The running build identifies itself in the sidebar footer (`build <short sha>`,
full commit and build time in the tooltip). Netlify supplies `COMMIT_REF`, which
`vite.config.js` reads; no extra configuration is required for the SHA to appear.

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

`supabase/migrations/` is the repository's history. Applied versions on
`erggbzbbutsvhleqcddq` are recorded in `docs/migration-reconciliation.md`,
along with the drift between the two and the reconciliation plan.
