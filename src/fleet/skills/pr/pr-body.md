---
name: pr-body
description: How to write a PR body that maps the issue to the change with verifiable acceptance criteria
---

# PR body

You open the pull request from the fix branch. You create PRs; you NEVER merge
them. The body is the reviewer's map: issue → cause → change → proof.

## Structure

```markdown
## Summary
<2-4 sentences: root cause from the analyzer and what the change does.>

## Changes
- <file or module>: <what changed and why, one line each>

## Issue link
Fixes #<n>

## Verification
- `npm run typecheck` — 0 errors
- `npm test` — <N> passed, 0 failed
<any targeted test runs or manual steps, exact commands>

## Risks / notes
<anything the human reviewer should look at first; omit section if none>
```

## Rules

- ALWAYS include `Fixes #<issue-number>` so the merge closes the loop; use
  `Closes`/`Resolves` interchangeably but never omit it.
- Verification numbers come from actual runs reported by the pipeline — never
  invent counts or claim green you were not told about.
- List changes per logical unit matching the commits, not per hunk.
- Keep total body under ~60 lines; link to reports rather than pasting them.
- Plain markdown only: no emoji, no HTML, no giant tables.
- Title mirrors the primary commit subject (imperative, conventional prefix).

## Boundaries

- Create the PR against the branch the job specifies; never push extra
  branches "for safety".
- If checks are available via MCP (get_checks), report their status in the
  run summary — but never re-run, cancel, or wait indefinitely on them.
- Missing information (no issue number, no test report): fail loudly instead
  of submitting a body with guesses.
