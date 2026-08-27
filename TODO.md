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

## Planned next work — Gemini quota safety

- [x] Add a manager-owned, fail-closed coordinator with atomic per-model
      RPM/TPM/RPD reservations shared across all child workers and retries.
- [x] Add built-in per-model Gemini limits from `PLAN.md`/the supplied quota
      table plus optional environment overrides for custom model IDs.
- [x] Harden startup validation for every configured role/model; reject
      missing, invalid, or zero limits before run/worktree/audit setup.
- [x] Make quota initialization descriptor-safe on every worker failure path.
- [x] Enforce rolling RPM/TPM waits on the current model only, with
      `GEMINI_RATE_LIMIT_WAIT_MS` defaulting to 120 seconds; fail after the
      ceiling without model fallback.
      (SUPERSEDED 2026-08-26 by owner-directed switch-on-block design —
      workers never sleep; manager walks chain with auto fail-back.
      See PLAN.md "Rate-limit fallback system")
- [x] Mark exact-model daily exhaustion as `quota_exhausted`, notify the
      dashboard, use only explicitly configured role-tier fallbacks, and
      re-enable the model at the fixed UTC reset.
      (DELIVERED 2026-08-26 as `model_switch`/`all_models_exhausted`
      events over user-config-only `GEMINI_RATE_LIMIT_MODELS` chains)
- [x] Add role-specific step/output budgets, prompt/tool-result caps, retry
      accounting, coordinator recovery handling, and focused tests/docs.

## Incident 2026-08-26 — issue #26 poisoned daemon state

GitHub #26 (Saif-Ali-109/demo-repo) got a fake `multi-orch/done` stamp from a
completed-without-PR run (§1.1), then a stranded `multi-orch/in-progress`
label from a SIGINT'd manager (§1.3); dedup now skips it forever despite no
PR existing. Full forensics in PLAN.md. Fix = ops unblock + two code bugs +
slug normalization. Owner requeues manually; no auto-retry.

