---
title: Fleet README
status: active
created: 2026-08-24
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
# Set at minimum: GEMINI_API_KEY, DATABASE_URL, SOR_SIGNING_KEY

# Database
npm run migrate:up

# Dry run (no API calls, no DB writes)
npm run dry -- --repo owner/repo --issue 123

# Live run
npm start -- --repo owner/repo --issue 123
```

## Architecture

- **Manager** (`src/index.ts`, `src/orchestrator.ts`): coordinates the 6-role pipeline, manages worktrees, streams events to dashboard
- **Workers** (`src/runtime/worker/main.ts`, `src/fleet/loop.ts`): generic child processes running the agent loop on OpenAI SDK
- **Providers** (`src/providers/registry.ts`): memoized OpenAI clients for Gemini / OpenRouter / Ollama with fallback walk
- **Tools** (`src/fleet/tools/`): bash/read/write/edit/grep/glob/load_skill with hard per-role gating, cwd-locked to worktree
- **MCP** (`src/mcp/fleetServer.ts`): own stdio MCP server backed by `gh api`; strict allowlist (analyzer: get_issue, get_issue_comments; pr: create_pr, get_checks)
- **SOR** (`src/sor/`): tamper-evident hash chain, all writes non-fatal
- **Dashboard** (`src/dashboard/webDashboard.ts`): node:http + SSE, provider/model picker, live transcript
- **TUI** (`src/tui/dashboard.ts`): ANSI dashboard for terminal

## Configuration

| Variable | Description |
|----------|-------------|
| `FLEET_PROVIDERS` | Fallback order, e.g. `gemini,openrouter,ollama` |
| `GEMINI_API_KEY` | Primary provider key (required) |
| `GEMINI_QUOTA_LIMITS` | Optional JSON overrides keyed by exact Gemini model id (`rpm`, `tpm`, `rpd`) |
| `GEMINI_RATE_LIMIT_WAIT_MS` | Maximum rolling-limit wait ceiling (default `120000`) |
| `OPENROUTER_API_KEY` | Optional fallback |
| `OLLAMA_BASE_URL` | Optional local Ollama, default `http://localhost:11434/v1` |
| `<ROLE>_MODEL_<PROVIDER>` | Per-role model overrides, e.g. `ANALYZER_MODEL_GEMINI=gemini-2.5-pro` |
| `DATABASE_URL` | PostgreSQL connection string |
| `SOR_SIGNING_KEY` | 32-byte hex (openssl rand -hex 32) |
| `WORKER_TIMEOUT_MS` | Optional worker kill switch |
| `WORKER_TIMEOUT_GRACE_MS` | Grace before SIGKILL (default 1000) |

Model resolution order: dashboard override > env > tier defaults (strong for analyzer/planner/reviewer, cheap for coder/tester/pr).

Gemini generation calls are fail-closed behind a manager-owned per-model
reservation immediately before every initial, streaming, retry, and tool
continuation request. Traces and dashboard SSE include redacted request
identities and reservation/provider outcomes. Dashboard `/api/models` traffic
is explicitly classified as metadata and never consumes generation RPM.

Gemini quota validation is exact-model based and runs before run/worktree/audit
setup. Built-in defaults cover `gemini-3-flash-preview`,
`gemini-3.5-flash`, `gemini-2.5-flash-lite`, `gemini-3.5-flash-lite`, and
`gemini-3.1-flash-lite`, plus the existing 2.5 defaults. Use
`GEMINI_QUOTA_LIMITS='{"model-id":{"rpm":5,"tpm":250000,"rpd":20}}'` for
account-specific or future IDs. Unknown, malformed, or non-positive limits fail
closed; explicitly selected non-Gemini providers skip Gemini validation.

## Commands

| Command | Description |
|---------|-------------|
| `npm start -- --repo <url> --issue <n>` | One issue → PR |
| `npm run dry -- --repo <url> --issue <n>` | Keyless stubbed run |
| `npm test` / `npm run typecheck` | Verify |
| `npm run migrate:up` / `migrate:down` | Postgres schema |
| `npm run sor:verify` | Replay SOR hash chain |
| `npm run generate-memory` | Analytics report |
| `npm run analytics` | Cost/usage analytics |

## Development

```bash
npm run typecheck && npm test
```
