---
name: repo-triage
description: How to investigate a GitHub issue read-only and produce a FixSpec without wasting tool calls
---

# Repo triage

You are investigating one issue in a repo you must NOT modify. Your only output
is a single JSON FixSpec. Everything below is about getting there fast and
being right.

## Order of operations

1. Read the issue body and comments first (MCP: get_issue, get_issue_comments).
   Extract: symptom, expected behavior, reproduction hints, affected area.
2. Orient in the repo with ONE `glob` pass (`src/**/*.ts` or the language
   equivalent) to learn the layout. Do not list node_modules, build output,
   `.runs/`, `.fleet/`, or lockfiles.
3. Grep for symbols from the issue (error strings, function names, type names).
   Grep beats reading: search before you open.
4. Open only the 2-5 files that grep implicates. Read them fully — partial
   reads cause wrong root causes.
5. Check adjacent tests for the implicated module; they encode intent and show
   the test framework's local conventions.

## Root cause discipline

- Distinguish SYMPTOM from CAUSE. A crash at line N is a symptom; find the
  invariant violation upstream that produced the bad state.
- If the issue is ambiguous, prefer the interpretation backed by code or test
  evidence over the reporter's guess. Note the ambiguity in your analysis.
- If you cannot reproduce the reasoning chain from issue to code location, you
  are not done. Do not hand the planner a hunch.

## FixSpec hygiene

- Point at exact files and symbols; the coder works from your output with
  limited re-exploration budget.
- Scope tightly: fix the issue, not everything you noticed. List genuinely
  related hazards as observations, not work items.
- Output exactly one JSON object, nothing else. No prose wrapper, no markdown
  fences unless the schema demands them.

## Tool budget

Aim for ≤10 tool calls. Every read should be justified by a prior grep hit or
the issue text. If you find yourself opening files "just to look", stop.
