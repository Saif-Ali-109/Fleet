# Multi-Orchestration

TypeScript Manager (not an LLM) that drives a fleet of 6 headless `opencode`
workers to take a GitHub issue to a real PR, gated by 3 human approvals.

## Stack

Node >=22, TypeScript, `tsx` (no build step for scripts), `vitest`. Dashboard
is a hand-rolled `node:http` server — no framework, no npm UI deps.

## Layout

- `src/orchestrator.ts` — the Manager: routing, the 3 gates, git worktrees.
- `src/agentRunner.ts` — spawns headless `opencode run` workers, parses NDJSON.
- `src/models/modelPolicy.ts` — **authoritative** model tiers + fallback pool.
  Overrides `opencode.json`'s declared `model` at spawn time via `-m`.
- `agents/<role>.md` — **the single canonical source for every fleet role**
  across every tool. Frontmatter = role config; markdown body = the prompt
  verbatim. `agents/_global.md` holds non-per-agent keys.
- `scripts/generate-configs.ts` — runs every adapter in `scripts/adapters/`
  against `agents/*.md` and writes each tool's native format:
  - `scripts/adapters/opencode.ts` → `opencode.json` (inline `agent` block —
    stays inline, not `.opencode/agent/*.md`, because it must be discoverable
    via `OPENCODE_CONFIG` from inside a foreign worktree; see comment in file)
  - `scripts/adapters/claude-code.ts` → `.claude/agents/<role>.md`
  - `scripts/adapters/codex.ts` → `.codex/agents/<role>.toml`

  To support another CLI agent, add one adapter file implementing the
  `Adapter` type in `scripts/lib/adapter.ts` and register it in
  `scripts/generate-configs.ts` — nothing else changes.

## Rules file (this file)

`AGENTS.md` is the canonical rules file. Codex and OpenCode read it directly;
Claude Code only looks for `CLAUDE.md`, which is a **symlink** to `AGENTS.md`
(same bytes, one file, no drift possible) — never replace it with a real
file, or add content only to `CLAUDE.md`.

## Critical rules

- Never hand-edit `opencode.json`, `.claude/agents/*.md`, or
  `.codex/agents/*.toml`. Edit the matching `agents/<role>.md`, run
  `npm run build:config`, commit both. CI
  (`.github/workflows/check-agent-config.yml`) fails the build if any of them
  drift from `agents/*.md`.
- Per-tool fields (`codex_model`, `codex_reasoning_effort`, `claude_model`) are
  opt-in per role and only appear in that tool's output when set explicitly.
  Never infer a Claude/Codex model id from opencode's `model` field — they're
  different providers' model names and silently mismapping them is wrong, not
  just incomplete.
- `src/*` is plain TypeScript, not an LLM. Don't add model calls to
  `orchestrator.ts` itself — only the 6 spawned `opencode` workers call models.
- coder/tester workers must never `git push` and the pr worker must never
  merge. This is **prompt-enforced, not permission-enforced** — preserve the
  relevant instruction if you edit `agents/coder.md`, `agents/tester.md`, or
  `agents/pr.md`.
- Workers run inside isolated `git worktree`s. Never let a worker touch files
  outside its assigned worktree.
- `gh` auth is required for real PR creation. `--dry-run` skips `gh` and every
  worker entirely (stubs only) — don't assume dry-run exercises real spawns.

## Commands

- `npm start -- --repo <url> --issue <n>` — run one issue to a PR.
- `npm run dry` — dry-run: no tokens, no API calls, stubs every worker.
- `npm run build:config` / `npm run check:config` — regenerate / verify
  `opencode.json` from `agents/*.md`.
- `npm test` — vitest.

### Daemon mode (24/7)

Running `npm start` with no `--repo` starts the dashboard in queue/daemon
mode. The daemon watches the repo(s) started from the dashboard, auto-scans
for open issues every `SCAN_INTERVAL_MINUTES` (default 5), skips issues that
already have a completed run (`run_outcomes.status = 'completed'`) or an open
PR on the fix branch, and keeps going until Stop is clicked in the dashboard
(finishing the current issue before going idle).

The agent used for each fix is set by `ORCHESTRATOR_BACKEND` in `.env`
(opencode | claude | codex; default opencode; CLI `--backend` overrides).
Failures are logged to the dashboard as an error notice and the scan
continues.

### PostgreSQL

`npm test` and `npm start` are DB-backed. Before running them locally, a
PostgreSQL 16 instance must be up, `DATABASE_URL` must be set (via `.env` or
export), and the schema migrated with `npm run migrate:up`. CI provisions the
same postgres service container and runs `npm run migrate:up` before tests.
