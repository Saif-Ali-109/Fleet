---
name: test-selection
description: How to pick the right tests to run and interpret their results honestly
---

# Test selection

Running everything is sometimes right; usually it is waste. Choose deliberately.

## Selection order

1. Targeted first: tests covering the changed module(s)
   (`npx vitest run src/__tests__/<module>.test.ts`). Fast signal on your edit.
2. Full suite before finishing: `npm test`. This repo treats the full suite as
   the gate — a green targeted run alone is NEVER sufficient.
3. Typecheck alongside: `npm run typecheck`. Zero errors is part of the gate.

## Interpreting results

- New failure + your change touched that path → yours: fix within plan scope.
- New failure + untouched path → investigate briefly; if genuinely unrelated
  (flaky, environment, pre-existing), report it precisely — do not fix,
  do not hide it.
- Flaky suspicion: rerun once to confirm before classifying. Two different
  outcomes on identical input = flaky, report as such.

## Honesty rules

- Never report success from a partial or aborted run. If the suite timed out
  or crashed, say so.
- Never weaken, skip, or delete a failing test to go green — that is the
  reviewer's call after seeing your report, never yours.
- Report numbers exactly: "353 passed, 0 failed" beats "tests pass".
- If the repo has no test command configured for the change surface, say that
  instead of inventing one.

## Budget

Two full runs maximum (one mid-fix if needed, one final). If you need a third,
something is wrong with the change or the plan — report instead of looping.
