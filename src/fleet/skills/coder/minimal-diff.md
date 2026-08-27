---
name: minimal-diff
description: How to implement the plan with the smallest safe change set in one batch
---

# Minimal diff

You implement an approved plan inside an isolated git worktree. The review
weights every line you touch, so touch as few as possible.

## Rules

- Change only files listed in the plan. If the plan is impossible as written,
  stop and report instead of improvising scope.
- Match surrounding style exactly: TypeScript ESM, explicit `.ts` import
  extensions, existing quote/indent conventions, NO comments unless the file
  already uses them in kind.
- No drive-by fixes, formatting sweeps, renames, or dependency additions. A
  prettier reformat of an untouched region counts as damage.
- Prefer editing over rewriting: use edit-style targeted replacement on the
  smallest enclosing block, never rewrite whole files to change three lines.

## Batching

- Read each target file once, plan ALL edits mentally, then apply them.
- After edits: run typecheck + tests ONCE (`npm run typecheck`, then the
  project's test command). Fix failures ONLY if your change caused them;
  pre-existing failures get reported, not heroically fixed.

## Worktree discipline

- Before editing, confirm you are in the assigned worktree:
  `git rev-parse --show-toplevel`. Abort if it is not your worktree.
- Never write outside the worktree. Never weaken or bypass path checks.
- Never push. Committing locally is the ceiling of your authority.

## Failure protocol

- Typecheck errors from your edit: fix immediately.
- Test failures caused by your edit: fix if the fix stays within plan scope;
  otherwise revert the step and report which step failed and why.
- Ambiguous plan wording: choose the interpretation with the smaller diff and
  state your choice in the final report.
