---
title: Fleet Delivery Refinement Plan
status: proposed
created: 2026-08-26
source: 4-scope codebase audit + independent verification subagent (12/12 claims confirmed)
scope: pre-delivery hardening of the existing migration-complete codebase
---

# plan-refinement.md — Pre-Delivery Refinement Plan

## Context

SPEC.md §17 is complete except `FINAL live smoke`. This plan covers everything
between "migration done" and "deliverable". All findings below were verified
against source by an independent audit pass (file:line citations included).
Work proceeds in phases; **do not start a phase until the previous phase is
fully committed and green**.

Every task ends green: `npm run typecheck && npm test && npm run sor:verify`.

---

## Phase 1 — Correctness hardening (BLOCKING, do first)

### 1.1 Gate completion on a real PR
- **Problem:** if PR creation fails (worker + both manager fallbacks),
  `src/orchestrator.ts:1085-1106` still falls through to
  `setPhase("done")` / `status: "completed"` and `finalize("completed")`
  (`:1138-1140`), which labels the issue DONE and comments "completed"
  with `- PR: (none)`.
- **Do:** when `!ctx.dryRun && !prUrl`, finalize as `"failed"` (or add an
  explicit `"completed_no_pr"` outcome), skip the DONE label + completion
  comment, post a failure comment instead. Add a regression test pinning the
  no-PR path.
- **Don't:** touch the dry-run exemption at `orchestrator.ts:1040`; don't
  change SOR event shapes while doing this.

