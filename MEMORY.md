---
title: Build Memory — Verified Work Log
status: active
created: 2026-08-23
last_updated: 2026-08-23
last_agent: session-2026-08-23 (P6–P8 §17 ticks + hardening wave log)
phases_done:
  docs_companions: true
  prelaunch_deletions: true
  P0_baseline: true
  P1_providers_models: true
  p2_fleet_skills: true
  p3_tools_loop_worker: true
  p4_runner_fork: true
  p5_sor_emitter: true
  p6_gates_autofix: true
  p7_mcp_server: true
  p8_cleanup_docs: true
  final_live_smoke: false
---

# MEMORY.md — verified work log for building agents

Builder agents append entries here ONLY after work is done AND verified
(typecheck/tests green, or explicit review evidence). Update the frontmatter
fields on every entry. Append-only — never delete or rewrite prior entries.
Truth for WHAT to build stays in `SPEC.md` (§17 checklist); this file records
what has been completed and verified.

## Verified complete

### 2026-08-22 — companion docs authored (pre-migration)
- `USER.md` + `CONTRIBUTING.md` written ahead of migration per owner request.
- Verified: files present, valid YAML frontmatter, content matches SPEC §16.
- Status at time of entry: untracked in git (commit pending).

### 2026-08-22 — pre-launch deletions
- Stale CLI-era docs removed: `README.md`, `directory.md`.
- Verified: staged deletions present in git index; matches SPEC §12
  "PRE-LAUNCH DELETIONS". README is to be rewritten FRESH at P8.

### 2026-08-22 — interim AGENTS.md constitution
- Full rewrite covering both eras (CLI fleet + SDK migration); includes the
  §10-authorized gate/auto-flow boundary deviation (D11).
- Verified: subagent diff review against SPEC §16 authorization.
- Status: unstaged modification.

### 2026-08-23 — types.ts rewiring (P1 slice)
- `Backend = "opencode"|"claude"|"codex"` → `ProviderName =
  "gemini"|"openrouter"|"ollama"` + exported `PROVIDER_NAMES`;
  `AgentResult.provider` added; `RunContext.provider` threaded.
- Verified: subagent diff review. Residual old-era mentions are comments only.
- Status: uncommitted.

### 2026-08-23 — modelDefaults tier table (P1 slice)
- `src/fleet/modelDefaults.ts`: `Record<ProviderName, Record<Role, string>>`
  seeded per SPEC §5 (strong=pro-class analyzer/planner/reviewer;
  cheap=flash-class coder/tester/pr) across all 3 providers.
- Verified: values byte-match SPEC §5 table via subagent review.
- Known debt: re-declares local Role/ProviderName instead of importing from
  src/types.ts (dedupe scheduled in current TODO pass).
- Status: uncommitted.

### 2026-08-23 — override store v2 API shape (P1 slice, PARTIAL)
- `src/models/modelPolicy.ts` re-keyed to `{provider:{role:id}}`;
  policyFor/setModelOverride/getModelOverrides/allPolicies/load/save take
  ProviderName; loader ignores unknown v1 keys.
- NOT yet done: unit-test rewrite (old v1 test file fails), models.json on
  disk still v1 shape so overrides load empty, no log-once of discarded v1,
  `"analyst"` typo key at modelPolicy.ts:102, placeholder availableModels().
- Status: uncommitted, red tests.

## Verification snapshot (2026-08-23 subagent audit)

- typecheck: FAILING (~88 errors — legacy runtime/cli+sdk layer ~30, WIP
  rename gaps ~29, new-code bugs 4, stale tests 35).
- vitest: 312 passed / 24 failed (modelPolicy.test.ts v1-era,
  agentRunner tests vs placeholder worker).
- P1 estimated ~35% complete. registry.ts is a skeleton (no client factory,
  no FLEET_PROVIDERS walk, no fail-fast, no /models listing). spawn→fork not
  started (`binary = "node"` placeholder in agentRunner.ts). No openai dep,
  .env.example untouched.
