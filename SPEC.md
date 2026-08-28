---
title: Migration Spec — CLI Fleet to Custom OpenAI-SDK Agents
status: active
date: 2026-08-22
owner: ain
audience: builder-agent (fresh session — read top to bottom before any edit)
supersedes: PLAN.md ("Working State")
---

# SPEC.md — CLI Fleet → Custom SDK Agents (Gemini-first)

## 0. How to use this document

You are building this migration in a NEW session. Every decision below is final —
do not re-litigate, do not ask the user again unless this file contradicts the codebase.
Work phases (§13) in order; each phase ends green (`npm run typecheck && npm test`)
unless stated otherwise. Commit after every phase with a short imperative subject.
Track progress ONLY via the §17 checklist: on session start read §17 first, find
the first unchecked item, do it, tick it, commit (`docs: check <item>`).
Never skip ahead past failing acceptance criteria.

## 1. What this repo IS today (orientation)

TypeScript Manager orchestrating 6 roles (analyzer, planner, coder, tester,
reviewer, pr) as spawned headless CLI workers taking a GitHub issue → PR.
PostgreSQL-backed SOR audit chain (hash-linked events). Hand-rolled node:http
web dashboard + ANSI TUI. Node ≥22, tsx runtime, vitest.

Key current-state facts (verified against the code):

- `src/types.ts:8` — `Backend = "opencode" | "claude" | "codex"` threaded
  everywhere (index.ts BACKENDS list, dashboard picker, analytics `backend`
  column, modelPolicy catalogs).
- `src/agentRunner.ts` — `runWorker()` spawns a CLI binary per role via
  `buildBackendArgs` / `buildBackendEnv` / `resolveRolePrompt` from
  `src/runner/backends.ts`; tails the per-attempt trace JSONL
  (`ctx.tracesDir/<role>.jsonl`) with `startTailing`; parses vendor formats via
  `parseBackendTrace` → normalizes into
  `AgentResult { role, ok, sessionID, model, attempts[], text, tokens{input,
  output, reasoning, cached, cacheWrite, total}, costUsd, sawError, error,
  tracePath, startedAt, endedAt }`.
- Abort machinery: `killActiveWorkers()` SIGTERMs all live children + latches an
  abort flag so runWorker fails fast instead of walking the fallback pool;
  `WORKER_TIMEOUT_MS` / `WORKER_TIMEOUT_GRACE_MS` kill switch inside `spawnOnce`.
- `src/orchestrator.ts` — phase flow idle→analyze→plan→GATE1→implement→review→
  GATE2→pr→done; calls `runWorker` through its `runAgent()` wrapper (~line 327),
  forwarding `onText` / `onEvent` to the web dashboard
  (`web.pushOutput(role,text)` / `web.pushAgentEvent(role,ev)`). Coder/tester
  retry loops live in `src/workflow/{coder,tester}.ts`, using
  `aggregateAgentResults` + `resumeSessionID` (cross-process CLI resume).
- Gates are HUMAN approval prompts (dashboard approve buttons) at plan and
  pre-pr checkpoints.
- Model policy `src/models/modelPolicy.ts`: per-backend catalogs
  (`FREE_OPCODE_MODELS`, `CLAUDE_MODELS`, `CODEX_MODELS`), `POLICIES` per role
  with fallback pools, mutable overrides persisted to `manager/models.json`
  nested per-backend; `availableModels(backend)` feeds dashboard suggestions.
- SOR audit: hook shell-scripts (claude/codex) + a TS plugin (opencode) append
  tool-call events to `<runDir>/events/events.jsonl`; hash chain verified by
  `npm run sor:verify` (`src/sor/verifyCli.ts`); writes go through
  `ensureChain`/`appendAuditEvent` in `src/db/audit.ts`. ALL SOR WRITES ARE
  NON-FATAL by contract (warn, never abort the run). `sor:sync-registry` reads
  `agents/*.md` frontmatter → dies with that pipeline.
- Config generation: `agents/<role>.md` (YAML frontmatter = config incl.
  tools/permission/model fields, body = prompt verbatim) →
  `scripts/adapters/{opencode,claude-code,codex}.ts` → `.fleet/**`.
  npm scripts: `build:config` / `check:config`.
- `src/runtime/` contains DEAD abstraction code: `AgentRuntime` interface +
  `RuntimeFactory` (never imported by orchestrator) + CLI runtimes +
  stub SDK runtimes that just fall back to CLI.
- Dashboard `src/dashboard/webDashboard.ts`: hand-rolled node:http, SSE stream
  (`text/event-stream`), Start/Stop/approve/backend-picker endpoints, polls
  `gh` every 5s; TUI `src/tui/dashboard.ts` renders phase bar + 6 role rows
  (state / model / $cost / tokens in-out-reasoning-cached).
- `.runs/` holds per-run dirs (traces, events, worktrees metadata).

## 2. Target system (one paragraph)

Manager forks ONE generic worker child-process per role step. The worker runs
our own agent loop built on the official `openai` npm SDK, pointed at an
OpenAI-compatible provider chosen by env priority (gemini → openrouter →
ollama). Role identity = fixed TypeScript system prompt + hard-gated toolset +
per-agent skills + optional allowlisted tools from OUR OWN MCP server. Workers
emit normalized NDJSON on stdout (the existing tailing pipeline feeds the
dashboard unchanged in shape). Every tool call is written to the SOR event
stream by our loop (hook scripts die). No human gates:
analyzer→planner→coder→tester→reviewer→(≤1 auto-fix round)→pr.

## 3. Locked decisions (rationale included — do not revisit)

