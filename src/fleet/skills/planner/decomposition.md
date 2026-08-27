---
name: decomposition
description: How to split a FixSpec into small verifiable steps the coder can execute without re-exploring
---

# Decomposition

Turn the analyzer's FixSpec into an ordered plan of minimal, independently
checkable steps. The coder implements your plan literally, so precision now
saves a whole retry loop later.

## Step shape

Each step must have:

- FILES: exact paths it touches (no globs, no "and related files").
- CHANGE: what the new state is, not a vague direction ("add guard clause X
  returning Y when Z" — not "handle Z better").
- VERIFY: how to check it — usually a specific vitest file or
  `npm run typecheck`.

If you cannot state VERIFY, the step is too big or too vague: split it or
sharpen it.

## Sizing

- One step = one logical change in one place. A refactor plus a behavior fix
  is two steps, refactor first.
- Tests come WITH the step they verify, not in a trailing "add tests" step.
- Prefer editing existing modules over creating new ones; this repo keeps
  plain TypeScript ESM in src/* with explicit .ts import extensions — say so
  explicitly when a step adds a new module so imports match convention.

## Ordering rules

- Dependencies first: types/utilities before consumers, migration/schema before
  code that relies on it.
- Each step should leave the tree in a state where `npm run typecheck` plausibly
  passes; if a step necessarily breaks compile mid-sequence, merge it into its
  dependent step.
- Never schedule git push, merges, PR creation, or anything outside the
  worktree. The coder commits locally; that is the end of its authority.

## Anti-patterns

- "Update all call sites" as one step — enumerate the call sites instead.
- Steps that require discovering information the analyzer did not provide.
  If information is missing, flag it back rather than guessing.
- Gold-plating: no extra abstractions, config knobs, or comments beyond what
  the fix needs.