### 1.2 Filter worker/bash environment (secret containment)
- **Problem:** `src/agentRunner.ts:292-299` forks workers with the full
  `{ ...process.env }`; `src/fleet/tools/bash.ts:52` spawns model-controlled
  shell with no `env` option → one `env` command exfiltrates
  `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `DATABASE_URL`, `WEBHOOK_SECRET`,
  `SOR_SIGNING_KEY`. Issue text is prompt-injectable.
- **Do:** build an env allowlist passed to the fork (PATH, HOME, LANG,
  proxy vars, provider keys needed *by the worker process itself* only) and a
  stricter second allowlist for the bash tool spawn (no API keys, no DB URL,
  no secrets). Update `.env.example` notes if new vars are introduced.
  Add tests asserting secret names are absent from bash child env.
- **Don't:** break the quota-reserve IPC or trace-file fds; don't remove keys
  the worker legitimately needs to call its own provider.

### 1.3 Lifecycle: signals, orphans, timeouts
- **Problem:** `src/index.ts:40` SIGINT handler exits immediately without
  `killActiveWorkers()` → orphaned workers keep making real model calls.
  `WORKER_TIMEOUT_MS` defaults to 0 = disabled (`src/agentRunner.ts:258`).
  Grandchild processes spawned via the bash tool are killed per-tool-timeout
  but not on manager shutdown.
- **Do:** wire SIGINT/SIGTERM → `killActiveWorkers()` (process-group kill)
  then exit; give the worker a parent-liveness check (e.g. poll
  `process.ppid` / IPC disconnect → abort loop); default `WORKER_TIMEOUT_MS`
  to a sane nonzero value (suggest 900000 = 15 min) and document it in
  `.env.example`; run single-issue mode's `pruneOldRunDirs` too (currently
  daemon-only → crashed runs leak disk forever).
- **Don't:** weaken the SIGTERM→SIGKILL grace escalation tests; don't make
  cleanup fatal to the run result.

### 1.4 Fix byte-vs-char trace offset bug
- **Problem:** `startOffset = fstatSync(fdOut).size` is bytes
  (`src/agentRunner.ts:229`) but `parseProviderTrace` slices a UTF-8-decoded
  *string* (`src/runner/providers.ts:41`) → any multi-byte char earlier in
  the file corrupts parsing.
- **Do:** read the tail as Buffer and slice bytes before decoding to string
  (the live-tailing path at `agentRunner.ts:651-659` already does this
  correctly — mirror it). Add a test with multi-byte content above the offset.
- **Don't:** rewrite the whole trace format.

**Phase 1 exit criteria:** all four fixed, regression tests added, full suite
green, one commit per logical unit.

---

## Phase 2 — Dead scaffolding removal & dedup

Verified dead (delete):
- `src/workforce/` (hiring.ts, policy.ts + hiring.test.ts) — zero production imports
- `src/mcp/server.ts` ("multi-orch-mcp") — unwired legacy server exposing raw DB mutations; delete or move behind an explicit opt-in flag with a doc note
- `emitWakeup()` and `makeEventBridge()` in `src/agentRunner.ts:560-602` — no callers
- `MAX_IMPL_ITERATIONS` in `src/router.ts:39` — only used by its own test
- unused helpers in `src/git/worktree.ts` (`diffStatAgainstBase`, `hasCommits`, `changedFiles`)
- `gray-matter` devDependency — imported nowhere
- `@types/pg` — move from dependencies to devDependencies
- `scripts/verify-edge-auth.mjs` — references undocumented external service; confirm with owner then delete (note: `.gitignore` entry `verify-edge-auth.mjs` doesn't even match its nested path)

Refactor (careful, mechanical):
- Extract the duplicated ~60-line event/log block shared between `runAgent`
  (~orchestrator.ts:397-476) and the inline coder/tester path (~:750-860)
  into one helper. No behavior change.
- Fix stale doc-comments describing removed GATE/JIT behavior
  (`readSelectedFileSymbols` imported but never called at orchestrator.ts:14).

Doc/env reconciliation:
- `.env.example`: remove dead `GEMINI_BIN`/`OPENROUTER_BIN`/`OLLAMA_BIN` and
  `MCP_SERVER_PORT`; document `FLEET_MANAGER_ID`, `GEMINI_QUOTA_OVERRIDES`,
  `SOR_PROVIDER` (repo rule: every env var documented).
- TODO.md: re-triage the three "Gemini quota safety" items — rolling RPM/TPM
  waits ARE implemented (`src/fleet/loop.ts:343-377`,
  `quotaCoordinator.ts:49-56`) but untested → write the missing test, then tick.
- Resolve PLAN.md paradox: `.gitignore:8` ignores PLAN.md while AGENTS.md
  session protocol requires reading it. Un-ignore it (or repoint the
  constitution to SPEC.md) and replace PLAN.md's finished one-off content
  with a real index.

**Don't:** hand-edit anything under `.runs/`; don't delete `repairChain.ts`
(it has operational history); don't rename public CLI flags.

---

## Phase 3 — Trust & polish

SOR chain (ask owner before touching hash-chain logic — repo boundary):
- `verifyChain` (`src/db/audit.ts:158-191`) never compares against the
  `sor_chain` head/tail row → tail-truncation undetectable. Do: bind verify
  to the stored tail hash and report mismatch.
- Number flattening in `signer.ts:23-26` makes hashes non-injective
  (`1` ≡ `"1"`) → type-substitution bypass. Do: preserve number/string
  distinction in canonical form (this CHANGES hashes → coordinate with owner;
  may require one final key rotation + repair with backup, per precedent).
- `repairChain.ts` re-signs everything with no gate. Do: require an explicit
  confirmation arg (e.g. `--i-know-this-destroys-evidence`) and append a
  `chain_repair` marker event.

DB:
- Add FK indexes (`agent_actions.run_id`, `trace_events.run_id`,
  `cost_ledger.*`, `worker_roles.*`) as migration 007.
- Unify TIMESTAMP vs TIMESTAMPTZ in a follow-up migration if owner approves.
- Migration runner: add advisory lock; consider checksums for applied files.

Tests (highest-risk gaps):
- `src/memory/sessionLog.ts` — known cross-run bleed bug (TODO.md:125): FIX
  the lazy-path-resolution race AND add tests.
- CLI arg parsing in `src/index.ts` (745 lines, untested).
- Rolling-wait quota path (see Phase 2).
- `writeTool` symlink gap: apply the same `resolveExistingInside` realpath
  check used by readTool/editTool (`files.ts:87` vs `common.ts:70-86`) + test.

Hygiene:
- Add LICENSE (owner picks), gitignore `manager/*.txt` runtime artifacts,
  add eslint/biome + CI lint step, decide fate of TUI's decorative progress
  bars (render honest state or remove).

---

## Phase 4 — Ship

1. Run **FINAL live smoke**: real issue → PR with only `GEMINI_API_KEY`.
   Tick SPEC.md §17 last item (`docs: check FINAL live smoke`).
2. Confirm `manager/models.json` overrides flow works end-to-end.
3. Tag release; write CHANGELOG summarizing Phases 1–3.
4. Decide distribution posture: currently `private: true`, no `bin`, no
   LICENSE — fine as internal tool; open-sourcing blocked until Phase 3
   hygiene lands.
5. Optional distribution prep: `bin` entry, `files` allowlist, README
   install section.

---

## Standing rules for ANY session working this plan

DO:
- Read AGENTS.md, SPEC.md §17, and this file first; work top-down by phase.
- One logical unit per commit; short imperative subject + explanatory body.
- Smoke `npm run dry` after orchestrator/runner changes.
- Keep SOR writes non-fatal; keep `sor:verify` green at all times.
- Update `.env.example` whenever env vars change.
- YAML frontmatter on every new/edited `*.md` except AGENTS.md.

DON'T:
- Don't add model/API calls to manager-side modules (`orchestrator.ts`,
  dashboard, router) — workers only, ever.
- Don't reorder/weaken SOR chain logic without owner sign-off (Phase 3 items
  especially).
- Don't weaken per-role tool gating, MCP allowlists, or bash cwd-locking —
  tighten only.
- Don't assume `--dry-run` spawns real workers; don't hand-edit `.runs/`.
- Don't introduce new providers/agent roles without asking.
- Don't commit secrets; `.env` stays out of everything.