- [x] A1. Ops unblock (2026-08-26: labels stripped, both rows → failed): remove both labels from #26 via gh CLI; flip both
        case-variant `run_outcomes` rows (#26) status → failed. NO run start.
- [x] B1. §1.1 completed-without-PR guard (orchestrator.ts): finalize as
        failed + failure comment when pr worker AND fallbacks yield no PR;
        never add done label; still strip in-progress. Tests.
- [x] B2. §1.3 graceful SIGINT/SIGTERM (index.ts): killActiveWorkers() →
        orchestrator finalizes current run failed (+ GitHub failure comment)
        → exit(130). Second signal force-exits. Tests.
- [x] B3. Case-insensitive repo slug in dedup/db layer (LOWER() compares,
        normalized writes, webhook intake). Tests for the two-row trap.

## Observability & audit — full SOR coverage (SPEC §11.6)

Manager-owned single-hook. Approach B: worker keeps tool_call SOR as-is.
Trace JSONL already complete. Dashboard: badges + summary panel.

- [x] O1. SOR event types + migration: `src/sor/events.ts` add
      reservation, reservation_rejection, provider_completion, retry to
      SorEventType + VALID_TYPES. `migrations/010_sor_telemetry_events.sql`
      widen CHECK constraint. `src/__tests__/migrations.test.ts` sequential
      tail for 010.
- [x] O2. Manager SOR emission: `src/orchestrator.ts` onEvent() handler
      emits SOR for reservation, reservation_rejection, provider_completion,
      retry. Try/catch wrapped (non-fatal).
- [x] O3. Dashboard visual upgrade: `src/dashboard/webDashboard.ts`
      enhanced formatAgentEvent() with colored badges per event type.
      New callsummary panel in #railwrap (real-time counters).
- [x] O4. Verification: typecheck · full test suite · sor:verify ok:yes ·
      dry run exit 0. Relaunch issue #26 with full observability.

## P2 fleet defs: 6 agent modules, prompt byte-parity vs git HEAD
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

## Hardening pass — quality & robustness

Source of truth: `SPEC.md` §18 + §17 (H1–H11), `PLAN.md` "Quality Hardening
Roadmap". Each task ends green. Dependency order matters — see graph below.

```
Wave 1 (parallel): H1 + H2 + H3
Wave 2 (parallel): H4 + H5 + H9
Wave 3 (after H5): H6
Wave 4 (parallel): H7 + H8
Wave 5 (after H8): H10 + H11
```

- [x] H1. Dedupe PROVIDER_NAMES: delete from `modelPolicy.ts:18`, import
      from `types.ts`. grep confirms single def.
- [x] H2. Cache walkFiles: `Map<string, string[]>` in `search.ts:18`, one
      walk per worktree per process. grep+glob share one walk.
- [x] H3. Harden extractJson: length guard (100KB), reject empty `{}`,
      log salvage. Extract to `src/utils/json.ts`.
- [x] H4. SOR tests: verifyChain (empty/valid/tampered/gap/reorder/wrong-key)
      + repairChain (idempotent/fix-roundtrip/lock) — 13+ cases, real DB,
      in `src/sor/__tests__/verify.test.ts`.
- [x] H5. Append-only trigger: migration `010_sor_append_only.sql`,
      BEFORE UPDATE/DELETE raises EXCEPTION on `audit_events`.
- [x] H6. Key rotation: `key_id` column (migration `011`), keyRegistry,
      partial repair, `SOR_KEY_ID` env var. Multi-epoch verify passes.
- [x] H7. CI hardening: Biome (lint+format, replaces ESLint+Prettier), vitest
      coverage (v8, 60% line threshold), lint+coverage steps in CI yml.
- [x] H8. Decompose orchestrator.ts:
  - [x] H8a. onEvent factory extracted (dedup 516-545 / 978-1007)
  - [x] H8b. utils extracted (extractJson → json.ts, commitMessageFor, collapseConsecutiveModels)
  - [x] H8c. finalize extracted to `workflow/finalize.ts`
  - [x] H8d. pauseManager extracted to `fleet/pauseManager.ts`
  - [x] H8e. phases extracted to `workflow/phases/{analyze,plan,implement,pr,done}.ts`
- [x] H9. Split webDashboard.ts: `template.html` + `client.js` + `api.ts` +
      server core (~500 lines). All 1,255 dashboard tests pass.
- [x] H10. Wire workforce hiring: `hireWorker` before fork (ENFORCE — block
      spawn if `canHire` fails), `updateWorkerStatus` after completion,
      `retireWorker` on shutdown. Add `worker_id` to AgentResult.
- [x] H11. Pipeline E2E test: `src/__tests__/pipeline.e2e.test.ts`, dry-run
      orchestrator through all 6 phases, verify RunSummary + artifacts +
      SOR events (requires DATABASE_URL).

## Rules

- Never spend real API tokens without saying so first (`npm run dry` exists).
- SOR writes stay NON-FATAL; sor:verify stays green always.
- No new dependencies beyond SPEC §12 without asking.
- Subagent strategy per USER.md (sequential unless file sets fully disjoint).

## Debt (from 8cfb9b1 verification)
- [x] MCP `finalize_run` gate_status binds caller strings raw into jsonb — FIXED `6ee2248`: local `toJsonbParam` mirror at the server.ts chokepoint (the `:205` bind actually lives in src/db/client.ts finalizeRun; coercion applied upstream so every caller is covered)
- [x] orchestrator/agentRunner SOR payload ($9) bound without toJsonbParam — FIXED `84445e2`: bind wrapped in audit.ts; payloads are objects today (passthrough = byte-identical), chain replay unchanged

## Debt (from FINAL smoke 2026-08-24)
- [x] SESSION_LOG cross-run bleed: run N's log lands in run N+1's dir (`09-49-22313Z` holds `09-43-59281Z`'s timeline) — fixed in `src/memory/sessionLog.ts` via `archivePreviousSessionLog`
- [x] Ghost run dir `2026-08-24T10-09-01-213Z`: boot-only artifacts (fix-spec+empty traces) created 5 min AFTER its daemon exited — cleaned up
