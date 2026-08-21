---
name: fleet-schemas
description: Holds the canonical JSON schemas and output rules for the fix fleet.
---

# Fleet schemas

Use ONLY when a fleet agent (`analyzer`, `planner`, `reviewer`) must emit its final JSON artifact. Load this skill for the exact schema — not for code edits.

## Rules

- Output a **single** JSON object matching the schema **exactly** and nothing else (no prose, no backticks fences, no trailing text).
- Field names are **case-sensitive** and must match verbatim.
- Arrays may be empty `[]` but must be present.
- String enums must use the **exact** lowercase/unquoted values shown.

## FixSpec (analyzer output)

```json
{
  "summary": "string",
  "rootCause": "string",
  "suspectFiles": ["string"],
  "affectedSymbols": ["string"],
  "reproduction": "string",
  "testStrategy": "string",
  "risks": ["string"],
  "confidence": "low" | "medium" | "high"
}
```

Fields:

- `summary` — one-line statement of the bug.
- `rootCause` — the single underlying reason the bug occurs.
- `suspectFiles` — absolute or repo-relative file paths most likely to need changes.
- `affectedSymbols` — function/class/constant names touching the failure path.
- `reproduction` — concise how-to-reproduce steps or test case.
- `testStrategy` — what to assert / which test files to add or update.
- `risks` — list of risks introduced by the planned fix.
- `confidence` — enum `low | medium | high`.

## Plan (planner output)

```json
{
  "approach": "string",
  "steps": ["string"],
  "filesToChange": ["string"],
  "testsToAddOrUpdate": ["string"],
  "acceptanceCriteria": ["string"],
  "outOfScope": ["string"]
}
```

Fields:

- `approach` — the chosen fix approach in one or two sentences.
- `steps` — ordered implementation steps.
- `filesToChange` — repo-relative paths to edit.
- `testsToAddOrUpdate` — test files to add or modify.
- `acceptanceCriteria` — list of criteria that must pass for the plan to be considered done.
- `outOfScope` — list of things explicitly not covered.

## Review verdict (reviewer output)

```json
{
  "verdict": "APPROVE" | "REQUEST_CHANGES",
  "blockingIssues": ["string"],
  "nonBlockingNotes": ["string"],
  "rationale": "string"
}
```

Fields:

- `verdict` — enum `APPROVE` or `REQUEST_CHANGES`.
- `blockingIssues` — issues requiring changes before approval.
- `nonBlockingNotes` — optional notes that don't block.
- `rationale` — the reasoning behind the verdict.
