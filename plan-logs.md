---
title: Call-counting telemetry for dashboards + DB persistence
status: active
date: 2026-08-25
owner: ain
audience: implementation agents
---

# Call-counting telemetry — subagent execution plan

One session = one run = 6 workers. Count tool calls, model (LLM) calls,
skill loads at per-agent, per-session-total, and per-tool granularity.
Live-updating on web + TUI, persisted to Postgres for future runs only
(no backfill). Owner approved the schema migration.

## Prior decisions (FINAL — do not re-litigate)

- New table `agent_call_stats` via migration 007 (user approved).
- Future runs only; no backfill of `.runs/`.
- Metrics: tools / model calls / skills (+ per-tool breakdown).
- Web + TUI both; live ticking during runs; session totals strip.
- No SOR changes; no manager-side model calls; counters are read-only.
- Gemma 4 31B (`gemma-4-31b-it`) deferred — NOT part of this work.

## Data contract

```ts
// src/types.ts — AgentResult (lines 49–73), add:
calls?: { tools: number; models: number; skills: number; breakdown?: Record<string, number> }

// src/tui/dashboard.ts — AgentStatus (lines 6–16), add:
calls?: { tools: number; models: number; skills: number }

// src/tui/dashboard.ts — DashboardState (lines 18–27), add:
totals?: { tools: number; models: number; skills: number; costUsd: number; tokens: number }
```

All optional — old snapshots render unchanged; zero-counts render empty.

## Key anchors in current code

| What | Where |
|---|---|
| parseProviderLine (drops telemetry today) | src/runner/providers.ts:56 |
| ParsedStream + emptyStream | src/agentRunner.ts:26–36 |
| parseTrace | src/agentRunner.ts:427–452 |
| finalize | src/agentRunner.ts:463–492 |
| aggregateAgentResults | src/agentRunner.ts:660–706 |
| totalCostUsd / makeSummary | src/orchestrator.ts:243–264 |
| onEvent hook (ScoutTracker pattern) | src/orchestrator.ts:358–367 |
| logAgentAction sites | src/orchestrator.ts ~383, ~741 |
| DashboardState types | src/tui/dashboard.ts:4–27 |
| renderDashboard totals-line target | src/tui/dashboard.ts:52–78 |
| fmtCost/fmtTokens | src/dashboard/webDashboard.ts:1206–1217 |
| card() meta line | src/dashboard/webDashboard.ts:1386–1399 |
| renderAgents() | src/dashboard/webDashboard.ts:1400–1412 |
| migration style reference | migrations/004_sor.sql (-- UP:/-- DOWN:) |

## Migration 007 — agent_call_stats

```sql
CREATE TABLE agent_call_stats (
  stat_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         UUID REFERENCES run_outcomes(run_id),
  role           TEXT NOT NULL,
  model          TEXT,
  provider       TEXT,
  session_id     TEXT,
  tool_calls     INTEGER NOT NULL DEFAULT 0,
  model_calls    INTEGER NOT NULL DEFAULT 0,
  skill_loads    INTEGER NOT NULL DEFAULT 0,
  tool_breakdown JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (run_id, role)
);
```

DB functions (new src/db/queries/callStats.ts): `upsertAgentCallStats()`,
`sessionCallTotals(runId)` — NON-FATAL warn-and-continue everywhere.

---

## Subagent waves (USER.md parallelism rules enforced)

### WAVE 1 — PARALLEL (disjoint files)

- [x] **W1A**: Add `AgentResult.calls` to `src/types.ts` (lines 49–73).
  Verify: `npm run typecheck` ✅

- [x] **W1B**: Create `migrations/007_agent_call_stats.sql` + new
  `src/db/queries/callStats.ts` (upsert + session totals query) +
  round-trip test (migrations.test.ts pattern).
  Verify: `npm run migrate:up && npx vitest run src/__tests__/migrations.test.ts` ✅

### WAVE 2 — PARALLEL (disjoint clusters)

- [x] **W2C**: Parser counting engine — `src/runner/providers.ts` +
  `src/agentRunner.ts` + parser tests ✅

- [x] **W2D**: DashboardState types + TUI totals line —
  `src/tui/dashboard.ts` COMPLETELY ✅

### WAVE 3 — E and F share no files; F depends only on W2D contract

- [x] **W3E**: Orchestrator wiring — `src/orchestrator.ts` + test ✅

- [x] **W3F**: Web display — `src/dashboard/webDashboard.ts` + dashboard test ✅

### WAVE 5 — SEQUENTIAL gate agent (last)

- [x] Full green: `npm run typecheck && npm test && npm run sor:verify` ✅
- [x] Record results here ✅

---

## Results (2026-08-25T20:32Z)

- **typecheck**: 0 errors ✅
- **tests**: 580 passed, 6 skipped, 0 failed ✅
- **sor:verify**: ok: yes (1,475 events) ✅
- **new tests**: callStats (4) + callCounting (5) = 9 new tests
- **fix**: migrations.test.ts hardcoded last-migration name → updated to 007

### Files changed

| File | Change |
|---|---|
| `src/types.ts` | Added `calls?` to AgentResult |
| `migrations/007_agent_call_stats.sql` | NEW — agent_call_stats table |
| `src/db/queries/callStats.ts` | NEW — upsertAgentCallStats, sessionCallTotals |
| `src/__tests__/callStats.test.ts` | NEW — 4 tests |
| `src/__tests__/callCounting.test.ts` | NEW — 5 tests |
| `src/runner/providers.ts` | Telemetry counting + tool breakdown |
| `src/agentRunner.ts` | ParsedStream counters, plumb to AgentResult |
| `src/tui/dashboard.ts` | AgentStatus.calls, DashboardState.totals, totals line |
| `src/orchestrator.ts` | Live counters, totalCalls/totalTokens, DB upsert |
| `src/dashboard/webDashboard.ts` | fmtCalls, card calls display, totals strip, CSS |
| `src/__tests__/migrations.test.ts` | Updated last-migration assertion |

---

## Conflict map (each file written exactly once)

| File | Wave |
|---|---|
| src/types.ts | W1A |
| migrations/007 + src/db/queries/callStats.ts | W1B |
| src/runner/providers.ts + src/agentRunner.ts | W2C |
| src/tui/dashboard.ts | W2D |
| src/orchestrator.ts | W3E |
| src/dashboard/webDashboard.ts | W3F |

No writer edits a module another CONCURRENT writer imports.

## Guards

- Never touch SOR signing/verification/chain.
- Manager-side code counts events only — zero model/API calls.
- Do not weaken tool gating or worktree locks.
- Every *.md edit keeps YAML frontmatter.