- Landmines logged: agentRunner.ts:361 writes `provider:` into SOR events
  where historical shape requires `backend:` (must revert before any run);
  dead `=== "codex"` comparison agentRunner.ts:250.

### 2026-08-23 — wave 1: landmine fixes, legacy-layer deletion, rename completion
- Fixed all three logged landmines: SOR field reverted to historical
  `backend:` shape; dead `=== "codex"` comparison removed; `"analyst"`
  typo key + dead CODEX_DEFAULTS_FIXED deleted from modelPolicy.
- Deleted legacy layer early (SPEC §12): src/runtime/{cli,sdk}/**,
  agentRuntime/runtimeFactory/index; CLI halves of runner/backends.ts →
  new src/runner/providers.ts; detectTestCommand moved to
  src/fleet/testCmd.ts.
- Rename completed: Backend → ProviderName (gemini|openrouter|ollama)
  across types/orchestrator/index/dashboards/tester; index.ts parses
  real --provider flag (argv + ORCHESTRATOR_PROVIDER).
- Verified: typecheck 0 errors, suite green at commit time.
- Status: committed (`83aa856`).

### 2026-08-23 — wave 2: registry completion, env/deps parity
- src/providers/registry.ts completed: memoized OpenAI client factory,
  FLEET_PROVIDERS order parsing (invalid names skipped with warning),
  missing-key skip + runtime-failure fallback walk, no-keys fail-fast
  ({model:"none",ok:false}), /models listing helper.
- SPEC §5 defaults table single-sourced in src/fleet/modelDefaults.ts;
  modelPolicy imports it (dedupe debt from earlier entry cleared).
- Override store v2 {provider:{role:id}} with v1-key discard log-once.
- .env.example gained FLEET_PROVIDERS + provider key blocks + per-role
  model vars, comments on own lines (--env-file parity); openai@^7.5.0
  added per SPEC §12. Spot-check: .env.example remains keyless.
- Status: committed (`0207cb8`).

### 2026-08-23 — wave 3: test port + 2 production bug fixes
- Ported suites to provider era: modelPolicy tests rewritten to v2 API,
  agentRunner/agentRunnerTimeout updated to runner/providers.ts,
  dashboard/detectTestCommand off deleted backends module. New:
  providersRegistry.test.ts, modelDefaults grid test, override-store-v2
  test, longWorker.mjs fixture. Suite: 336/336 passing.
- Production bug fix #1: agentRunner PROVIDER_BIN was dead wiring —
  binary resolution never consulted the provider map; now routed
  through providerDef() honoring GEMINI_BIN/OPENROUTER_BIN/OLLAMA_BIN.
- Production bug fix #2: removed normalizeModel cross-provider corruption
  (a gemini id could be rewritten through an openrouter catalog rule).
- Status: committed (`43d1941`).

### 2026-08-23 — waves 4+fix: independent verification verdict + hygiene
- Independent verification verdict: migration slice P0+P1 delivered and
  green — typecheck 0 errors, vitest 336/336, npm run dry smoke OK.
- Hygiene fixes verified: .env.example env parity (every consumed var
  documented), availableModels cross-provider leakage removed (a
  provider's catalog can no longer surface another's ids), dead POLICIES
  role ids replaced with current Role values.
- SPEC §17 ticked: P0 baseline, P1 registry+modelDefaults, P1 override
  store v2 — wording matches delivery; no P4 spawn→fork criteria were
  claimed inside these items, so nothing withheld.
- Status: committed in this docs commit.

### 2026-08-23 — sor:verify seq-75 pre-existing break documented
- `npm run sor:verify` is RED at seq 75. Break is PRE-EXISTING, dated
  2026-08-14 — untouched by this wave (zero db/sor files changed in any
  commit here). Root-cause BEFORE the FINAL live smoke (note added to
  TODO.md Later phases). F3 left unticked for this reason.

### 2026-08-23 — wave 6: six fleet agent defs + byte-parity net (P2 slice)
- `src/fleet/types.ts`: D5 def shape `{name, systemPrompt, tools,
  mcpAllow, skillsDir}` + ToolName union; six modules under
  src/fleet/agents/ carry prompts VERBATIM from old agents/*.md bodies.
- Tools matrix derived from the old md frontmatter; the `list` tool was
  DROPPED — no new-union successor. FLAG FOR P3 REGISTRY REVIEW: any
  read-only listing need must route through read/grep/glob, and the P3
  tool registry should not silently reintroduce a list tool.
- mcpAllow per SPEC §9 (e.g. analyzer: get_issue + get_issue_comments).
- Prompt fixtures snapshotted to src/__tests__/fixtures/fleet-prompts/
  so the parity net survives the P8 deletion sweep; git-HEAD diff
  assertions runtime-skip once agents/*.md are gone post-P8.
- pr role keeps no load_skill in its tools; reviewer/tester/coder/
  planner/analyzer matrices preserved as authored.
- Status: committed (`14cd586`).

### 2026-08-23 — wave 7: skills loader + seven starter playbooks (P2 slice)
- `src/fleet/skills/loader.ts`: loadSkillSummaries parses each role
  dir's *.md frontmatter; injectSkills appends a "# Available skills"
  block to the system prompt — this is the P3 worker-loop entry point;
  loadSkill returns result-object errors ({ok:false,error}), never
  throws, so worker loops can branch without try/catch.
- Containment design: name screening (length ≤128, no / \ .. NUL,
  no drive prefixes — checked on BOTH raw and decodeURIComponent forms)
  followed by a resolve+startsWith(sep-bounded) containment check
  against the role dir. Missing role dirs yield empty summaries, not
  errors. Static agent defs untouched by injection.
- Playbooks (fresh-authored, all ≤120 lines per D9): analyzer/repo-triage,
  coder/minimal-diff, coder/commit-hygiene, planner/decomposition,
  pr/pr-body, reviewer/checklist, tester/test-selection.
- Status: committed (`b350992`).

### 2026-08-23 — independent verification verdict (P2)
- Independent verification returned GREEN: 12/12 prompt byte-parity
  checks pass (six defs × fixture/git-HEAD sources), 12/12 hostile
  skill-name attacks rejected (traversal, encoded traversal, absolute,
  drive-letter, NUL, backslash forms).
- Gates at commit time: typecheck 0 errors, vitest 384/384.
- SPEC §17 both P2 items ticked (dated 2026-08-23); TODO.md P2 line
  ticked; MEMORY frontmatter now granular: p2_fleet_skills=true,
  p3_through_p8=false.
- Status: committed in this docs commit.

### 2026-08-23 — wave 8: built-in tools with hard per-role gating (P3 slice)
- src/fleet/tools/: bash (cwd-locked via resolve+prefix-compare,
  process-group timeout kill, 20k combined output cap), read (2000-line
  cap), write/edit (edit is exact-match, fail-loud on mismatch),
  grep/glob (500-result cap), load_skill over the hardened skills
  loader. registry.ts intersects role.tools with the built-in set
  structurally — no `list` tool reintroduced (wave-6 flag resolved).
- Verified: 36 tests including symlink-escape and truncation cases;
  typecheck clean at commit time.
- Status: committed (`cf5d729`).

### 2026-08-23 — wave 9: agent loop over OpenAI SDK (P3 slice)
- src/fleet/loop.ts: hand-written tool-call roundtrip emitting SPEC §6
  wire events via callback only — never stdout. Usage parsing tolerates
  missing fields; cost rule = metadata else 0, ollama forced to 0.
  Abort is stop-after-current-tool (completes the in-flight tool batch);
  maxSteps=25 guard against runaway loops.
- Verified: 12 integration tests against a mocked OpenAI client;
  typecheck clean at commit time.
- Status: committed (`cc1f25f`).

### 2026-08-23 — wave 10: worker entry + real t-wire parser + fork e2e (P3 slice)
- src/runtime/worker/main.ts: stdin job contract with strict validation;
  DRY-RUN second-layer zero-model guard proven via dead-port test;
  SIGTERM handlers pre-emit then bounded flush before exit.
- parseProviderTrace realigned to the REAL t:-keyed wire protocol
  (`ev.t`, not `ev.type`), retiring the deferred protocol decision;
  the one ev.type line in agentRunner.ts tailing follows suit.
- Verified: 4 fork e2e scenarios — dry-run, keyless ollama localhost
  stub, SIGTERM abort, malformed-job rejection.
- Status: committed (`9bc0cbf`).

### 2026-08-23 — independent verification verdict (P3)
- Independent verification returned GREEN: typecheck 0 errors,
  vitest 437/437.
- SPEC §17 all three P3 items ticked (dated 2026-08-23); TODO.md P3
  line ticked; MEMORY frontmatter granular: p3_tools_loop_worker=true,
  p4_through_p8=false.
- Non-blocking notes carried forward:
  1. writeTool path check is lexical-only — parent-dir realpath
     hardening candidate for P4+.
  2. Abort granularity = completes current multi-tool batch; SDK call
     not signal-cancelled (conservative direction; Stop latency ≈ one
     LLM round-trip).
  3. NO step_finish emitted on the error path — failed-run token totals
     survive only in RunAgentOutcome, not on the wire; P5 SOR parity may
     need a terminal step_finish on the fail path.
   4. bash conflates external SIGKILL with timeout (cosmetic).
- Status: committed in this docs commit.

### 2026-08-23 — P4: agentRunner rewired from spawn placeholder to real worker forks
- fork helper single-site: ONE forkWorker call site per SPEC §6 — `.ts`
  entry via `--import tsx` execArgv, stdio pipe+fdOut+fdErr+ipc so worker
  stdout redirects straight into tracesDir/<role>.jsonl (one stream IS
  trace capture AND event source) and is tailed; ONE JSON job via stdin.
  Trace-fd convention preserved from the spawn era.
- Provider walk via withProviderFallback with per-attempt env pinning
  (FLEET_PROVIDERS pinned to the single walked candidate so the worker's
  own resolveProviderModel lands exactly there); attempts[] carries
  provider; AgentResult.provider/model threaded through finalize.
- Abort: killActiveWorkers fail-fast latch kept; aborted-by-user returns
  without falling through remaining candidates. WORKER_TIMEOUT_MS SIGTERM
  escalates to SIGKILL after WORKER_TIMEOUT_GRACE_MS, proven against a
  SIGTERM-trapping fixture (stubbornWorker.mjs).
- Dead spawn-era plumbing deleted: buildProviderArgs/buildProviderEnv/
  resolveRolePrompt/PROVIDER_BIN gone — runner/providers.ts is now
  parsing-only. resumeSessionID inert-deprecated until P6.
- Verification GREEN: typecheck 0 errors, vitest 437/437; fork-test trio
  ran 3x consecutively clean (flake check).
- Notes:
  (a) PRE-EXISTING DB finding: audit_events backend CHECK constraint
      predates provider backends — dry-run prints non-fatal SOR warnings;
      schema/migration question lands at P5 (ASK-FIRST boundary for
      migrations).
  (b) Post-abort attempts noise: an aborted-by-user entry is appended per
      remaining candidate — collapse if consumed downstream later.
  (c) P6 debt ledger: delete resumeSessionID option + coder/tester passes;
      decide FLEET_WORKER_ENTRY production fate.
  (d) Timeout test knobs to widen first if CI flakes: 25ms poll loop,
      1200ms floor (WORKER_TIMEOUT_MS), grace 250ms.
- Status: feat committed (`de0261c`); docs committed in this commit.

### 2026-08-23 — P5: SOR emitter architecture, migration 006, chain repair
- Emitter architecture: src/fleet/sorEmit.ts emits hook-shape records
  (key-sorted before hashing so field order never breaks the chain) into a
  DUAL SINK — events.jsonl file + Postgres DB chain — wired directly into
  the worker loop. NON-FATAL guarantee is 3-layer: emit failure, DB write
  failure, and verify mismatch each warn-and-continue; a run is never
  aborted over SOR writes.
- Migration 006_audit_backends.sql: widens the audit_events_backend_check
  CHECK to accept gemini/openrouter/ollama backends; applied and
  round-trip tested (write then replay through the constraint).
- Chain repair mechanics: the seq-75 break (documented earlier today) was
  PRE-EXISTING, dated 2026-08-14 — 9 rows had been signed under a
  divergent key. Tampering ruled out via xmin provenance comparison; 567
  rows (seq 75–641) re-signed under the current key in an
  owner-authorized repair with backup at
  /tmp/opencode/sor-backup-20260823T100847Z.sql; sor_chain head updated;
  sor:verify now ok:yes at 641 events.
- Commits: `c90896b` (emitter + migration + repair); `f622dc2` (P7 fleet
  MCP server — landed, awaiting OWNER's §17 tick per session protocol).
- P6 partition rationale: orchestrator work ∥ dashboard work was dropped
  due to conflict (concurrent session actively editing webDashboard.ts →
  dashboard item BLOCKED); debt deletions (resumeSessionID option,
  coder/tester passes deletion, FLEET_WORKER_ENTRY fate) run SEQUENTIAL
  after the orchestrator gates→auto work because they share
  orchestrator.ts/workflow imports.
- Status: committed (`c90896b`); docs recorded here.

### 2026-08-23 — wave 11: hardening — MCP structural enforcement + dashboard onLoad repair (+P6/P8 close-out)
- Verification findings that motivated the wave: (1) MCP role allowlist was
  ADVISORY only — a worker could self-declare any role through the _meta
  channel, so denied tools were reachable (security hole); (2) dashboard
  model picker served STATIC tier defaults instead of live /models
  listings; (3) latent landmine: fleetServer spawned via Bun.spawn (dead
  API on the Node runtime).
- MCP structural enforcement design: role is structurally bound from the
  spawn argv chain (worker → server child, no client-supplied role);
  CallTool + ListTools request handlers enforce the allowlist
  UNCONDITIONALLY (not just at connect); _meta channel removed entirely;
  Bun.spawn → node:child_process. Proven by a wire-level stdio
  integration suite: denied role gets [], spoofed _meta cannot escalate,
  allowed role runs end-to-end via a gh stub.
- Dashboard onLoad crash root cause: the mechanical backend→provider
  rename missed the embedded-JS onLoad handler, so page init died on a
  ReferenceError. Repaired provider wiring; /api/models now serves live
  registry.listModelsForProvider with static-tier fallback (10s bounded);
  SSE broadcast parity restored.
- P6 landed in the same window (`cf4e3ff`): all human gates removed,
  single auto-fix round cap=1 (AUTO_FIX_MAX_ROUNDS=1 loop bound + guard)
  proven by orchestrator tests; dashboard approve-endpoint deletion was
  superseded — zero approve endpoints/routes exist post-rename.
- Commits: `29b8103` → `9002fb7` → `81f3c4b` → `39c90fa`.
- Gates at verification time: typecheck 0 errors, vitest 462 passed /
  6 skipped, sor:verify ok:yes at 655 events; keyless smoke `npm run dry
  -- --repo octocat/hello-world --issue 1 --no-web` exit 0, status
  completed, $0.0000. FINAL live smoke remains open (needs a real
  GEMINI_API_KEY issue→PR run).
- Status: code committed (hashes above); docs recorded here.
