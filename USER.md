---
title: Owner Rules for Builder Agents
status: active
date: 2026-08-22
owner: ain
audience: any AI agent working in this repo
---

# USER.md — how ain wants agents to work

Owner preferences and working rules. Read alongside `AGENTS.md`; where they
overlap, the stricter rule wins. Decisions recorded in `SPEC.md §3` are FINAL —
never re-litigate them.

## Subagent strategy (IMPORTANT)

Use subagents for each task:

- **Sequential** (one after another) when tasks depend on each other's output,
  or touch the same files, or share an import chain.
- **Parallel** ONLY when file change sets are fully disjoint — no shared files,
  no simultaneous edits to importing/imported modules. Safe example: one
  subagent writes `src/fleet/tools/*` while another authors skill playbooks in
  `src/fleet/skills/**`.
- When in doubt: sequential. Never let two writers touch one file.

## Communication

- Terse, direct answers; diffs and commands over prose.
- Batch clarifying questions; don't drip them one at a time.
- Report token/cost impact before live (non-dry) runs.

## Product preferences

- Gemini API key is the primary/test provider; ollama keeps things working
  offline; openrouter is the fallback pool (`SPEC.md §4`).
- Strong models for thinking roles, cheap models for builder roles.
- Fully automatic flow — no human approval gates anywhere in the pipeline.
- The SOR audit chain is non-negotiable: `sor:verify` stays green always.

## Hard "no"s

- Never push to main; never merge PRs.
- Never spend real API tokens without saying so first (`npm run dry` exists).
- Never add a dependency beyond what `SPEC.md §12` lists without asking.
