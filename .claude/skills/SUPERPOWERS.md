# Superpowers

The skills in this folder other than `design-taste-frontend` are copied from
https://github.com/obra/superpowers (MIT, see `SUPERPOWERS-LICENSE`), commit
`bb92a77741419a4ab5f06e711a283343f1ada0c3` (v7.0.0, the commit the official
plugin marketplace pins), unchanged:

brainstorming, diagnosing-superpowers, dispatching-parallel-agents,
executing-plans, finishing-a-development-branch, receiving-code-review,
requesting-code-review, subagent-driven-development, systematic-debugging,
test-driven-development, using-git-worktrees, using-superpowers,
verification-before-completion, writing-plans, writing-skills.

They are copied rather than enabled as a plugin because cloud sessions do not
install plugins enabled in `.claude/settings.json`. As project skills they are
named without the `superpowers:` prefix the skills use for each other, and the
plugin's SessionStart hook, which loads `using-superpowers` into every session,
is not copied: the skills load when their descriptions match.

To update: clone upstream at the new commit, read the diff, and replace these
folders with its `skills/*`, keeping this file and the licence.
