---
title: Fleet README
status: active
created: 2026-08-24
updated: 2026-09-17
---

# Fleet

TypeScript Manager that forks custom OpenAI-SDK workers (Gemini → OpenRouter → Ollama) to take a GitHub issue to a real PR. No human gates; analyzer→planner→coder→tester→reviewer→(≤1 auto-fix)→pr. PostgreSQL-backed SOR audit chain. Hand-rolled web dashboard + ANSI TUI.

## Naming convention

"Fleet" is the product name. Lowercase "fleet" elsewhere in this codebase (the `src/fleet/` module, `FLEET_PROVIDERS`, `FleetAgentDef`) refers to the worker-fleet concept and predates the branding — treat them as distinct.

## Quick start

```bash
# Install
npm i

# Configure (copy and edit)
cp .env.example .env
# Set at minimum: GEMINI_API_KEY, DATABASE_URL, and a SOR signing key
# (SOR_SIGNING_KEY, or SOR_KEY_V1 with SOR_KEY_ID=v1)

# Database
npm run migrate:up

# Dry run (keyless: no API calls, no workers, no gh)
npm run dry -- --repo owner/repo --issue 123

# Live run — one issue → PR
npm start -- --repo owner/repo --issue 123
```

Both commands accept the same CLI flags: `--branch <name>`, `--port <n>`
(dashboard, default `3456`), `--no-web`, and
`--provider gemini|openrouter|ollama`. With no `--repo`/`--issue` you get
dashboard queue mode: paste a repo URL and it fixes every open issue, one by
one (`SCAN_INTERVAL_MINUTES` poll plus an optional `/webhook` hybrid trigger via
`WEBHOOK_SECRET`).

## Architecture

- **Manager** (`src/index.ts`, `src/orchestrator.ts`): coordinates the 6-role pipeline, manages worktrees, streams events to dashboard/TUI — never calls models itself
- **Workers** (`src/runtime/worker/main.ts`, `src/fleet/loop.ts`): generic child processes running the agent loop on the OpenAI SDK; all model/API calls happen here
- **Agent runner** (`src/agentRunner.ts`): spawns/kills workers and walks each role's model chain, with auto fail-back on quota blocks signaled by `src/fleet/quotaSignals.ts`; notifications fan out via `src/fleet/quotaEvents.ts`
- **Providers** (`src/providers/registry.ts`): memoized OpenAI clients for Gemini / OpenRouter / Ollama with fallback walk (`FLEET_PROVIDERS` order)
- **Model policy** (`src/models/modelPolicy.ts`, `src/fleet/modelDefaults.ts`): dashboard override > env > tier defaults; Gemini fallback chains come only from `GEMINI_RATE_LIMIT_MODELS`
- **Quota coordinator** (`src/gemini/quotaCoordinator.ts`, `quotaConfig.ts`): manager-owned per-model RPM/TPM/RPD reservations, fail-closed before every Gemini call
- **Tools** (`src/fleet/tools/`): bash/read/write/edit/grep/glob/load_skill with hard per-role gating, cwd-locked to the worktree
- **MCP** (`src/mcp/fleetServer.ts`): own stdio MCP server backed by `gh api`; strict allowlist (analyzer: get_issue, get_issue_comments; pr: create_pr, get_checks)
- **SOR** (`src/sor/`): tamper-evident hash chain, all writes non-fatal
- **Dashboard** (`src/dashboard/webDashboard.ts`): node:http + SSE, provider/model picker, live transcript
- **TUI** (`src/tui/dashboard.ts`): ANSI dashboard for terminal

## Configuration

