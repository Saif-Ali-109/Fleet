# Multi-Orchestration

TypeScript Manager drives a fleet of 6 headless workers to take a GitHub issue to a real PR, with 3 human approval gates. The fleet can run on **opencode**, **Claude Code**, or **Codex** — chosen once per run (`--backend` flag or a dashboard toggle).

## Architecture

The **Manager** is plain TypeScript — not an LLM. It owns routing, the 3 gates, git worktrees, `gh`, memory, logging, SOR, durable execution, workforce hiring, and analytics. Each of the 6 workers is a separate headless CLI process with its own least-privilege config, spawned via `node:child_process.spawn` (no SDK, no shell). The runner is backend-agnostic: `src/runner/backends.ts` maps each backend to its binary, argv, env, and stream parser, and `src/agentRunner.ts` dispatches on the run's `backend`. Agent discovery is wired through `OPENCODE_CONFIG` for opencode; Claude Code and Codex read their agents from `.claude/agents/` and `.codex/agents/` respectively (regenerated from `agents/*.md`).

```
GitHub issue ──▶ TS MANAGER (orchestrator, not an LLM)
                  │  intake via `gh issue view --json`
                  ├─ GATE 1 ─ confirm intent
                  ▼
               Analyzer ─▶ fix-spec.json
               Planner  ─▶ plan.md
                  ├─ GATE 2 ─ approve plan.md
                  ▼
               Coder ⇄ Tester  (loop, ≤ 3 iterations)
               Reviewer ─▶ APPROVE / REQUEST_CHANGES
                  ├─ GATE 3 ─ approve final diff
                  ▼
               PR worker ─▶ git push + gh pr create ─▶ real PR
```

**System of Record (SOR)** — append-only, tamper-evident Postgres audit log. Hash chain:
`hash_i = HMAC(SOR_SIGNING_KEY, prev_hash || canonical_json(event_i))`, genesis = fixed hex constant. Single-writer tail in `sor_chain` singleton (id=1), row-locked `FOR UPDATE` per insert. Event types: `tool_call | wakeup | phase | registry_sync | finalize`. Hooks (opencode/Claude/Codex) append JSONL to `$SOR_EVENT_DIR/events.jsonl`; Manager ingests at trace-parsing time. `agent_registry` mirrors `agents/*.md` (synced at `build:config`).

**Durable Execution** — step-level checkpointing via `agent_steps` table. Coder/Tester phases broken into named steps; on crash, resume skips successful steps (`getLastFailedStep`).

**Dynamic Workforce** — hiring API (`src/workforce/hiring.ts`) with policy (`src/workforce/policy.ts`): auto-hire, gate-hire, deny-hire roles. New roles spawn within policy limits, retire after use.

**Analytics** — cross-run queries (`src/analytics/queries.ts`): cost by role/backend/iteration, success rates, top failing roles. CLI: `npm run analytics -- --from --to`.

Workers are spawned per backend — e.g. `opencode run --agent <role> -m opencode/<model> --dir <worktree> --format json "<task>"`, `claude -p <task> --output-format stream-json --model <m> --append-system-prompt "<role prompt>" --permission-mode plan|acceptEdits`, or `codex exec --cd <worktree> -m <m> -s <sandbox> --json "<role prompt>\n\n<task>"` — and stream JSON events (text + tokens + cost) into `.runs/<id>/traces/*.jsonl`. Free-tier failures (5xx/quota/empty output) fall through an ordered fallback pool.

## The 6 Workers

All 6 agents live in one project-level `opencode.json` (`mode: "all"`, `webfetch` disabled). Read-only roles have `write`/`edit`/`patch` off and `permission.bash/edit` denied; build roles may write and commit; the PR role has bash (`git push`, `gh pr create`) but `grep`/`glob`/`write`/`edit`/`patch` off. See note below on prompt- vs permission-enforced guarantees.

