---
title: Contributing — Global Rules
status: active
date: 2026-08-22
audience: ain + AI agents 
---

# CONTRIBUTING.md

Global contribution rules and constraints. `AGENTS.md` governs agent behavior;
this file governs HOW changes get made, for humans and agents alike.

## 1. Environment setup

1. Node ≥22 (`node -v`), then `npm install`.
2. Postgres 16 reachable; set `DATABASE_URL`; run `npm run migrate:up`.
3. Copy `.env.example` → `.env`. Minimum keys:
   - `SOR_SIGNING_KEY` = `openssl rand -hex 32`
   - `GEMINI_API_KEY` (primary/test provider)
   - optional: `OPENROUTER_API_KEY`, `OLLAMA_BASE_URL`
4. GitHub CLI authenticated (`gh auth status`) — needed for issue/PR features.

## 2. Golden workflow (every change)

1. `npm run dry` FIRST — validate wiring with zero tokens spent.
2. Smallest possible change; one concern per commit.
3. Before every commit: `npm run typecheck && npm test` green.
4. Live runs only after dry passes; keep the dashboard Stop button in reach.

## 3. Commit style

- Subject: short imperative, ≤72 chars, lowercase-ish ("typecheck repair + worker timeout").
- Body: what + why; reference hashes/issues when relevant.
- SPEC.md §17 checklist ticks are their own commits: `docs: check <item>`.
- Never mix a refactor with a behavior change.

## 4. Docs conventions

- YAML frontmatter on EVERY `*.md` EXCEPT `AGENTS.md`.
- `PLAN.md` = index · `SPEC.md` = execution truth · progress lives ONLY in
  `SPEC.md §17` · owner preferences live ONLY in `USER.md`.

## 5. Testing bar

- Unit tests for every new module (providers, tools, loop, parsers).
- Provider APIs are MOCKED in vitest — never hit real APIs from tests.
- SOR event changes require fixture-based parity tests (`sor:verify` green).

## 6. Ask-before / never lists

Identical to `AGENTS.md → Boundaries`. They bind contributors too.
