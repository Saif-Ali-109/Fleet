---
name: checklist
description: The pass/fail checklist a diff must survive before it may be approved
---

# Review checklist

Work through every section. Verdict is APPROVE only if every gate passes;
otherwise REQUEST_CHANGES with the failing items quoted verbatim.

## Scope

- [ ] Diff implements the plan and NOTHING else: no drive-by refactors,
      formatting sweeps, renames, or new dependencies.
- [ ] Every file in the diff appears in the plan's file list.
- [ ] No comments added unless mirroring surrounding conventions; no dead
      code, debug prints, or commented-out blocks.

## Correctness

- [ ] Change actually addresses the root cause from the analysis, not just
      the symptom.
- [ ] Error paths handled; no silent catches that swallow failures.
- [ ] TypeScript ESM conventions intact: explicit `.ts` import extensions,
      no hardcoded provider URLs or model ids where policy layers exist.
- [ ] No weakening of security boundaries: tool gating, worktree path checks,
      SOR hash-chain logic untouched unless the plan explicitly says so.

## Tests

- [ ] New behavior has tests; fixed bug has a regression test that fails
      without the fix.
- [ ] No existing test was deleted, skipped, or weakened to go green.
- [ ] Reporter verified: `npm run typecheck` 0 errors AND full suite green,
      exact numbers stated.

## Git

- [ ] Commits: imperative subjects, conventional prefixes, one logical change
      each; no secrets staged; no push, no merge.
- [ ] All changes inside the assigned worktree.

## Verdict discipline

Quote the specific line/file for every requested change. "LGTM vibes" is not
a verdict; either enumerate failures or approve. When torn between verdicts,
the tiebreaker is: would you bet the SOR chain staying green on this?