| Role | Model | Permission gist |
|---|---|---|
| **analyzer** | `opencode/deepseek-v4-flash-free` | Read-only repo investigation → FixSpec JSON. No writes. |
| **planner** | `opencode/deepseek-v4-flash-free` | Read-only fix design → Plan JSON. No writes. |
| **coder** | `opencode/laguna-s-2.1-free` | Edits worktree files + `git add`/`git commit`. **No push.** |
| **tester** | `opencode/laguna-s-2.1-free` | Writes/updates tests, runs the suite. **No push.** |
| **reviewer** | `opencode/deepseek-v4-flash-free` | Read-only diff review → APPROVE / REQUEST_CHANGES. No writes. |
| **pr** | `opencode/laguna-s-2.1-free` | `git push -u origin HEAD` + `gh pr create`. **No merge.** |

Reasoning-heavy roles (analyzer/planner/reviewer) use `opencode/deepseek-v4-flash-free` with `variant: "medium"`; build roles (coder/tester/pr) use `opencode/laguna-s-2.1-free` (no variant). Fallback pool (tried in order on 5xx/quota/empty output): `opencode/deepseek-v4-flash-free`, `opencode/north-mini-code-free`, `opencode/mimo-v2.5-free`, `opencode/nemotron-3-ultra-free`.

