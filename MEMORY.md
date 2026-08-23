---
title: Build Memory — Verified Work Log
status: active
created: 2026-08-23
last_updated: 2026-08-23
last_agent: session-2026-08-23 (P1 completion + verification)
phases_done:
  docs_companions: true
  prelaunch_deletions: true
  P0_baseline: true
  P1_providers_models: true
  P2_through_P8: false
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