| Variable | Description |
|----------|-------------|
| `FLEET_PROVIDERS` | Fallback order, e.g. `gemini,openrouter,ollama` (invalid names skipped with a warning) |
| `ORCHESTRATOR_PROVIDER` | Default provider for runs: `gemini` \| `openrouter` \| `ollama` (default `gemini`) |
| `GEMINI_API_KEY` | Required for the primary (gemini) provider path |
| `GEMINI_QUOTA_LIMITS` | JSON overrides keyed by exact Gemini model id (`rpm`, `tpm`, `rpd`) |
| `GEMINI_QUOTA_OVERRIDES` | Runtime-only per-model quota tweaks on top of the coordinator |
| `GEMINI_RATE_LIMIT_MODELS` | Ordered fallback pool every role switches to on rpm/tpm/rpd blocks |
| `GEMINI_RATE_LIMIT_WAIT_MS` | Maximum rolling-limit wait ceiling (default `120000`) |
| `GEMINI_MAX_OUTPUT_TOKENS` | Max output tokens for Gemini calls (default `8192`) |
| `OPENROUTER_API_KEY` | Optional fallback |
| `OLLAMA_BASE_URL` | Optional local Ollama, default `http://localhost:11434/v1` |
| `<ROLE>_MODEL_<PROVIDER>` | Per-role model overrides, e.g. `ANALYZER_MODEL_GEMINI`; all six `*_MODEL_GEMINI` are required for live Gemini runs |
| `DATABASE_URL` | PostgreSQL connection string |
| `DATABASE_POOL_SIZE` | pg.Pool max connections (default `10`) |
| `SOR_KEY_ID` / `SOR_KEY_V1` | Per-key signing scheme (`SOR_KEY_<KEY_ID>`); `SOR_KEY_ID` selects the current signing key (default `v1`) |
| `SOR_SIGNING_KEY` | Legacy shared secret, used as the v1 key when `SOR_KEY_V1` is unset (openssl rand -hex 32) |
| `WORKER_TIMEOUT_MS` | Worker kill switch (hard timeout in ms) |
| `WORKER_TIMEOUT_GRACE_MS` | Grace before SIGKILL (default 1000) |
| `WEBHOOK_SECRET` | GitHub webhook secret for `POST /webhook` (queue mode hybrid trigger); unset = endpoint disabled |
| `SCAN_INTERVAL_MINUTES` | Daemon rescan interval for open issues (default `5`) |
| `FLEET_LLM_STREAM` | Stream chat completions (SSE); set `1` for slow local backends (ollama on CPU) |
| `MAX_REVIEW_DIFF_CHARS` | Max diff chars shown to the reviewer (default `25000`) |

See `.env.example` for the full list (Ollama resilience tuning, content/context
SoR, workforce policy, MCP server, etc.).

Model resolution order: dashboard override > env > tier defaults (strong for
analyzer/planner/reviewer, cheap for coder/tester/pr).

Gemini generation calls are fail-closed behind a manager-owned per-model
reservation immediately before every initial, streaming, retry, and tool
continuation request. Traces and dashboard SSE include redacted request
identities and reservation/provider outcomes. Dashboard `/api/models` traffic
is explicitly classified as metadata and never consumes generation RPM.

Gemini quota validation is exact-model based and runs before run/worktree/audit
setup — skipped for dry runs and for explicitly selected non-Gemini providers.
Built-in defaults cover `gemini-3.7-flash`, `gemini-3.6-flash`,
`gemini-3.5-flash`, `gemini-3.5-flash-lite`, and `gemini-3.1-flash-lite`. Use
`GEMINI_QUOTA_LIMITS='{"model-id":{"rpm":5,"tpm":250000,"rpd":20}}'` for
account-specific or future IDs. Live Gemini runs additionally require all six
`<ROLE>_MODEL_GEMINI` env vars, and every model in `GEMINI_RATE_LIMIT_MODELS`
must have a quota entry. Unknown, malformed, or non-positive limits fail
closed.

## Commands

| Command | Description |
|---------|-------------|
| `npm start -- --repo <url> --issue <n>` | One issue → PR (web dashboard on port `3456` by default) |
| `npm start` | Queue mode: dashboard-driven daemon fixing open issues one by one, plus optional `/webhook` trigger |
| `npm run dry -- --repo <url> --issue <n>` | Keyless stubbed run: no API calls, no workers, no gh |
| `npm test` / `npm run typecheck` | Unit tests / TypeScript check |
| `npm run build` | Compile with `tsc` |
| `npm run migrate:up` / `migrate:down` | Postgres schema |
| `npm run sor:verify` | Replay SOR hash chain (must stay green) |
| `npm run sor:repair` | Re-sign all audit rows under the current signing key (key-loss recovery only) |
| `npm run sor:content:sync` | Manual content-SoR markdown ingestion → embeddings |
| `npm run sor:context` | Context-SoR CLI (`seed-org`, `show`, `list`) |
| `npm run sor:at` | Acceptance-test suite (strict manifest subset via `vitest.at.config.ts`) |
| `npm run generate-memory` | Rebuild the `MEMORY.md` run log from `run_outcomes` |
| `npm run analytics` | Cross-run cost/usage analytics report |
| `npm run lint` / `npm run format` | Biome lint / format |

`start`/`dry` flags: `--branch <name>`, `--port <n>`, `--no-web`,
`--provider gemini|openrouter|ollama`. Privileged policy SoR CLI:
`npm start -- sor:policy seed | reconcile <role> <file> | show <role>`.

## Development

```bash
npm run typecheck && npm test
```