> **Model split to know:** the model each worker actually runs is resolved by `src/models/modelPolicy.ts` (the Manager passes it via `-m`, which overrides the agent's config). `opencode.json` still declares `model: "opencode/big-pickle"` for the analyzer/planner/reviewer agents, but that value is superseded at spawn time by the policy — `modelPolicy.ts` is authoritative.

> **Prompt-enforced vs permission-enforced:** the coder/tester "no push" and the pr "no merge" guarantees are enforced by the agent **prompts**, not by the CLI permission system. The permission system restricts *tools*; push-vs-no-push behavior relies on the role being told not to do it.

## Prerequisites

- **Node ≥ 22** and **npm ≥ 10** (tested on v22.22.2 / 10.9.7)
- **git ≥ 2.43** (linked worktrees)
- **`gh` CLI** authenticated — `gh auth login`, then verify with `gh auth status` (PR creation requires real credentials). If `gh` is not signed in the app does not fail — it waits and auto-starts once you log in (see Web Dashboard).
- **opencode CLI ≥ v1.18.7** on PATH — verify with `opencode --version` (flags were verified on v1.18.7). Required for the default `--backend opencode`.
- **Claude Code** (`claude`) on PATH — required only for `--backend claude`. Auth via its own login/API key.
- **Codex CLI** on PATH — required only for `--backend codex`. Auth via its own login/API key.
- **PostgreSQL 16** up, `DATABASE_URL` set (`.env` or export), schema migrated (`npm run migrate:up`).
- **`SOR_SIGNING_KEY`** (required; `openssl rand -hex 32`) — HMAC secret for SOR hash chain.
- **No `ANTHROPIC_API_KEY` needed** for opencode — the free OpenCode Zen models (`opencode/*`) are served via the `opencode` CLI's own auth.

## Install

```
npm install
```

## Usage

Run a single issue to a PR:

```
npm start -- --repo <url> --issue <n> [--dry-run] [--interactive=false] [--branch <name>] [--port <n>] [--no-web] [--backend <name>]
```

Run the dashboard-driven **repo queue** (fix every open issue in a repo, one by one) by calling `npm start` with **no arguments** and pasting a repo URL in the dashboard's "Start a repo queue" panel (use the **Backend** toggle to choose opencode / Claude / Codex first).

Run `npm start -- --help` for the full flag summary.

A run proceeds through the 3 gates, each a `[y/N]` prompt:

1. **GATE 1 — confirm intent** — shows the issue before any token is spent.
2. **GATE 2 — approve plan.md** — approve the planner's fix plan (rendered to `.runs/<id>/plan.md`).
3. **GATE 3 — approve the final diff** — approve the worktree diff against the base branch before anything is pushed.

Rejecting **GATE 3** with feedback loops back into the Coder⇄Tester loop, up to 3 iterations (`MAX_IMPL_ITERATIONS`). A Reviewer `REQUEST_CHANGES` likewise re-enters the loop. Rejecting **GATE 1 or GATE 2 aborts** the run (no feedback loop). Only after all gates pass does the PR worker push and open a real PR.

Flags:

- `--dry-run` — stubs every worker (no tokens, no API calls, no trace files) and skips gh entirely (no auth check); exercises routing + sequencing + SESSION_LOG/MEMORY writes. Note: it does **not** auto-approve gates unless you also pass `--interactive=false`.
- `--interactive=false` — auto-approves gates for CI/non-interactive runs.
- `--branch <name>` — override the fix branch name (defaults are generated per run).
- `--port <n>` — dashboard port (default `3456`).
- `--no-web` — disables the dashboard in both single-issue and queue mode.
- `--backend <name>` — which headless CLI runs the fleet workers: `opencode` | `claude` | `codex` (default `opencode`, or `ORCHESTRATOR_BACKEND` env). Applies to single-issue runs; in queue mode the dashboard's Backend toggle overrides it.

### Backends

Each backend runs the same 6 roles via its own CLI. `src/runner/backends.ts` owns the binary/argv/env and stream parsing for each.

- **opencode** (default) — free OpenCode Zen models. `opencode run --agent <role> -m opencode/<model> --dir <worktree> --format json [--variant <n>] "<task>"`. Uses the fallback pool and the `modelPolicy` overrides (`models.json`).
- **claude** — `claude -p "<task>" --output-format stream-json --model <m> --append-system-prompt "<role prompt>" --permission-mode plan|acceptEdits` (cwd = worktree). The role prompt is read from `agents/<role>.md` (frontmatter stripped). Reads the `.claude/agents/*.md` configs (model default `sonnet`).
- **codex** — `codex exec --cd <worktree> -m <m> -s <sandbox> --json -- [--approve-for-me] "<role prompt>\n\n<task>"`. The role prompt is embedded in the message (codex 0.147 has no `--agent` flag). Sandbox is `read-only` for analyzer/planner/reviewer, `workspace-write` for coder/tester, and `danger-full-access` for the pr role (it must `git push` + `gh pr create`, which need network). `--json` output is parsed tolerantly; the `-o <traceDir>/<role>.lastmsg` file is a fallback text source. Reads the `.codex/agents/*.toml` configs (model default `gpt-5.1-codex`).

Per-backend model defaults live in `src/models/modelPolicy.ts`; override them per role per backend in the dashboard Models panel or directly in `models.json` (nested per-backend object). The dashboard Model picker offers a curated catalog per backend plus **free-text entry**, so you can type any model id your subscription supports.

## Web Dashboard

Every run boots a **live local web dashboard** at **http://127.0.0.1:3456/** — a zero-dependency view built on Node's `node:http` (no npm packages, no CDN/network resources, no build step). Open it in a browser while a run is in progress to watch:

- run id, repo/issue, current phase, and loop iteration;
- one card per agent — spinner while running, ✓/✗ on finish, model, tokens, and cost when done, errors in red;
- a live per-role transcript streamed over **SSE** straight from each worker's trace output (last ~200 lines, auto-scroll), falling back to 2s polling if the stream drops;
- a connection indicator (green "live" / red "reconnecting");
- a **GitHub auth chip** — green `gh: @username` when signed in, red `gh: signed out` when not (auto-polls `/api/gh` every 5s; a "Recheck" button forces an immediate check);
- a red **"Not signed in to GitHub"** banner with a **"Log in" button** that runs the device-flow login (`gh`-style) and auto-polls until the token lands, plus a copyable **device code** (click-to-copy) and a Recheck button;
- a **Start a repo queue** panel (queue mode) and dashboard tabs for **MEMORY.md** and **SESSION_LOG.md**.

It is a **read-only mirror** of the terminal TUI. Gates, the final summary box, and `SESSION_LOG.md` behave exactly as before; the CLI stays fully usable with or without the browser. If the port is already in use the dashboard is skipped with a warning and the run is unaffected.

The dashboard boots **before** the gh auth check. When `gh` is not signed in the process **waits** (it does not exit, and the run does not start); the dashboard shows the login banner, and the moment `gh auth login` succeeds (auto-polled every 5s) the run **auto-starts**. This wait-and-auto-start applies to normal runs (including `--no-web`, which still does the gh auth check); `--dry-run` runs skip gh entirely, so no auth wait applies there.

Flags:

- `--port <n>` — dashboard port (default `3456`).
- `--no-web` — disables the dashboard in both single-issue and queue mode.

The dashboard also runs in `--dry-run` mode (useful for local dev).

### Dashboard API endpoints

The dashboard exposes a small JSON/SSE API used by its own UI:

| Endpoint | Purpose |
|---|---|
| `/api/gh` | GitHub auth status (`gh: @user` / signed out) |
| `/api/events` | SSE live trace stream (25s heartbeat, 2s polling fallback) |
| `/api/health` | Liveness check |
| `/api/state` | Current run state (phase, iteration, status) |
| `/api/memory` | MEMORY.md contents (dashboard tab) |
| `/api/session-log` | SESSION_LOG.md contents (dashboard tab) |
| `/api/login` | Device-flow login + token polling (the "Log in" button) |
| `/api/start` | Start a repo queue run from the dashboard |
| `/api/backend` | Get/set the run backend (`opencode` \| `claude` \| `codex`) |
| `/api/models` | Per-backend model catalog + overrides (GET `?backend=…`, POST to save) |

## Fleet Skills & Subagents

- RO roles (`analyzer`/`planner`/`reviewer`) emit their JSON artifacts against the canonical schemas held in the `fleet-schemas` skill (`.opencode/skills/fleet-schemas/SKILL.md`), not inlined in prompts.
- `analyzer`/`planner`/`reviewer` delegate raw repo reads/greps to the free-model `scout` subagent via the `task` tool (`task: true`, `permission.task: "allow"`, `permission.external_directory: "allow"` covering `.runs/**` and `.git/worktrees/**`).
- `pr-helper.md` was previously an unwired subagent; it has been **removed** — the orchestrator builds the PR title/body itself via `src/github/gh.ts`.
- The `fleet-schemas` skill and `scout` subagent each pin `opencode/deepseek-v4-flash-free` (free). RO roles run at `variant: "medium"`.

## Config

- **`opencode.json`** — all 6 fleet agents. Per-agent schema: `description`, `mode` (`"all"`), `model`, `steps` (per-agent step cap: analyzer 12, planner 10, scout 30, coder 12, tester 10, reviewer 8, pr 5), `tools` (`read`/`grep`/`glob`/`bash`/`list`/`write`/`edit`/`patch`/`task`/`skill`/`webfetch` booleans), `permission` (`bash`/`edit`/`webfetch`/`task`: allow|deny, plus `external_directory` allow-list for `.runs/**` and `**/.git/worktrees/**`), `prompt`. `permission` deny is what actually restricts a worker's *tools*; higher-level behavioral guarantees (no-push, no-merge) are prompt-enforced. No `$comment` key allowed.
- **`src/models/modelPolicy.ts`** — per-backend model tiers (reasoning vs build roles), the fallback pool, per-role `variant` (reasoning effort, opencode only), and curated model catalogs for claude/codex. Authoritative for the `-m`/`--model` passed at spawn (overrides the agent configs). `models.json` stores per-role, per-backend overrides.
- **`OPENCODE_CONFIG`** — set by the Manager to `<project>/opencode.json` when spawning each worker, so the roster is found even though workers run with `--dir` inside the worktree.
- **Hook Generation** — `npm run build:config` emits per-tool hook configs via `scripts/generate-configs.ts` (3 adapters: opencode, claude-code, codex) + syncs `agent_registry`. `npm run check:config` fails on drift. Hook scripts generated deterministically via `scripts/lib/hooks.ts`:
  - opencode: `.opencode/plugins/sor-hook.ts` (committed plugin source; `tool.execute.before/after` + `event`→`session.created`)
  - claude: `.claude/settings.json` hooks → `.claude/hooks/sor-hook.sh` (PreToolUse/PostToolUse/SessionStart/Stop)
  - codex: `.codex/config.toml` `[[hooks.*]]` + `[features] codex_hooks = true` → `.codex/hooks/sor-hook.sh`

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `OPENCODE_BIN` | `opencode` | Override the opencode binary path if it is not on PATH (see `src/runner/backends.ts`). |
| `CLAUDE_BIN` | `claude` | Override the Claude Code binary path. |
| `CODEX_BIN` | `codex` | Override the Codex binary path. |
| `ORCHESTRATOR_BACKEND` | `opencode` | Default backend when `--backend` is not passed. |
| `OPENROUTER_API_KEY` | — | Optional; only if you configure OpenRouter as a provider in opencode. |
| `DATABASE_URL` | — | Postgres connection string (required for real runs). |
| `SOR_SIGNING_KEY` | — | **Required**; HMAC-SHA256 secret for SOR hash chain (`openssl rand -hex 32`). |
| `SOR_EVENT_DIR` | `<runDir>/events` | Hook event file directory (optional override). |
| `SCAN_INTERVAL_MINUTES` | `5` | Daemon repo scan interval. |

GitHub auth is done through the `gh` CLI login (`gh auth login`), not environment variables. The free OpenCode Zen models need no key at all; Claude Code uses its own auth (`claude auth` / `ANTHROPIC_API_KEY`) and Codex its own (`codex login` / `OPENAI_API_KEY`).

Internally, the Manager isolates each worker's opencode state into `.runs/<id>/.opencode-data/` via `XDG_DATA_HOME`, seeding it with your `auth.json` from `~/.local/share/opencode/auth.json` (see `src/agentRunner.ts`) — so concurrent workers don't contend on a shared opencode database.

## Per-Run Artifacts

```
.runs/<run-id>/
├── plan.md              # the plan the human approves at GATE 2
├── fix-spec.json        # analyzer → planner handoff
├── repo/                # clone-once source (worktree source, never edited)
├── worktree/            # git worktree — the ONLY place code changes happen
├── result.json          # PR URL, status, cost, timings
├── SESSION_LOG.md       # previous session log stashed here
├── .opencode-data/      # per-worker isolated opencode db (XDG_DATA_HOME)
├── events/              # SOR hook events (events.jsonl)
└── traces/*.jsonl       # per-agent NDJSON streams (analyzer.jsonl, coder.jsonl, …)
```

Plus, per-agent, along each `traces/*.jsonl`:
- **`traces/*.stderr.log`** — the worker's stderr for that attempt (used to diagnose 5xx/quota/empty-output fallbacks).

And in the project root:
- **`SESSION_LOG.md`** — reset fresh each run; the previous log is stashed to `.runs/<id>/SESSION_LOG.md`.
- **`MEMORY.md`** — durable cross-run knowledge; the orchestrator is the only writer and appends a one-line run outcome (date, repo#issue, PR link, cost) under its "Run log" section. Auto-generated from database via `npm run generate-memory`.

Both `SESSION_LOG.md` and `MEMORY.md` are **tracked in git** (committed). `.runs/`, `node_modules/`, `dist/`, and `.env*` are gitignored (only `.env.example` is kept).

> **Dry-run note:** in `--dry-run` mode no `repo/` checkout is created and **no `traces/*.jsonl` are written** (the traces dir stays empty) — workers are stubbed, so there's no process output to record. SESSION_LOG.md and MEMORY.md are still written. SOR boot/phase/finalize events are still recorded and chain verifies.

## Verification Ladder

1. `npm run typecheck` — strict `tsc --noEmit`.
2. `npm run build` — production `tsc` build.
3. `npm run migrate:up` — apply all migrations (including 004 SOR).
4. `npm run sor:verify` — replays the hash chain; fails on first mismatched hash; reports counts by event_type/actor.
5. `npm run sor:sync-registry` — refresh `agent_registry` from `agents/*.md`.
6. `npm run dry -- --repo <url> --issue <n>` — stubbed workers, zero tokens. (Add `--interactive=false` to auto-approve the gates; no trace files are produced.)
7. Single-agent live — run only the Analyzer on a real issue to confirm auth, traces, and cost.
8. Full E2E — `npm start -- --repo <url> --issue <n>` on a small repo you own; clear all 3 gates → real PR URL in `result.json`.

**Isolation guarantee:** the Manager clones into `.runs/<id>/repo/` and works in the linked worktree at `.runs/<id>/worktree/`. Workers are pointed at the worktree via `--dir` and told it is disposable. Any existing checkout of the sample repo is never touched; all edits are confined to `.runs/<id>/worktree/`.

## PR Creation & Fallback

- **Happy path:** the PR worker pushes the branch (`git push -u origin HEAD`) and runs `gh pr create`. Nothing is merged automatically — merging stays a human decision.
- **Fallback path:** if the PR worker fails to create a PR, the orchestrator falls back to `gh pr view` then `createPr` (`gh pr create --base … --head …`) itself, producing `result.json` with the PR URL (see `src/orchestrator.ts`).
- Reviewer diff is capped at **25,000 characters** before it's handed to the Reviewer.

## Directory Structure

```
.
├── AGENT_IMPLEMENTATION_PROMPT.md          # Original prompt spec used to build the fleet agents/workflow
├── PLAN.md                                 # Working plan docs (currently: signed System of Record / SOR plan)
├── directory.md                            # This file — annotated repo map
│
└── Multi-Orchestration-export/             # Project root: TypeScript Manager + 6-worker fleet
    │
    # — top-level docs & config —
    ├── README.md                           # Project overview, architecture, CLI usage
    ├── AGENTS.md                           # Canonical rules file (read by opencode/codex); CLAUDE.md symlinks here
    ├── CLAUDE.md                           # Symlink -> AGENTS.md (Claude Code reads this name)
    ├── MEMORY.md                           # Regenerated run-log + "Next" memory (db/queries/summaryReport)
    ├── MEMORY.example.md                   # Template/example of MEMORY.md format
    ├── SESSION_LOG.md                      # Per-run session log appended by orchestrator/memory/sessionLog
    ├── package.json                        # Deps + scripts: start/dry/test/build:config/migrate/analytics
    ├── package-lock.json                   # npm lockfile
    ├── tsconfig.json                       # TypeScript config (ES2022, NodeNext, strict)
    ├── vitest.config.ts                    # Vitest setup (defaults DATABASE_URL, src/**/__tests__)
    ├── opencode.json                       # GENERATED opencode config (inline agents) — never hand-edit
    ├── models.json                         # Per-role model overrides for the opencode backend (persisted)
    ├── .env.example                        # Env template: OPENCODE_BIN, ORCHESTRATOR_BACKEND, SCAN_INTERVAL, DB…
    ├── .env                                # Local env/secrets (git-ignored; DB URL, CLI overrides)
    │
    # — SQL migrations (system of record, Postgres) —
    ├── migrations/
    │   ├── 001_init.sql                    # Core schema: run_outcomes, actions, trace/cost records
    │   ├── 002_agent_steps.sql             # Durable per-step checkpoint table (resume support)
    │   ├── 003_worker_roles.sql            # Worker role catalog table
    │   └── 004_sor.sql                     # Signed SOR: audit_events (HMAC hash chain) + sor_chain tail + agent_registry
    │
    # — agent definitions (single canonical source) —
    ├── agents/
    │   ├── _global.md                      # Shared frontmatter (external_directory permission grants)
    │   ├── analyzer.md                     # Read-only investigator -> FixSpec JSON
    │   ├── planner.md                      # Read-only fix designer -> Plan JSON
    │   ├── coder.md                        # Implementer: edits + commits in worktree (no push)
    │   ├── tester.md                       # Test writer/runner (test files only)
    │   ├── reviewer.md                     # Read-only diff reviewer -> APPROVE/REQUEST_CHANGES
    │   ├── pr.md                           # Pushes branch + opens PR via gh (no merge)
    │   └── scout.md                        # Read-only subagent (repo recon for the other roles)
    │
    # — config generators (agents/*.md -> each tool's format) —
    ├── scripts/
    │   ├── generate-configs.ts             # Runs every adapter against agents/*.md (build:config/check:config)
    │   └── adapters/
    │       ├── opencode.ts                 # Adapter -> opencode.json (inline agent blocks)
    │       ├── claude-code.ts              # Adapter -> .claude/agents/<role>.md
    │       └── codex.ts                    # Adapter -> .codex/agents/<role>.toml
    │   └── lib/
    │       ├── adapter.ts                  # Adapter interface contract
    │       ├── canonical.ts                # Shared canonical parsing of agents/*.md frontmatter
    │       └── hooks.ts                    # Shared hook-script templates (claude/codex .sh, generated deterministically)
    │
    # — source (plain TypeScript, not an LLM) —
    ├── src/
    │   ├── index.ts                        # CLI entrypoint: single run, queue/daemon, dashboard, args
    │   ├── orchestrator.ts                 # THE Manager: 3 human gates, 6 workers, git worktrees, PR flow
    │   ├── agentRunner.ts                  # Spawns headless workers (opencode run), tails/parses NDJSON
    │   ├── router.ts                       # Issue -> route mapping (impl roles, max iterations)
    │   ├── gates.ts                        # Human approval gates (gate 1/2/3 prompt+feedback)
    │   ├── types.ts                        # Shared types (Role, AgentResult, RunContext, RunSummary…)
    │   │
    │   ├── runner/
    │   │   └── backends.ts                 # Per-backend spawn args, env, NDJSON trace parsing, token/cost
    │   ├── models/
    │   │   └── modelPolicy.ts              # Authoritative model tiers + free fallback pool + overrides
    │   ├── git/
    │   │   └── worktree.ts                 # Isolated git worktree setup + diff/stat helpers
    │   ├── github/
    │   │   └── gh.ts                       # gh CLI wrapper (create PR, view)
    │   ├── db/
    │   │   ├── client.ts                   # Postgres client/pool (DATABASE_URL)
    │   │   ├── schema.ts                   # DB table/column type definitions
    │   │   ├── migrate.ts                  # Migration runner (npm run migrate:up/down)
    │   │   ├── checkpoint.ts               # Per-step checkpoint API (start/markSuccess/markFailed)
    │   │   ├── audit.ts                    # SOR writes (appendAuditEvent, syncAgentRegistry, verifyChain)
    │   │   └── queries/
    │   │       └── summaryReport.ts        # Generates MEMORY.md from run_outcomes
    │   ├── sor/
    │   │   ├── events.ts                   # SorEvent types + normalizeEvent/truncate (tool input/output caps)
    │   │   ├── signer.ts                   # canonicalJson + HMAC-SHA256 hash chain (GENESIS_HASH constant)
    │   │   ├── ingest.ts                   # tail events.jsonl + opencode NDJSON → appendAuditEvent
    │   │   ├── verify.ts                   # Chain-replay verification helpers
    │   │   ├── verifyCli.ts                # `npm run sor:verify`
    │   │   ├── syncRegistryCli.ts          # `npm run sor:sync-registry`
    │   │   └── __tests__/                  # signer/ingest unit tests
    │   ├── workflow/
    │   │   ├── coder.ts                    # 5-step checkpointed coder phase (parse->edit->test->commit->verify)
    │   │   ├── tester.ts                   # Tester phase wrapper
    │   │   └── index.ts                    # Workflow re-exports
    │   ├── tui/
    │   │   └── dashboard.ts                # Terminal dashboard renderer
    │   ├── dashboard/
    │   │   └── webDashboard.ts             # Web dashboard (node:http + SSE), Stop control, gh status
    │   ├── mcp/
    │   │   └── server.ts                   # MCP server (port via env)
    │   ├── memory/
    │   │   ├── sessionLog.ts               # Per-run SESSION_LOG.md writer
    │   │   └── memoryStore.ts              # Shared in-memory store (used by workforce)
    │   ├── workforce/
    │   │   ├── hiring.ts                   # Workforce hiring logic
    │   │   └── policy.ts                   # Workforce policy loading (WORKFORCE_POLICY_PATH)
    │   ├── analytics/
    │   │   ├── queries.ts                  # Analytics SQL queries
    │   │   └── report.ts                   # Analytics report generator (npm run analytics)
    │   ├── daemon/
    │   │   └── dedup.ts                    # Daemon dedup: skip already-fixed issues (DB + open PR)
    │   └── __tests__/                      # Vitest suite (one file per module under test)
    │       ├── agentRunner.test.ts         # Worker spawn + token-summing trace parsing
    │       ├── analytics.test.ts           # Analytics report/queries
    │       ├── backends.test.ts            # Backend args/env/trace parsing
    │       ├── checkpoint.test.ts          # Step checkpoint API
    │       ├── daemon.test.ts              # Daemon loop + dedup/skip logic
    │       ├── dashboard.test.ts           # Dashboard state/rendering
    │       ├── extractJson.test.ts         # JSON extraction (orchestrator helper)
    │       ├── gates.test.ts               # Human gate logic
    │       ├── github.test.ts              # gh wrapper
    │       ├── hiring.test.ts              # Workforce hiring
    │       ├── mcp-server.test.ts          # MCP server
    │       ├── modelPolicy.test.ts         # Model tiers/overrides
    │       └── router.test.ts              # Issue routing
    │
    # — generated per-tool configs (never hand-edit) —
    ├── .claude/
    │   ├── settings.json                   # GENERATED hook bindings (PreToolUse/PostToolUse/SessionStart/Stop)
    │   ├── hooks/
    │   │   └── sor-hook.sh                 # GENERATED hook script (writes JSONL to SOR_EVENT_DIR)
    │   ├── agents/                         # GENERATED Claude Code agent defs (.md)
    │   └── skills/
    │       └── fleet-schemas/SKILL.md      # Canonical JSON schemas for analyzer/planner/reviewer output
    ├── .codex/
    │   ├── config.toml                     # GENERATED hook config + [features] codex_hooks = true
    │   ├── hooks/
    │   │   └── sor-hook.sh                 # GENERATED hook script (writes JSONL to SOR_EVENT_DIR)
    │   └── agents/ (+ skills/fleet-schemas) # GENERATED Codex agent defs (.toml)
    ├── .opencode/                          # Local opencode config: plugins/, skills/, node_modules
    │   ├── plugins/
    │   │   └── sor-hook.ts                 # COMMITTED plugin (tool.execute.before/after, session.created via event)
    │   └── skills/
    │       └── fleet-schemas/SKILL.md      # Canonical JSON schemas for analyzer/planner/reviewer output
    │
    # — runtime/build artifacts (git-ignored) —
    ├── .runs/                              # Per-run artifacts: worktree/, traces/*.jsonl, logs, fix-spec/plan
    ├── dist/                               # tsc build output
    └── node_modules/                       # npm dependencies
```

## Limitations / Notes

- Free-tier OpenCode Zen models may 503 or hit quota → the runner falls back through the pool; if all models fail the worker reports an error and the run fails. Note `opencode/deepseek-v4-flash-free` is both the primary model for reasoning roles and the first fallback for all roles.
- opencode CLI flags (`run --agent/-m/--dir/--format json/--variant`) were verified only on **v1.18.7**; versions may drift. Claude Code flags (`-p/--output-format stream-json/--model/--append-system-prompt/--permission-mode`) verified on **v2.1.201**; Codex flags (`exec/--cd/-m/-s/--json/-o/--approve-for-me`) verified on **v0.147.0**. Codex `--json` event shapes are parsed tolerantly and fall back to the `-o` output file.
- **SOR caveats:** Codex hooks fire for the `Bash` tool only today (requires `[features] codex_hooks = true`); non-Bash calls fall back to NDJSON/trace capture. Claude headless (`claude -p`): hook discovery depends on cwd/config location; verify empirically and fall back to trace capture where hooks can't fire. No DB creds in worktrees: hooks write local JSONL only; the Manager owns the DB write. If `SOR_EVENT_DIR` is unset, hooks no-op safely. Hook scripts are generated deterministically by the adapters so `check:config` remains meaningful. All SOR writes are non-fatal — never abort a run. `--dry-run` still records boot/phase/finalize events (chain verifies, no API/tokens).
- **`--no-web` disables the dashboard in both single-issue and queue mode.**
- **Nothing is merged automatically.** The PR worker only pushes a branch and opens a PR; merging stays a human decision.
- `gh` must have access to the target repo for cloning and PR creation.
- "No push" (coder/tester) and "no merge" (pr) are **prompt-enforced**, not hard permission blocks — they rely on the agent following its instructions.
