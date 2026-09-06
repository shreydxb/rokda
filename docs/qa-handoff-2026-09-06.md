# QA disposition — 6 September 2026

ChatGPT/Codex reviewed correction head `3f69482` and directly completed the
small follow-ups on the same branch. Claude should pull the branch before
continuing; do not overwrite these changes or restart the completed fixes.

Changes made here:

- CI now uses `npm run compare:migrations`, including its strict flag. The old
  direct script command bypassed strict mode and accepted unverifiable entries.
- Environment docs explicitly state that a preview is not yet verified and that
  both preview and enabled dev branch contexts require isolated database values.
- Overview labels its category breakdown as gross spending before refunds.
  The net spending totals continue to include refunds; no accounting logic changed.

## Completed code QA

170 tests across 24 files, lint, build verification and strict migration
comparison passed independently on `3f69482`. The applied fingerprint snapshot
matches the read-only live-derived evidence from the preceding review. The
strict check reports 13 matches, zero drift/unverifiable entries and five
pending migrations. A deliberately stale snapshot fails in strict mode.

The following tickets can be Done for their bounded code fixes, without implying
that the changes are released: SHR-228, SHR-244, SHR-247, SHR-248, SHR-249,
SHR-250, SHR-251 and SHR-253. Their calculation, render/error-state, or comparison
acceptance criteria have executable evidence. The Released label remains separate.

## Keep open for isolated integration QA

| Ticket | Remaining check |
| --- | --- |
| SHR-242 | Account archive/delete behavior and preserved history with real database constraints |
| SHR-243 | Confirmed/unknown balances saved and reloaded through the new database column |
| SHR-245 | Confirmed valuation date/history and old/new-client migration behavior |
| SHR-246 | Real holding-save failures/retries and two-session month closing |
| SHR-252 | Atomic Inbox approval, concurrent reviewers and persisted refund semantics |
| SHR-254 | Verified preview SHA, isolated database, both users and migration rollout |

Code/component checks for these fixes pass. Keeping them open reflects missing
integration evidence, not a request to implement the same fixes again.

## Next environment step

Keep PR #1 draft against dev. Establish an isolated Supabase test database with
synthetic two-member fixtures, apply the 18 repository migrations there, and
configure a preview with that database. Confirm dev is eligible as a preview
base branch and verify the preview's displayed commit. Test both members,
create/edit/reload, retry/concurrency and old/new-client rollout. Apply all five
pending production migrations before deploying the new production client only
after the separate release decision. No production changes are authorized by
this handoff.

No further Claude implementation pass is needed for the completed review queue.
Claude may continue future feature work after reading this handoff and the
updated Linear tickets; Telegram/OpenRouter remain separate feature scope.
