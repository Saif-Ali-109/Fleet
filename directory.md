---
title: Repository Map
description: Annotated map of Multi-Orchestration's files, folders, and generated configs
updated: 2026-08-22
---

# directory.md

Annotated repo map for Multi-Orchestration. Generated fleet configs live under `.fleet/` — never hand-edit anything there; edit `agents/*.md` and run `npm run build:config`.

```
.
├── AGENT_IMPLEMENTATION_PROMPT.md          # Original prompt spec used to build the fleet agents/workflow
├── PLAN.md                                 # Current working plan (hybrid webhook triggering; dashboard transcript fixes)
├── directory.md                            # This file — annotated repo map
│
# — top-level docs & config —
├── README.md                               # Project overview, architecture, CLI usage
├── AGENTS.md                               # Canonical rules file (read by opencode/codex); CLAUDE.md symlinks here
├── CLAUDE.md                               # Symlink -> AGENTS.md (Claude Code reads this name)
├── package.json                            # Deps + scripts: start/dry/test/build:config/migrate/analytics
├── package-lock.json                       # npm lockfile
├── tsconfig.json                           # TypeScript config (ES2022, NodeNext, strict)
├── vitest.config.ts                        # Vitest setup (defaults DATABASE_URL, src/**/__tests__)
├── .env.example                            # Env template: OPENCODE_BIN, ORCHESTRATOR_BACKEND, SCAN_INTERVAL, DB…
├── .env                                    # Local env/secrets (git-ignored; DB URL, CLI overrides)
│
# — manager runtime artifacts (durable memory, session log, model overrides) —
├── manager/
│   ├── MEMORY.md                             # Regenerated cross-run memory + "Run log" (orchestrator-only writer; npm run generate-memory)
│   ├── MEMORY.example.md                     # Template/example of MEMORY.md format
│   ├── SESSION_LOG.md                        # Fresh per run; previous log stashed to .runs/<id>/SESSION_LOG.md
│   └── models.json                           # Per-role, per-backend model overrides (dashboard Models panel persists here)
│
# — SQL migrations (system of record, Postgres) —
├── migrations/
│   ├── 001_init.sql                        # Core schema: run_outcomes, actions, trace/cost records
│   ├── 002_agent_steps.sql                 # Durable per-step checkpoint table (resume support)
│   ├── 003_worker_roles.sql                # Worker role catalog table
│   └── 004_sor.sql                         # Signed SOR: audit_events (HMAC hash chain) + sor_chain tail + agent_registry
│
# — agent definitions (single canonical source) —
├── agents/
│   ├── _global.md                          # Shared frontmatter (external_directory permission grants)
│   ├── analyzer.md                         # Read-only investigator -> FixSpec JSON
│   ├── planner.md                          # Read-only fix designer -> Plan JSON
│   ├── coder.md                            # Implementer: edits + commits in worktree (no push)
│   ├── tester.md                           # Test writer/runner (test files only)
│   ├── reviewer.md                         # Read-only diff reviewer -> APPROVE/REQUEST_CHANGES
│   ├── pr.md                               # Pushes branch + opens PR via gh (no merge)
│   └── scout.md                            # Read-only subagent (repo recon for the other roles)
│
# — config generators (agents/*.md -> each tool's format) —
├── scripts/
│   ├── generate-configs.ts                 # Runs every adapter against agents/*.md (build:config/check:config)
│   ├── adapters/
│   │   ├── opencode.ts                     # Adapter -> .fleet/opencode.json (inline agent blocks)
│   │   ├── claude-code.ts                  # Adapter -> .fleet/claude/agents/<role>.md
│   │   └── codex.ts                        # Adapter -> .fleet/codex/agents/<role>.toml
│   └── lib/
│       ├── adapter.ts                      # Adapter interface contract
│       ├── canonical.ts                    # Shared canonical parsing of agents/*.md frontmatter
│       └── hooks.ts                        # Shared hook-script templates (claude/codex .sh, generated deterministically)
│
# — source (plain TypeScript, not an LLM) —
├── src/
│   ├── index.ts                            # CLI entrypoint: single run, queue/daemon, dashboard, args
│   ├── orchestrator.ts                     # THE Manager: 3 human gates, 6 workers, git worktrees, PR flow
│   ├── agentRunner.ts                      # Spawns headless workers (opencode run), tails/parses NDJSON
│   ├── router.ts                           # Issue -> route mapping (impl roles, max iterations)
│   ├── gates.ts                            # Human approval gates (gate 1/2/3 prompt+feedback)
│   ├── types.ts                            # Shared types (Role, AgentResult, RunContext, RunSummary…)
│   │
│   ├── runner/
│   │   └── backends.ts                     # Per-backend spawn args, env, NDJSON trace parsing, token/cost
│   ├── models/
│   │   └── modelPolicy.ts                  # Authoritative model tiers + free fallback pool + overrides
│   ├── git/
│   │   └── worktree.ts                     # Isolated git worktree setup + diff/stat helpers
│   ├── github/
│   │   └── gh.ts                           # gh CLI wrapper (create PR, view)
│   ├── db/
│   │   ├── client.ts                       # Postgres client/pool (DATABASE_URL)
│   │   ├── schema.ts                       # DB table/column type definitions
│   │   ├── migrate.ts                      # Migration runner (npm run migrate:up/down)
│   │   ├── checkpoint.ts                   # Per-step checkpoint API (start/markSuccess/markFailed)
│   │   ├── audit.ts                        # SOR writes (appendAuditEvent, syncAgentRegistry, verifyChain)
│   │   └── queries/
│   │       └── summaryReport.ts            # Generates MEMORY.md from run_outcomes
│   ├── sor/
│   │   ├── events.ts                       # SorEvent types + normalizeEvent/truncate (tool input/output caps)
│   │   ├── signer.ts                       # canonicalJson + HMAC-SHA256 hash chain (GENESIS_HASH constant)
│   │   ├── ingest.ts                       # tail events.jsonl + opencode NDJSON → appendAuditEvent
│   │   ├── verify.ts                       # Chain-replay verification helpers
│   │   ├── verifyCli.ts                    # `npm run sor:verify`
│   │   ├── syncRegistryCli.ts              # `npm run sor:sync-registry`
│   │   └── __tests__/                      # signer/ingest unit tests
│   ├── workflow/
│   │   ├── coder.ts                        # Checkpointed coder phases (parse-edit -> run-tests -> commit -> verify-diff), session-resumed
│   │   ├── tester.ts                       # Tester phase wrapper
│   │   ├── scoutTracker.ts                 # Tracks scout subagent invocations per parent role
│   │   └── index.ts                        # Workflow re-exports
│   ├── tui/
│   │   └── dashboard.ts                    # Terminal dashboard renderer
│   ├── dashboard/
│   │   └── webDashboard.ts                 # Web dashboard (node:http + SSE), Stop control, gh status
│   ├── mcp/
│   │   └── server.ts                       # MCP server (port via env)
│   ├── memory/
│   │   ├── sessionLog.ts                   # Per-run SESSION_LOG.md writer
│   │   └── memoryStore.ts                  # Shared in-memory store (used by workforce)
│   ├── workforce/
│   │   ├── hiring.ts                       # Workforce hiring logic
│   │   └── policy.ts                       # Workforce policy loading (WORKFORCE_POLICY_PATH)
│   ├── analytics/
│   │   ├── queries.ts                      # Analytics SQL queries
│   │   └── report.ts                       # Analytics report generator (npm run analytics)
│   ├── daemon/
│   │   ├── dedup.ts                        # Daemon dedup: skip already-fixed issues (label + open PR + DB)
│   │   └── webhook.ts                      # GitHub webhook HMAC verification + issues-event parsing
│   └── __tests__/                          # Vitest suite (one file per module under test)
│       ├── agentRunner.test.ts             # Worker spawn + token-summing trace parsing
│       ├── analytics.test.ts               # Analytics report/queries
│       ├── backends.test.ts                # Backend args/env/trace parsing
│       ├── checkpoint.test.ts              # Step checkpoint API
│       ├── daemon.test.ts                  # Daemon loop + dedup/skip logic
│       ├── dashboard.test.ts               # Dashboard state/rendering
│       ├── extractJson.test.ts             # JSON extraction (orchestrator helper)
│       ├── gates.test.ts                   # Human gate logic
│       ├── github.test.ts                  # gh wrapper
│       ├── hiring.test.ts                  # Workforce hiring
│       ├── mcp-server.test.ts              # MCP server
│       ├── modelPolicy.test.ts             # Model tiers/overrides
│       ├── router.test.ts                  # Issue routing
│       ├── scoutTracker.test.ts            # Scout invocation tracking
│       └── webhook.test.ts                 # Webhook signature verification + event parsing
│
# — generated per-tool fleet configs (never hand-edit) —
# Root .claude/, .codex/, .opencode/ no longer hold fleet configs; they are
# user-personal tool content only. All generated fleet configs live in .fleet/.
├── .fleet/
│   ├── opencode.json                       # GENERATED opencode config (inline agents); workers find it via OPENCODE_CONFIG
│   ├── opencode/                           # Fleet opencode project config (moved from root .opencode/)
│   │   ├── plugins/
│   │   │   └── sor-hook.ts                 # COMMITTED plugin (tool.execute.before/after, session.created via event)
│   │   ├── opencode.json                   # GENERATED opencode project config (hook bindings)
│   │   ├── agent/                          # GENERATED opencode agent defs (.md)
│   │   └── skills/
│   │       └── fleet-schemas/SKILL.md      # Canonical JSON schemas — source of truth; Manager copies into each worktree
│   ├── claude/                             # Fleet Claude Code config (was root .claude/); passed via --settings flag
│   │   ├── settings.json                   # GENERATED hook bindings (PreToolUse/PostToolUse/SessionStart/Stop)
│   │   ├── hooks/
│   │   │   └── sor-hook.sh                 # GENERATED hook script (writes JSONL to SOR_EVENT_DIR)
│   │   └── agents/*.md                     # GENERATED Claude Code agent defs (.md)
│   └── codex/                              # Fleet Codex config (was root .codex/); workers get CODEX_HOME=.fleet/codex
│       ├── config.toml                     # GENERATED hook config + [features] codex_hooks = true
│       ├── hooks/
│       │   └── sor-hook.sh                 # GENERATED hook script (writes JSONL to SOR_EVENT_DIR)
│       └── agents/*.toml                   # GENERATED Codex agent defs (.toml)
│
# — runtime/build artifacts (git-ignored) —
├── .runs/                                  # Per-run artifacts: worktree/, traces/*.jsonl, logs, fix-spec/plan
├── dist/                                   # tsc build output
└── node_modules/                           # npm dependencies
```

Notes:

- Skills are delivered per run: the Manager copies `fleet-schemas` into each worktree as `<worktree>/.opencode/skills/` and `<worktree>/.claude/skills/` (kept out of commits via per-worktree `.git/info/exclude`); codex gets the skill content appended to its role prompt.
- Hook commands in all generated configs are `bash "$FLEET_SOR_HOOK"` — the Manager sets `FLEET_SOR_HOOK` in each worker's env at spawn.
