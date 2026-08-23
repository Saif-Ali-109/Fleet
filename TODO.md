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
- [x] F3. Green gate: typecheck && npm test && sor:verify && npm run dry smoke
      (typecheck 0 errors, vitest 462 passed/6 skipped, sor:verify ok:yes at
      655 events after the seq 75–641 re-sign repair; keyless smoke exit 0,
      status completed, $0.0000 — 2026-08-23)
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
- [x] P5 SOR emitter parity fixture test (sor:verify green): hook-shape
      parity emitter (src/fleet/sorEmit.ts, dual sink events.jsonl + DB
      chain) wired into worker loop; normalizeEvent accepts
      gemini/openrouter/ollama; migration 006_audit_backends.sql widens
      audit_events_backend_check (applied + round-trip tested); historical
      chain re-signed seq 75–641 under current key (owner-authorized repair,
      backup /tmp/opencode/sor-backup-20260823T100847Z.sql); sor:verify
      ok:yes at 641 events (`c90896b`)
- [x] P7 own MCP server (gh-backed, allowlist matrix tests): landed as
      `f622dc2`, hardened `9002fb7` — role structurally bound from spawn
      argv, unconditional CallTool+ListTool enforcement, _meta channel
      removed, Bun.spawn→node:child_process; wire-level stdio suite
      (denied role gets [], spoofed _meta cannot escalate, allowed role
      end-to-end via gh stub)
- [x] P8 dashboard event mapping + provider/model picker; deletion sweep rest
      of manifest §12; grep clean "opencode|claude|codex"; README fresh +
      AGENTS.md target-state polish: onLoad provider wiring repaired +
      live /api/models picker with SSE parity (`81f3c4b`); §12 sweep
      complete (`29b8103`); grep clean — legacy backend strings remain
      only in SOR legacy acceptance/migration SQL/tests documenting
      history (`39c90fa`); README rewritten fresh; AGENTS.md mid-migration
      banner + stale script refs dropped, boundaries intact
- [ ] FINAL live smoke: real issue → PR with only GEMINI_API_KEY
      NOTE: keyless smoke green (`npm run dry -- --repo octocat/hello-world
      --issue 1 --no-web` → exit 0, status completed, cost $0.0000,
      2026-08-23) but does NOT satisfy this item — requires a real run
      with only GEMINI_API_KEY set producing an actual PR on GitHub.

## Rules

- Never spend real API tokens without saying so first (`npm run dry` exists).
- SOR writes stay NON-FATAL; sor:verify stays green always.
- No new dependencies beyond SPEC §12 without asking.
- Subagent strategy per USER.md (sequential unless file sets fully disjoint).
