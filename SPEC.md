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

- [x] P0 baseline recorded (typecheck clean, vitest N green, dry run OK) — 2026-08-23: typecheck 0 errors, vitest 336/336, `npm run dry` smoke OK
- [x] P1 providers registry + modelDefaults (+ unit tests) — 2026-08-23: registry URL/key resolution, missing-key skip, fallback order, fail-fast covered; SPEC §5 defaults table single-sourced
- [x] P1 override store v2 {provider:{role:id}} — 2026-08-23: v2 read/write roundtrip tested; v1 keys discarded log-once
- [x] P2 six agent defs + prompt byte-parity test vs git HEAD agents/*.md (+ bodies snapshotted to fixtures) — 2026-08-23: D5 def shape {name,systemPrompt,tools,mcpAllow,skillsDir}; 12/12 byte parity verified; bodies snapshotted so the net survives the P8 deletion sweep
- [x] P2 skills loader + 7 starter playbooks authored — 2026-08-23: summaries injected under "# Available skills"; hard role-dir containment (12/12 traversal/encoding attacks rejected); 7 fresh playbooks ≤120 lines per D9
- [ ] P3 tools: bash/read/write/edit/grep/glob/load_skill (+ gating tests)
- [ ] P3 loop.ts + worker main.ts (+ mocked-OpenAI integration test)
- [ ] P3 fork e2e test (spawn main.ts with fake job)
- [ ] P4 agentRunner rewired to fork worker (+ attempts/provider-walk/abort tests)
- [ ] P5 SOR emitter parity fixture test (sor:verify green)
- [ ] P6 gates→auto + autofix loop (orchestrator tests, cap=1)
- [ ] P7 fleet MCP server (+ allowlist matrix tests)
- [ ] P8 dashboard event mapping + provider/model picker
- [ ] P8 deletion sweep (manifest §12) + grep clean of "opencode|claude|codex"
- [ ] P8 README + AGENTS.md target-state rewrite
- [ ] FINAL live smoke: real issue → PR with only GEMINI_API_KEY

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
