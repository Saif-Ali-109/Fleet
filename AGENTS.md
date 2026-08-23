# AGENTS.md — Multi-Orchestration

Constitution for ANY AI agent working in this repo, in ANY session, on ANY plan.
Read fully before your first edit. Re-read "Boundaries" before risky operations.
No YAML frontmatter on this file by rule — every other `*.md` must have one.

## What this repo is

TypeScript Manager that takes a GitHub issue → a real PR using 6 role agents
(analyzer, planner, coder, tester, reviewer, pr). Workers run as child processes;
the Manager itself never calls models. PostgreSQL-backed tamper-evident SOR audit
chain. Hand-rolled node:http web dashboard + ANSI TUI. Node ≥22, tsx, vitest.

> System is mid-migration: CLI fleet (opencode/claude/codex) → custom OpenAI-SDK
> workers (gemini → openrouter → ollama), gates removed. Truth for that work:
> `SPEC.md` (+ progress in its §17 checklist; `PLAN.md` is the index). Rules below
> hold in BOTH eras unless explicitly marked.

## Session protocol (every session)

1. Read `PLAN.md` → if touching fleet/engine/migration code, read `SPEC.md`.
2. Doing migration work? First unchecked item in `SPEC.md §17` is your task.
   Tick it + commit (`docs: check <item>`) when its acceptance criteria pass.
3. Follow the subagent strategy in `USER.md` (sequential vs parallel by file overlap).
4. Every task ends green: `npm run typecheck && npm test`.
5. Commit per logical unit — short imperative subject + explanatory body.

## Commands

- `npm start -- --repo <url> --issue <n>` — one issue → PR
- `npm run dry` — keyless stubbed run (no tokens spent); ALWAYS smoke this first
- `npm test` / `npm run typecheck`
- `npm run migrate:up` / `migrate:down` — Postgres schema (DATABASE_URL required)
- `npm run sor:verify` — replay SOR hash chain; must stay green at all times
- `analytics`, `generate-memory` — reporting utilities
- Scheduled for removal after SPEC.md P8 (do not rely on): `build:config`,
  `check:config`, `sor:sync-registry`

## Code style

- Plain TypeScript ESM in `src/*`; imports keep explicit `.ts` extensions.
- Model/API calls ONLY inside worker child processes — never in
  `orchestrator.ts`, dashboard, router, or any manager-side module.
- Providers/models are resolved through the provider/model policy layers — never
  hardcode baseURLs or infer one provider's model id from another's.
- No comments unless asked; mirror surrounding conventions.

## Security

- Secrets live ONLY in `.env`; never commit keys/tokens.
- All SOR writes are NON-FATAL: warn and continue, never abort a run over them.
- coder/tester workers never `git push`; pr creates PRs but never merges.
- Workers operate ONLY inside their assigned git worktree — tool-layer path
  checks enforce this; do not weaken them.

## Boundaries

### Always
- Typecheck + tests green before every commit.
- Update `.env.example` when adding env vars.
- YAML frontmatter on every new/edited `*.md` EXCEPT this file.

### Ask first
- New agent roles or new providers beyond gemini/openrouter/ollama.
- Changes to SOR event shapes or hash-chain logic (`sor:verify` contract).
- Schema migrations; new runtime dependencies.
- Gate/auto-flow design changes — EXCEPT the SPEC.md D11 migration
  (gate removal + auto-fix), which is pre-authorized.

### Never
- Add model calls to manager code (`orchestrator.ts` et al).
- Hand-edit generated or historical artifacts (`.fleet/**` while it exists;
  anything under `.runs/`).
- Weaken tool gating (per-role toolsets) or bash worktree cwd-locking.
- Reorder/delete SOR chain logic; assume `--dry-run` spawns real workers.
