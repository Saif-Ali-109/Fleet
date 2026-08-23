---
title: Build Memory — Verified Work Log
status: active
created: 2026-08-23
last_updated: 2026-08-23
last_agent: session-2026-08-23 (verification pass)
phases_done:
  docs_companions: true
  prelaunch_deletions: true
  P0_baseline: false
  P1_providers_models: partial
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
