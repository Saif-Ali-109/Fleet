---
title: Migration TODO
status: active
created: 2026-08-23
spec: ./SPEC.md
memory: ./MEMORY.md
---

# TODO.md — build queue

Source of truth for scope/acceptance is `SPEC.md` (§13 phases, §17 checklist).
This file is the ordered work list; tick items here as they complete and log
verified completions in `MEMORY.md`. Commit per logical unit; every task ends
green (`npm run typecheck && npm test`). Sequential order — shared files.

## Current pass — finish P1 + green baseline

- [x] A1. Commit docs baseline: SPEC.md, USER.md, CONTRIBUTING.md + staged
      README.md/directory.md deletions
- [x] A2. Commit interim AGENTS.md rewrite + manager/MEMORY.md,
      manager/SESSION_LOG.md updates
- [x] B1. Fix modelPolicy.ts:102 `"analyst"` → `"analyzer"`; delete dead
      CODEX_DEFAULTS_FIXED
- [x] B2. Revert agentRunner.ts:361 SOR field `provider:` → `backend:`
      (historical event shape preserved)
- [x] B3. Remove dead `=== "codex"` comparison (agentRunner.ts:250)
- [x] C1. index.ts: actually parse `--provider` flag (argv +
      ORCHESTRATOR_PROVIDER), purge Backend refs
- [x] C2. orchestrator.ts emitSorEvent reads ctx.provider
- [x] C3. webDashboard.ts: drop Backend/BACKENDS imports, provider-keyed
      override access (full picker rework stays P8)
- [x] D1. Delete legacy layer early (owner-approved): src/runtime/{cli,sdk}/**,
      runtimeFactory.ts, runtime/index.ts; move detectTestCommand →
      src/fleet/testCmd.ts; drop CLI halves of runner/backends.ts
- [x] D2. tui/dashboard.ts: Backend import → ProviderName
- [x] E1. Complete src/providers/registry.ts: memoized OpenAI client factory,
      FLEET_PROVIDERS parsing, missing-key skip + runtime-failure fallback
      walk, no-keys fail-fast ({model:"none",ok:false}), /models listing helper;
      attempts[] gains provider field
- [x] E2. Dedupe defaults: modelPolicy imports modelDefaults table (single
      source of truth); modelDefaults imports types instead of re-declaring
- [x] E3. models.json v1 → discard + log-once per SPEC §12/P8
- [x] E4. .env.example: FLEET_PROVIDERS + GEMINI/OPENROUTER keys + role model
      vars (comments on own lines); package.json: add openai dep
- [x] F1. New tests: registry unit tests (URL/key resolution, missing-key skip,
      fallback order, fail-fast), modelDefaults test, override-store-v2 test
- [x] F2. Rewrite modelPolicy.test.ts to v2 API; update agentRunner +
      agentRunnerTimeout tests to current reality
- [ ] F3. Green gate: typecheck && npm test && sor:verify && npm run dry smoke
      (typecheck 0 errors, 336/336 vitest, dry smoke OK — but sor:verify is
      RED at seq 75: PRE-EXISTING break dated 2026-08-14, untouched by this
      wave; unticked until root-caused)
- [x] F4. Tick SPEC §17 P0 + both P1 items with dated commits
      (docs: check <item>); log entries in MEMORY.md

## Later phases (order per SPEC §17)

- [x] P2 fleet defs: 6 agent modules, prompt byte-parity vs git HEAD
      agents/*.md, snapshot bodies to fixtures (12/12 byte parity),
      skills loader + 7 playbooks (containment verified)
- [x] P3 tools (bash/read/write/edit/grep/glob/load_skill) + gating tests;
      loop.ts + worker main.ts (mocked-OpenAI integration); fork e2e test
- [x] P4 agentRunner rewired to fork worker (+ attempts/provider-walk/abort
      tests): single forkWorker site (tsx loader, trace-fd redirect + tail,
      stdin job), withProviderFallback walk w/ env pinning, SIGTERM→SIGKILL
      grace proven vs trapping fixture
- [ ] P5 SOR emitter parity fixture test (sor:verify green)
      DEFERRED NOTE: `normalizeEvent` VALID_BACKENDS still rejects
      gemini/openrouter/ollama — must accept provider names before the emitter
      routes events through it.
- [ ] P6 gates→auto + autofix cap=1 (orchestrator tests, dashboard approve
      endpoints removed)
- [ ] P7 own MCP server (gh-backed, allowlist matrix tests)
- [ ] P8 dashboard event mapping + provider/model picker; deletion sweep rest
      of manifest §12; grep clean "opencode|claude|codex"; README fresh +
      AGENTS.md target-state polish
- [ ] FINAL live smoke: real issue → PR with only GEMINI_API_KEY
      DEFERRED NOTE: `npm run sor:verify` is currently RED at seq 75 —
      PRE-EXISTING break dated 2026-08-14, untouched by this wave (zero db/sor
      files changed). Root-cause BEFORE attempting live smoke.

## Rules

- Never spend real API tokens without saying so first (`npm run dry` exists).
- SOR writes stay NON-FATAL; sor:verify stays green always.
- No new dependencies beyond SPEC §12 without asking.
- Subagent strategy per USER.md (sequential unless file sets fully disjoint).