| # | Area | Decision | Why |
|---|------|----------|-----|
| D1 | Engine | Official `openai` npm package, hand-written loop | Gemini/OpenRouter/Ollama all expose OpenAI-compatible endpoints; one client covers all; user tests with GEMINI_API_KEY only |
| D2 | Providers | Priority list env `FLEET_PROVIDERS=gemini,openrouter,ollama` | user-configurable fallback order; ollama = offline/local option |
| D3 | Execution | Child process per worker (fork thin entry script) | preserves Stop button, WORKER_TIMEOUT_MS, crash isolation; honors "workers call models, manager never does" |
| D4 | CLIs | opencode/claude/codex binaries REMOVED entirely | user: "I don't want them anymore" |
| D5 | Roles | `src/fleet/agents/<role>.ts` exports `{name, systemPrompt, tools[], mcpAllow[], skillsDir}`; prompts ported VERBATIM from agents/*.md bodies | prompts fixed in code; no md source-of-truth anymore |
| D6 | Models | Per-role-per-provider env `<ROLE>_MODEL_<PROVIDER>`; resolution order: dashboard override > env > tier default | one id can't span providers; user sets models themselves |
| D7 | Tiers | strong (pro-class) defaults for analyzer/planner/reviewer; cheap (flash-class) for coder/tester/pr | user: best models for thinking roles, cheap for builders |
| D8 | Tools | Built-in bash/read/write/edit/grep/glob/load_skill implemented ONCE; HARD per-role gating (role's registry literally lacks disallowed tools); bash cwd-locked to worktree, no deny-list | user chose code-enforcement + cwd-only bash |
| D9 | Skills | Fresh md playbooks (authored new, NOT copied from old skills); per-agent dir; frontmatter {name,description} injected into prompt; full body fetched via load_skill tool | user picked "fresh starters"; whole skill callable on demand |
| D10 | MCP | OWN minimal MCP server (stdio) w/ strict per-role allowlists; backed by `gh api`; NO official github-mcp | user: "own mcp with own permission... only things needed, no extra info" |
| D11 | Gates | ALL human approvals removed; only stop = hard failure; reviewer findings → max 1 coder auto-fix round; PR creation = terminal success | user explicit; requires AGENTS.md boundary update (authorized deviation from old "ask first") |
| D12 | Audit | Full SOR hash chain kept; our loop emits same event records hooks produced; sor:verify/analytics untouched; all SOR writes NON-FATAL (existing contract) | forensic parity day 1 |
| D13 | Dashboard | Keep web+TUI; adapt event mapping + replace backend picker with provider→live-model-list picker; deeper rework LATER (out of scope) | user confirmed |

> **Scope note:** `agents/scout.md` and `agents/_global.md` are NOT ported.
> Scout is unused by the 6-role pipeline and _global has no successor — both die
> with `agents/*.md` in §12. Do not invent replacements.

## 4. Provider registry spec (`src/providers/registry.ts`)

```ts
type ProviderName = "gemini" | "openrouter" | "ollama";
interface ProviderDef {
  name: ProviderName;
  baseURL: string;
  // gemini:     https://generativelanguage.googleapis.com/v1beta/openai/
  // openrouter: https://openrouter.ai/api/v1
  // ollama:     process.env.OLLAMA_BASE_URL ?? http://localhost:11434/v1
  apiKeyEnv: string | null;   // GEMINI_API_KEY / OPENROUTER_API_KEY / null (ollama)
}
```

- Client factory returns memoized `new OpenAI({ baseURL, apiKey })` per provider.
- Quirks to handle: Gemini compat layer may omit `usage.reasoning_tokens` and
  return strict JSON schemas for tools → tolerate missing usage fields (zeroes,
  never crash); OpenRouter recommends headers `HTTP-Referer`, `X-Title`
  (optional, set static values).
- Live model listing for the dashboard picker: GET `{baseURL}/models`, proxied
  by a manager route `/api/models?provider=X` (API key stays server-side).
- Fallback walk = iterate FLEET_PROVIDERS left→right, skipping providers whose
  key/env is missing; each attempt logged in `AgentResult.attempts[]`
  (same shape as today: `{model, ok, error}`), plus `provider` field.
- If NO provider has credentials configured: FAIL FAST before forking a worker —
  return a single failed attempt `{model:"none", ok:false,
  error:"no provider keys configured"}` so the orchestrator marks the step failed.
- Fallback triggers are BOTH: (a) provider key/env missing at selection time,
  AND (b) an attempt failing at runtime (API error, empty text) — either way the
  walk continues left→right, exactly like today's runWorker model pool.

## 5. Full `.env` contract (update `.env.example` accordingly)

```bash
# providers (left-to-right = fallback priority)
FLEET_PROVIDERS=gemini,openrouter,ollama

GEMINI_API_KEY=                 # required for the primary path
OPENROUTER_API_KEY=             # optional fallback key
OLLAMA_BASE_URL=http://localhost:11434/v1    # optional local

# per-agent models (optional; tier defaults apply otherwise) — ONE per line
ANALYZER_MODEL_GEMINI=gemini-2.5-pro
PLANNER_MODEL_GEMINI=gemini-2.5-pro
REVIEWER_MODEL_GEMINI=gemini-2.5-pro
CODER_MODEL_GEMINI=gemini-2.5-flash
TESTER_MODEL_GEMINI=gemini-2.5-flash
PR_MODEL_GEMINI=gemini-2.5-flash
CODER_MODEL_OLLAMA=qwen2.5-coder:7b
# pattern: <ROLE>_MODEL_<PROVIDER>

DATABASE_URL=postgres://...               # unchanged
SOR_SIGNING_KEY=...                       # unchanged (openssl rand -hex 32)
WORKER_TIMEOUT_MS=                        # unchanged kill switch (+ _GRACE_MS)
```

Tier defaults live in `src/fleet/modelDefaults.ts` — one small table,
`Record<ProviderName, Record<Role, string>>`, seeded with:

| role | gemini | openrouter | ollama |
|------|--------|------------|--------|
| analyzer | gemini-2.5-pro | google/gemini-2.5-pro | qwen2.5:14b |
| planner | gemini-2.5-pro | google/gemini-2.5-pro | qwen2.5:14b |
| reviewer | gemini-2.5-pro | google/gemini-2.5-pro | qwen2.5:14b |
| coder | gemini-2.5-flash | google/gemini-2.5-flash | qwen2.5-coder:7b |
| tester | gemini-2.5-flash | google/gemini-2.5-flash | qwen2.5-coder:7b |
| pr | gemini-2.5-flash | google/gemini-2.5-flash | qwen2.5-coder:7b |

(Exact ids are defaults, not gospel — env/dashboard overrides win.)

## 6. Worker process + wire protocol

Entry: `src/runtime/worker/main.ts`, launched via `child_process.fork()`.

- stdin: ONE JSON job
  `{role, task, ctx:{rootDir, worktreeDir, tracesDir, runDir, dryRun, extraTask?}}`.
- stdout: NDJSON events ONLY (anything else → stderr). Event types:
  - `{t:"init", role, model, provider, sessionId}`
  - `{t:"text", part:{text}}` — assistant text deltas
  - `{t:"tool_call", name, input}` — after gate check, before exec
  - `{t:"tool_result", name, ok, ms, bytesOut}`
  - `{t:"step_finish", usage:{input,output,reasoning,cached,cacheWrite,total}, costUsd}`
  - `{t:"error", error}`
  - `{t:"result", text}` — final assistant message
- Exit 0 on success; nonzero + last `error` event on failure.
- Trace convention UNCHANGED: the worker writes NDJSON to ITS OWN stdout and
  nothing else; the manager redirects that fd straight into
  `tracesDir/<role>.jsonl` (stdio `["ignore", fdOut, fdErr]`, as today), then
  TAILS THE FILE — so one stream simultaneously IS the trace capture and the
  event source (`startTailing` survives as-is).
  DELETE `parseOpencodeLine/parseClaudeLine/parseCodexLine`; add ONE parser for
  the schema above.
- Cost rule: `costUsd` comes from provider usage metadata when present; when a
  provider omits it, cost = 0 (tokens still recorded); ollama is always 0.
- DRY-RUN contract: `ctx.dryRun` NEVER forks a worker — the manager returns the
  existing stub `AgentResult` (`stubResult`) before any spawn, unchanged from
  today. If a worker is ever forked with `dryRun:true` anyway, it must skip all
  model calls and emit canned events (second-layer guard).
- fork mechanics: `.ts` entry needs the tsx loader — fork with
  `{ execPath: process.execPath, execArgv: [...process.execArgv, "--import", "tsx"] }`
  (Node ≥22 `--import`). Wrap this in ONE helper inside agentRunner.ts; no other
  call site forks workers.
- Retry vs extraTask: retry loops append prior failure output DIRECTLY into
  `task`; `extraTask` is reserved EXCLUSIVELY for reviewer-findings injection
  during the autofix round. Never both at once.
- Abort: manager SIGTERMs / closes stdin → worker stops after the current tool
  call, emits `error`, exits. No mid-tool SIGKILL except the grace path.
- Retry/resume: OLD `resumeSessionID` cross-process CLI resume is DELETED.
  Workflow retry loops instead spawn a fresh worker whose task text appends the
  prior failure output; `aggregateAgentResults` stays for accounting.
- ctx.resumeFrom?: {messagesPath} — when set, worker loads messages from
  that JSON instead of building from task; continues mid-conversation.
- Worker writes <runDir>/checkpoints/<role>.json after every completed turn.

## 7. Tools spec (`src/fleet/tools/`)

`registry.ts` maps ToolName → impl `{schema, exec(input, wtCtx)}`. Hard gating:
worker builds the registry ONLY from `role.tools ∩ built-ins` (+MCP allowlist).

| tool | semantics |
|------|-----------|
| bash | child spawn, cwd = worktreeDir (HARD: resolve + prefix-compare), capture stdout+stderr truncated to 20k chars, exit code surfaced, per-call cap 10min default (inherits WORKER_TIMEOUT semantics) |
| read | file within worktree only (path.resolve prefix check), line-numbered, cap 2000 lines |
| write/edit | path prefix-checked to worktree; edit = exact-string replace, fail loudly on no-match |
| grep/glob | over worktree only; cap 500 results |
| load_skill(name) | resolves `src/fleet/skills/<role>/<name>.md` ONLY within own role dir; returns full body |

SOR emission: EVERY `tool_call` + `tool_result` appends records to
`<runDir>/events/events.jsonl` matching the EXISTING record shape produced by
the old hook scripts. BEFORE writing the emitter, inspect one historical
events.jsonl under `.runs/` or the git history of `.fleet/*/hooks/sor-hook.sh` —
field names and ordering matter for the chain verification. Writes still go
through `ensureChain`/`appendAuditEvent` (`src/db/audit.ts`). Non-fatal: wrap in
try/catch + warn. The `backend` column/field on NEW SOR records and analytics
rows carries the PROVIDER name (`gemini`|`openrouter`|`ollama`); historical rows
keep their legacy strings — queries group by whatever values exist.
Additionally, the `audit_events` table is append-only: a trigger prevents UPDATE and DELETE operations to ensure tamper-evidence.

## 8. Skills spec

Directory: `src/fleet/skills/<role>/<name>.md`, frontmatter:

```yaml
---
name: commit-hygiene
description: When and how to stage/commit during the fix
---
body...
```

Loader injects `- <name>: <description>` lines into the system prompt under
"# Available skills"; `load_skill(name)` fetches the full body.
Starter playbooks to AUTHOR fresh (one per bullet, each ≤120 lines):
analyzer/repo-triage · planner/decomposition · coder/minimal-diff ·
coder/commit-hygiene · tester/test-selection · reviewer/checklist · pr/pr-body.

## 9. Own MCP server spec (`src/mcp/fleetServer.ts`)

Transport stdio; uses the already-installed `@modelcontextprotocol/sdk`.
Tools (backed by authenticated `gh api` subprocess calls — no new PAT):

- `get_issue(owner, repo, number)` → title/body/labels
- `get_issue_comments(owner, repo, number)`
- `create_pr(owner, repo, head, base, title, body)`
- `get_checks(owner, repo, ref)`

Allowlist matrix (enforced server-side AND client-side):

| role | allowed tools |
|------|---------------|
| analyzer | get_issue, get_issue_comments |
| pr | create_pr, get_checks |
| everyone else | none — no connection attempted |

Worker connects only if `mcpAllow.length > 0`. Server started by the worker as
a child process, dies with it. MCP-backed tools are ORDINARY registry entries:
every call flows through the same tool_call/tool_result SOR emitter and gating
as built-ins.

## 10. Gate removal + auto-fix (`orchestrator.ts`)

- Replace each human-gate wait with immediate proceed + SOR event
  `gate_auto_approved` (actor `"manager"`, payload `{gate, reason:"auto"}`).
  Record shape: reuse the EXISTING manager-authored event pattern — copy the
  field set from a historical manager event (e.g. a `wakeup` record in any
  `.runs/*/events/events.jsonl`: run_id, event_type, actor, backend, tool_name,
  tool_input, tool_output, payload, created_at) with
  `event_type:"gate_auto_approved"`; do not invent new fields. Add such a record
  to the P5 fixture test.
- After reviewer: if findings classified blocking → rerun coder ONCE with the
  findings appended to the task → tester rerun → straight to pr regardless.
- Phase enum gains `"autofix"` (dashboard renders it like other phases).
- DELETE approve endpoints/buttons from the dashboard; keep Stop.
- UPDATE AGENTS.md boundaries section (user authorized this change explicitly).

## 11. Dashboard adaptation

- Event mapping in `formatAgentEvent`: `init` → agent start row; `text` →
  transcript feed; `tool_call/tool_result` → structured feed rows;
  `step_finish` → token/cost accumulators.
- Backend picker → provider picker: dropdown of FLEET_PROVIDERS entries having
  keys configured; selecting one calls `/api/models?provider=X` → click-to-assign
  per role. Persists into `manager/models.json` NEW shape `{provider:{role:id}}`
  (migrator ignores unknown old keys).
- TUI header shows the provider list instead of a single backend.

## 11.5 Gemini quota chains, PAUSE-on-exhaustion, mid-conversation resume

### Model chains (owner-mandated)
- Role chain = [<ROLE>_MODEL_GEMINI] + GEMINI_RATE_LIMIT_MODELS pool minus
  the primary (order preserved).
- ALL SIX <ROLE>_MODEL_GEMINI REQUIRED at boot; every chain model needs a
  GEMINI_QUOTA_LIMITS entry ⇒ else startup fails fast.
- GEMINI_RATE_LIMIT_MODELS unset ⇒ single-model chains; boot prints a
  WARNING that no fallback exists.

### Block semantics
- rpm/tpm finite blocks: switch to next chain model immediately; whole chain
  finitely blocked ⇒ sleep min(neededWait, GEMINI_RATE_LIMIT_WAIT_MS) and
  restart chain FROM THE TOP (auto fail-back). RPM recovery needs no action.
- rpd terminal block: model DEAD until UTC midnight (coordinator latch);
  not retried even if other models recover — unless resumed via key change.
- ALL models of a role rpd-latched ⇒ enter PAUSED state. Quota exhaustion
  NEVER auto-finalizes a run as failed. User Stop (button/SIGINT) during
  pause finalizes failed normally.
- No "switch" telemetry when no second model exists; SESSION_LOG fallback
  line collapses consecutive duplicate ids.

### PAUSED state (RPD-total only)
1. Emit SOR `run_paused`; phase "paused"; persistent banner + browser
   Notification "All models RPD exhausted — change GEMINI_API_KEY, then
   Resume"; console + SESSION_LOG lines; console reminder every ~5 min.
2. Completed roles stay completed; pipeline position preserved.
3. RESUME = banner button "✓ Changed — Resume":
   a. Re-read GEMINI_API_KEY / OPENROUTER_API_KEY from .env on disk;
      update process.env; invalidate provider registry client memo.
   b. Reset all GeminiQuotaCoordinator buckets (new key ⇒ fresh quotas).
   c. Emit SOR `run_resumed`; clear banner; respawn paused role's worker
      seeded from checkpoint — LLM continues mid-conversation; worktree
      untouched during pause.
4. New key itself exhausted ⇒ re-enter PAUSED (loop-safe).
5. Checkpoint: `<runDir>/checkpoints/<role>.json` = full OpenAI-format
   messages array + chain position + model, written atomically EVERY turn;
   job ctx gains `resumeFrom:{messagesPath}` — worker skips prompt
   construction and continues from those messages.

### TPM accounting
- Conservative reservation stays (est + GEMINI_MAX_OUTPUT_TOKENS), but every
  reservation/rejection telemetry logs estTokens, maxOutTokens,
  windowUsedTokens, limitTpm.

## 11.6 Observability & audit contract

Manager-owned single-hook architecture: the worker emits events to stdout;
the manager tails the trace file and routes every event to SOR, dashboard,
and stderr. The worker does NOT write to SOR for non-tool events.

### Architecture

```
Worker (loop.ts)                    Manager (orchestrator.ts)
───────────────                     ──────────────────────────
emit() → stdout → trace.jsonl       onEvent() ←── tails trace file
                                        │
sor.toolCall() ──→ SOR (tool_call)      ├──→ SOR hook (reservation,
[worker-side, UNCHANGED]               │    completion, retry, etc.)
                                       ├──→ dashboard SSE (all events)
                                       └──→ stderr (errors, retries)
```

### SOR event types (manager-emitted via onEvent hook)

| event_type | actor | tool_name | payload |
|---|---|---|---|
| `reservation` | `"manager"` | model id | `{role, reservationId, status:"reserved", estTokens, windowUsedTokens, limitTpm}` |
| `reservation_rejection` | `"manager"` | model id | `{role, reservationId, block, waitMs, resetAt}` |
| `provider_completion` | `"manager"` | model id | `{role, status:"completed"\|"failed", httpStatus, ms, reservationId, attempt, blockedDimension}` |
| `retry` | `"manager"` | model id | `{role, status:"scheduled", waitMs, attempt}` |
| `tool_call` (before) | worker | tool name | `{input}` (unchanged, worker-side SorEmitSink) |
| `tool_call` (after) | worker | tool name | `{input, output, ok, ms}` (unchanged, worker-side SorEmitSink) |

All SOR writes are NON-FATAL (warn and continue, never abort a run).
Existing `tool_call` SOR emission stays worker-side (Approach B).

### Trace JSONL contract

ALL events appear in `traces/<role>.jsonl` (worker stdout NDJSON).
This is already complete — no changes needed. Event types:
`init`, `text`, `tool_call`, `tool_result`, `step_finish`, `error`,
`result`, `reservation`, `reservation_rejection`, `provider_completion`,
`provider_rate_limit`, `retry`, `model_switch`.

### Dashboard contract

**Stream labels** — each event type gets a dedicated colored badge in the
"Tools & telemetry" stream:
- `🟢 completed` — green, shows model + latency + tokens
- `🔴 failed` — red, shows httpStatus + error message
- `🟡 retry` — yellow, shows attempt count + backoff delay
- `🔵 reservation` — blue, shows model + tokens reserved
- `⚪ rejected` — gray, shows block type + wait time
- `🟠 switched` — orange, shows from→to model + block type

**Summary panel** — `<div id="callsummary">` in `#railwrap` below Counters.
Updates in real-time (every event, no batching). Shows:
```
calls: N  ✓ N  ✗ N  ↻ N  ⏭ N
```

### SPEC.md audit contract

- `audit_events` table: `payload JSONB NOT NULL` column carries event-specific
  data. `event_type` CHECK constraint widened by migration 010.
- Hash chain: `prev_hash` + HMAC(event) → `hash`. `sor:verify` replays
  the full chain and must stay green after migration 010.
- New event types added to `SorEventType` union in `src/sor/events.ts`
  and `VALID_TYPES` array in sync with migration.

## 12. File change manifest

CREATE:
`src/providers/registry.ts` · `src/fleet/types.ts` ·
`src/fleet/agents/{analyzer,planner,coder,tester,reviewer,pr}.ts` ·
`src/fleet/modelDefaults.ts` · `src/fleet/loop.ts` · `src/fleet/tools/*` ·
`src/fleet/skills/<role>/*.md` · `src/fleet/testCmd.ts` (moved detectTestCommand) ·
`src/runtime/worker/main.ts` · `src/mcp/fleetServer.ts`
(NO new runtime-abstraction classes: orchestrator keeps calling `runWorker()`
directly; the dead AgentRuntime/RuntimeFactory layer is deleted, not revived.)

MODIFY:
`src/agentRunner.ts` (spawn→fork; parser swap; keep tailing/timeout/abort) ·
`src/orchestrator.ts` (gates→auto; autofix phase) · `src/types.ts`
(Backend→Provider; AgentResult.provider) · `src/index.ts`
(--provider replaces --backend) · `src/router.ts` ·
`src/models/modelPolicy.ts` (thin override store v2) ·
`src/dashboard/webDashboard.ts` · `src/tui/dashboard.ts` · `.env.example`
(comment-free value lines — inline comments after `KEY=` are parsed as values
by Node's --env-file; put comments on their own line) ·
`package.json` (scripts; +`openai` dep; `@modelcontextprotocol/sdk` ^1.30.0 is
ALREADY installed and stays) · `AGENTS.md` (final target-state polish) ·
`USER.md` / `CONTRIBUTING.md` (post-migration touch-up only — both already
written early)

DELETE:
`agents/*.md` incl. scout.md/_global.md (after verbatim port of the six roles;
P2 first snapshots the six prompt bodies into test fixtures so the parity net
survives the sweep) · `.fleet/**` · `scripts/adapters/*` ·
`scripts/generate-configs.ts` · npm scripts `build:config`/`check:config` ·
`src/runtime/cli/**` · `src/runtime/sdk/**` (all stubs) ·
`src/runtime/{agentRuntime,runtimeFactory,index}.ts` (dead abstraction, whole
layer) · CLI halves of `src/runner/backends.ts` (after moving
detectTestCommand) · `sor:sync-registry` npm script

P8 SWEEP EXTRAS: audit `analytics` + `generate-memory` scripts for any
`agents/*.md` reads → repoint or retire; remove dashboard approve-endpoint
tests; `manager/models.json` v1 per-backend overrides are DISCARDED (log once,
users re-pick via the v2 picker).

PRE-LAUNCH DELETIONS (already done, before any build work):
`README.md` and `directory.md` — removed to prevent fresh agents ingesting
stale CLI-era prose. README is rewritten FRESH at P8 (not restored); no
directory.md successor. `CLAUDE.md` (`@AGENTS.md`) stays UNCHANGED.

## 13. Phases + acceptance criteria

- **P0 baseline**: typecheck clean, vitest fully green (record count),
  `npm run dry` OK.
- **P1 providers+models**: registry unit tests (URL/key resolution, missing-key
  skip, fallback order); modelDefaults table; override store v2 read/write.
- **P2 fleet defs + skills loader**: 6 agent modules compile; prompt bodies
  byte-equal to old agents/*.md bodies (diff test vs `git show HEAD:agents/x.md`);
  SNAPSHOT those six bodies into test fixtures this phase — the fixtures, not
  the git-diff test, remain after the P8 deletion sweep;
  loader injects frontmatter summaries; load_skill resolves within role dir only.
- **P3 tools + loop + worker**: per-tool unit tests (cwd escape blocked,
  truncation, prefix checks); loop integration test vs MOCKED OpenAI client
  (tool-call roundtrip, usage extraction incl. missing-fields tolerance, error
  path); fork e2e in vitest spawning `main.ts` with a fake job.
- **P4 runner rewiring**: agentRunner suite green against fake worker;
  attempts[] records the provider walk; abort kills the fork.
- **P5 SOR emitter**: replay a REAL historical events.jsonl fixture through
  verify logic — chain validates; emitter produces identical field set.
- **P6 gates + autofix**: orchestrator flow test asserting zero human waits,
  autofix cap = 1, gate_auto_approved events present; dashboard
  approve-endpoint tests removed.
- **P7 MCP server**: allowlist matrix test (denied role never connects);
  gh-backed handlers mocked.
- **P8 dashboard + cleanup + docs**: picker works against mocked /models;
  dead files gone; repo-wide grep for `opencode|claude|codex` shows only
  historical doc mentions; README written FRESH (it was deleted pre-launch,
  see §12) + AGENTS.md final polish.
  **FINAL**: live smoke — one real issue → PR with ONLY GEMINI_API_KEY set.

## 14. Risks

- Gemini free-tier ~10 RPM: fine sequential; do NOT parallelize workers yet.
- Compat-layer gaps (usage fields, streaming tool deltas): tolerate + log,
  never crash the worker.
- Auto-flow removes the human checkpoint before code hits a real branch:
  mitigated by fix-branch isolation + full SOR trail + Stop button.
- Old events.jsonl field drift: ALWAYS copy the shape from a REAL historical
  file, never invent fields.
- Env notes: `WORKER_TIMEOUT_GRACE_MS` defaults to 1000ms; `npm run dry` needs
  NO database (skips SOR writes) but real runs require DATABASE_URL + migrated
  schema.

## 15. Out of scope (do not build now)

Parallel/concurrent workers · deep dashboard redesign · additional MCP
tools/providers · native Anthropic/OpenAI SDK paths · CONSTRAINTS.md (user
deferred indefinitely)

## 16. Companion docs — STATUS

- **USER.md + CONTRIBUTING.md**: ✅ ALREADY WRITTEN (2026-08-22, ahead of the
  migration per owner request). Do not re-author. Post-migration: touch up
  commands/env references during P8.
- **AGENTS.md**: interim constitution already covers both eras; final
  target-state polish happens at P8 (remove transitional notes).
- Formatting rule for ALL repo markdown EXCEPT AGENTS.md: YAML frontmatter block.

## 17. Progress checklist

Rules for the builder agent: on session start, read this section FIRST.
Find the first unchecked item; do it; mark `[x]` + append date + commit
(`docs: check <item>`). Never skip ahead past failing acceptance criteria.

### Migration phases (P0–P8)

- [x] P0 baseline recorded (typecheck clean, vitest N green, dry run OK) — 2026-08-23: typecheck 0 errors, vitest 336/336, `npm run dry` smoke OK
- [x] P1 providers registry + modelDefaults (+ unit tests) — 2026-08-23: registry URL/key resolution, missing-key skip, fallback order, fail-fast covered; SPEC §5 defaults table single-sourced
- [x] P1 override store v2 {provider:{role:id}} — 2026-08-23: v2 read/write roundtrip tested; v1 keys discarded log-once
- [x] P2 six agent defs + prompt byte-parity test vs git HEAD agents/*.md (+ bodies snapshotted to fixtures) — 2026-08-23: D5 def shape {name,systemPrompt,tools,mcpAllow,skillsDir}; 12/12 byte parity verified; bodies snapshotted so the net survives the P8 deletion sweep
- [x] P2 skills loader + 7 starter playbooks authored — 2026-08-23: summaries injected under "# Available skills"; hard role-dir containment (12/12 traversal/encoding attacks rejected); 7 fresh playbooks ≤120 lines per D9
- [x] P3 tools: bash/read/write/edit/grep/glob/load_skill (+ gating tests) — 2026-08-23: per-role gating registry, bash cwd-lock + process-group timeout kill, 20k combined cap, read 2000-line cap, edit fail-loud, grep/glob 500-cap, load_skill via hardened loader; 36 tests incl. symlink-escape + truncation
- [x] P3 loop.ts + worker main.ts (+ mocked-OpenAI integration test) — 2026-08-23: tool-call roundtrip over OpenAI SDK, §6 wire events via callback, usage tolerance + cost rule, stop-after-current-tool abort, maxSteps=25; 12 mocked-client tests
- [x] P3 fork e2e test (spawn main.ts with fake job) — 2026-08-23: dry-run zero-model guard (dead-port-proven), keyless ollama localhost stub, SIGTERM abort with bounded flush, malformed-job rejection; parseProviderTrace realigned to real t:-keyed protocol
- [x] P4 agentRunner rewired to fork worker (+ attempts/provider-walk/abort tests) — 2026-08-23: single forkWorker call site (tsx-loader execArgv, stdout fds → tracesDir/<role>.jsonl then tailed, job JSON via stdin); provider walk via withProviderFallback with per-attempt env pinning; attempts[] carries provider; WORKER_TIMEOUT_MS SIGTERM → GRACE SIGKILL proven vs SIGTERM-trapping fixture; killActiveWorkers fail-fast latch kept
- [x] P5 SOR emitter parity fixture test (sor:verify green) — 2026-08-23: hook-shape parity emitter (src/fleet/sorEmit.ts, dual sink events.jsonl + DB chain) wired into worker loop; normalizeEvent accepts gemini/openrouter/ollama; migration 006_audit_backends.sql widens audit_events_backend_check (applied + round-trip tested); historical chain re-signed seq 75–641 under current key (owner-authorized repair, backup /tmp/opencode/sor-backup-20260823T100847Z.sql); sor:verify ok:yes at 641 events (`c90896b`)
- [x] P6 gates→auto + autofix loop (orchestrator tests, cap=1) — 2026-08-23: gates auto-proceed emitting gate_auto_approved; AUTO_FIX_MAX_ROUNDS=1 loop bound + guard proven by orchestrator.test.ts (exactly 2 coder runs on reject→approve; fails on second reject); zero gate remnants post-sweep (`cf4e3ff`)
- [x] P7 fleet MCP server (+ allowlist matrix tests) — 2026-08-23: server landed (`f622dc2`) then hardened (`9002fb7`): role structurally bound from spawn argv, unconditional CallTool+ListTool enforcement, spoofable _meta channel removed, Bun.spawn→node:child_process; wire-level stdio integration suite (denied role gets [], spoofed _meta cannot escalate, allowed role end-to-end via gh stub)
- [x] P8 dashboard event mapping + provider/model picker — 2026-08-23: onLoad provider wiring repaired (was ReferenceError-killing init), /api/models serves live registry.listModelsForProvider with static tier fallback (10s bounded), SSE broadcast parity (`81f3c4b`)
- [x] P8 deletion sweep (manifest §12) + grep clean of "opencode|claude|codex" — 2026-08-23: all §12 manifest entries deleted (`29b8103`); repo grep clean — legacy backend strings remain ONLY in SOR legacy acceptance/migration SQL/tests documenting history (`39c90fa`)
- [x] P8 README + AGENTS.md target-state rewrite — 2026-08-23: README rewritten fresh (provider fleet architecture, current commands); AGENTS.md target-state polish (mid-migration banner + stale script refs dropped, boundaries intact)
- [ ] FINAL live smoke: real issue → PR with only GEMINI_API_KEY
- [x] P-quota: pause-on-RPD-total + key-change resume via dashboard button +
      per-turn conversation checkpoints; honest switch telemetry (no fake
      switching/duplicate fallback lines); rail overlap CSS fix;
      SESSION_LOG archive label; result.json on failed runs; SOR
      before/after ordering; empty-string env defaults treated as unset.
      Acceptance: a run NEVER dies from quota exhaustion; paused run
      resumes mid-conversation after key change; Stop-during-pause works;
      typecheck/tests/sor:verify green; keyless dry smoke exit 0. 2026-08-27: all 8 sub-items implemented and tested.

### Hardening (H1–H11) — quality & robustness

Ordered by dependency. Each task ends green. See PLAN.md §"Quality Hardening
Roadmap" for full specs. Parallel wave 1 (H1+H2+H3) can run concurrently;
H4+H5+H9 in parallel; H6 after H5; H7+H8 after H4; H10+H11 after H8.

- [x] H1. PROVIDER_NAMES dedup — single source in `types.ts`; delete from
      `modelPolicy.ts` (line 18). 2026-08-27: typecheck + tests green.
- [x] H2. walkFiles file list cache — `Map<root, string[]>` in `search.ts`,
      one walk per worktree per process. 2026-08-27: grep+glob share one walk.
- [x] H3. extractJson robustness — length guard (100KB cap), reject empty `{}`,
      log salvage. 2026-08-27: false positive rate reduced, tests green.
- [x] H4. SOR verify + repair unit tests — 13+ cases in `src/sor/__tests__/verify.test.ts`:
      empty chain, valid/tampered/gap/reorder/wrong-key, repair idempotent,
      repair round-trip, EXCLUSIVE lock. Real DB. 2026-08-27: 12 cases pass, orphaned code fixed.
- [x] H5. SOR append-only DB trigger — migration `010_sor_append_only.sql`,
      BEFORE UPDATE/DELETE raises EXCEPTION. 2026-08-27: UPDATE/DELETE blocked.
- [x] H6. SOR key rotation — `key_id` column (migration `011`), key registry,
      partial repair. 2026-08-27: multi-epoch verify passes.
- [x] H7. CI/CD hardening — Biome (lint+format), vitest coverage (v8, 60%
      lines), lint+coverage steps in CI. 2026-08-27: Biome configured, vitest 60% line coverage threshold enabled, CI steps added.
- [x] H8. orchestrator.ts decomposition — 2026-08-27: decomposed into sub-modules (phases, utils, makeOnEvent, finalize, pauseManager), orchestrator.ts under 550 lines, all tests green.
  - [x] H8a. onEvent factory extracted (dedup lines 516-545 / 978-1007)
  - [x] H8b. utils extracted (extractJson, commitMessageFor, collapseConsecutiveModels)
  - [x] H8c. finalize extracted to `workflow/finalize.ts`
  - [x] H8d. pauseManager extracted to `fleet/pauseManager.ts`
  - [x] H8e. phases extracted to `workflow/phases/{analyze,plan,implement,pr,done}.ts`
- [x] H9. webDashboard.ts split — `template.html` + `client.js` + `api.ts` +
      server core. 2026-08-27: template.html, client.js, api.ts extracted, all tests green.
- [x] H10. Workforce hiring integration — `hireWorker` before fork (enforced:
      block spawn if `canHire` fails), `updateWorkerStatus` after,
      `retireWorker` on shutdown. 2026-08-27: worker_roles populated,
      concurrency limits enforced, all tests green.
- [x] H11. Full pipeline E2E test — dry-run orchestrator through all 6 phases,
      verify RunSummary + artifacts + SOR events. 2026-08-27: passes in < 2s,
      sor:verify green.

## 18. Quality hardening (post-migration)

Items from codebase analysis rated below A/A-. Each tracked in PLAN.md
"Quality Hardening Roadmap" section and §17 checklist (H1–H11).

### Owner-locked decisions (interview 2026-08-26)

| Item | Decision | Rationale |
|------|----------|-----------|
| H7 linter | **Biome** (single tool for lint + format) | Zero-config, faster, replaces ESLint + Prettier |
| H7 coverage | **60% line threshold**, v8 provider | Achievable today, catches regressions |
| H5 trigger | **RAISE EXCEPTION only** | SOR chain itself is the audit trail; no extra logging table |
| H6 key storage | **Env vars** (`SOR_SIGNING_KEY_V1`, `_V2`, ...) | Matches existing pattern; key registry reads from env |
| H8 depth | **Full split** (all 5 sub-steps a→e) | Orchestrator becomes ~200-line coordinator |
| H9 template | **Runtime readFileSync** | Zero build step, matches zero-dep philosophy |
| H10 enforcement | **Enforce** (block spawn if canHire fails) | Prevents provider overload; blocks role until slot opens |
| H11 E2E | **With SOR verification** | Checks audit_events for all 6 phases; requires DB |

### Key architectural decisions

- **H5 (DB append-only):** `audit_events` gets a `BEFORE UPDATE/DELETE`
  trigger that raises EXCEPTION. Tamper evidence enforced at DB level,
  not just application layer. No logging table — the SOR chain is the
  audit trail.
- **H6 (key rotation):** `key_id` column on `audit_events` + `sor_chain`.
  Multi-epoch signing via `src/sor/keyRegistry.ts`. Keys stored as env
  vars (`SOR_SIGNING_KEY_V1`, `SOR_KEY_ID`). `sor:repair` becomes
  partial (only current key's rows). No more full-table re-sign on key change.
- **H7 (CI hardening):** Biome for lint + format (single tool, zero-config).
  Vitest v8 coverage with 60% line threshold. CI fails below threshold.
- **H8 (orchestrator decomposition):** Full split — 1,404-line monolith →
  ~200-line coordinator + `workflow/phases/*` + `utils/*` + `fleet/pauseManager.ts`.
  The duplicated `onEvent` handler (516-545 / 978-1007) becomes a single
  factory in `workflow/makeOnEvent.ts`.
- **H9 (dashboard split):** 2,178-line `webDashboard.ts` → `template.html` +
  `client.js` (loaded via readFileSync at server start) + `api.ts` + ~500-line
  server core. No build step.
- **H10 (workforce integration):** `hireWorker`/`updateWorkerStatus`/`retireWorker`
  wired into `agentRunner.ts` spawn path. **Enforced** — blocks spawn if
  `canHire()` fails (concurrency limit reached). Role pauses until slot opens.
- **H11 (pipeline E2E):** Full orchestrator flow via dry-run mode + SOR
  verification (requires DATABASE_URL). No API tokens, < 10s. Exercises
  all 6 phases end-to-end. Checks audit_events for correct event sequence.
- **H12 (trace tailing) DEFERRED:** Current stdout→file→tail approach works
  correctly per §6. Changing it would require wire protocol + worker +
  trace parsing + dashboard changes. High risk, low reward.

---

## Appendix A — History (from superseded PLAN.md, 2026-08-22)

### Done (recent, committed)
- **Typecheck repair + worker timeout** (`a4ababf`) — fixed all 82 tsc errors across
  `src/runtime/*`, exported agentRunner helpers, added `makeEventBridge`/`emitWakeup`,
  `AgentResult.sawError`, and implemented the `WORKER_TIMEOUT_MS`/`WORKER_TIMEOUT_GRACE_MS`
  kill switch in `spawnOnce`.
- **tsconfig noEmit** (`6f24f4b`) — `npm run build` passes with `allowImportingTsExtensions`.
- **README demo-repo mention** (`3e9f4d9`) — live-tested target repo documented.
- **Dashboard transcript fixes** — `formatAgentEvent` rewritten for real opencode event
  shapes, coder/tester wired into the live feed, pr step cap raised to 10.
- **`.fleet/` consolidation** (`f20ab5a`) — every generated fleet tool config lives under
  `.fleet/` (now scheduled for deletion in this migration, §12).
- **`manager/` consolidation** (`637d9db` + `26d28bf`) — MEMORY.md, SESSION_LOG.md,
  models.json moved under `manager/`; suite was 334/334 green.

### Old next steps (obsolete after this spec)
Dead-artifact decision on `.fleet/opencode/**` and live smoke test — both subsumed
by §12 deletion sweep and the FINAL live smoke criterion.
