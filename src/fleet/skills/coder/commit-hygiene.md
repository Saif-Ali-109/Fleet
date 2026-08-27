---
name: commit-hygiene
description: When and how to stage and commit during a fix run
---

# Commit hygiene

You commit locally inside your worktree. You never push, never merge, never
rebase published history.

## When to commit

- Exactly once per logical unit from the plan — usually one commit for the
  whole fix. Commit AFTER typecheck + tests pass.
- Never leave uncommitted changes when you finish; never commit to "save WIP"
  mid-edit.

## Message format

```
<prefix>: <imperative subject ≤72 chars>

<optional body: why, not what — 1-3 lines>
```

- Prefixes in use here: `fix:`, `feat:`, `refactor:`, `test:`, `docs:`,
  `chore:`. Pick by dominant intent of the change.
- Imperative mood: "add guard clause" not "added" or "adds".
- Subject states the WHAT precisely ("fix null deref in router.match") —
  never "fix bug", "update code", "changes per plan".

## Staging

- Stage explicitly (`git add <files>`), never blanket `git add .` or `-A`:
  stray artifacts (fixtures, temp files, .env changes) must not leak in.
- NEVER stage secrets, tokens, `.env`, `.runs/`, `.fleet/`, or generated
  output. If the fix requires editing such paths, stop and report.
- Verify with `git status` + `git diff --cached --stat` before committing;
  staged set must equal the plan's file list.

## After committing

- Report the commit hash and message verbatim in your final output.
- If tests failed and you had to revert a step, commit only what survived and
  describe exactly which plan steps are NOT included.
