---
title: "S8 — Worker lifecycle: orphan recovery and manager ownership"
status: proposal
date: 2026-10-16
owner: ain
audience: reviewers approving production changes to worker lifecycle
implements: SPEC.md §17 S8
---

# S8 — Worker lifecycle design proposal

**Status: proposal only. Nothing in this document is implemented.** No production
change has been made. Every part below needs explicit owner approval, and parts
(c)/(d) alter production concurrency or retirement behavior, which
`AGENTS.md` treats as a boundary.

## 0. Summary of the problem

`countActiveTotal()` (`src/workforce/hiring.ts:67`) counts every worker row whose
status is `pending` or `running`, globally and with no owner or run filter. A
worker occupies that budget from `hireWorker()` until `updateWorkerStatus()` runs
at `src/agentRunner.ts:526` — a single production call site, at the very end of a
walk. Anything that kills the process before that line leaks a row permanently.

Five real orphans aged 43–49 days were found on 2026-10-16 and retired under a
separately reviewed, PK-scoped transaction. They are history, not the design
problem. The design problem is that **nothing prevents the next five.**

## 1. Findings that constrain the design

**F1 — `retireWorker` is dead code.** Defined at `hiring.ts:128`, zero production
call sites, and the `retired` status had zero rows. `running` is never written
either, so a worker is `pending` for its entire life and only leaves the active
set at completion. `ACTIVE_STATUSES = ["pending","running"]` effectively means
`pending`.

**F2 — Two different run identifiers exist, and they are incompatible.**

| Identifier | Form | Source |
|---|---|---|
| `ctx.runId` | timestamp string, e.g. `2026-10-16T06-12-10-253Z` | `newRunId()`, `src/index.ts:201` |
| `run_outcomes.run_id` | UUID | `gen_random_uuid()` via `db.createRun()`, `src/db/client.ts:102` |

`ctx.runId` names the `.runs/<runId>` directory. The DB UUID is a separate value
created at `src/orchestrator.ts:494` and held in a function-local `runId`. So
`worker_roles.run_id` — already `UUID REFERENCES run_outcomes(run_id) ON DELETE
CASCADE` (`migrations/003_worker_roles.sql:7`) — **cannot** accept `ctx.runId`.
This is why `hireWorker` hardcodes `VALUES (NULL, ...)` rather than merely
omitting the column: the value was never plumbed, and the available value had the
wrong type. Populating it requires threading the DB UUID down to `hireWorker`,
not just reading `ctx`.

**F3 — `run_id` and `started_at` are 100% NULL across all rows** and carry no
discriminating signal. `permissions IS NULL` does: 5/5 orphans vs 0/2043 terminal
rows, because `updateWorkerStatus` writes it atomically with the terminal status.

**F4 — Single-manager ownership is not enforced.** No advisory lock, no lease, no
leader election, no `owner_id`/`instance_id`, no heartbeat; no
Dockerfile/compose/k8s/systemd/pm2. The only implicit guard is the dashboard TCP
port, and it is partial — see §2.

**F5 — Leak paths.** Normal completion and single-signal graceful shutdown reach
line 526. Leaks occur on: second signal (immediate `forceExit`, `index.ts:108-111`),
finalize exceeding the 10s `unref`ed guard (`index.ts:124`), crash/SIGKILL/OOM, and
any DB error at line 526, which is swallowed by `catch { /* non-fatal */ }`.

**F6 — Worker lifecycle is absent from the SOR chain.** `SorEventType`
(`src/sor/events.ts:3`) has no worker event. Hiring and retirement are therefore
outside the tamper-evident audit trail.

## 2. Manager ownership — the decision that gates everything else

This must be settled first, because it determines whether "every active row at
startup is orphaned" is a valid argument or a dangerous one.

### Option A — enforced single manager, via `pg_advisory_lock`

Acquire a session-scoped advisory lock at startup on a fixed key; hold it for
process lifetime; refuse to start if it cannot be acquired.

```sql
SELECT pg_try_advisory_lock(<key>);
```

- **Correctness:** strongest available guarantee. Postgres releases the lock when
  the session ends, including on crash, OOM kill and `SIGKILL` — no TTL, no clock
  skew, no heartbeat to lose. A crashed manager cannot strand ownership.
- **Multi-host:** fully covered. The lock is server-side state, so two managers on
  different hosts against one `DATABASE_URL` genuinely contend. This is the one
  property the dashboard port cannot provide.
- **Failure modes:** (i) a stale-looking manager holding the lock blocks all
  others — but only until its session dies, which is prompt; (ii) the lock must be
  taken on a dedicated, long-lived client, not a pooled one, or it will be handed
  back and forth unpredictably — `src/db/client.ts` uses a pool, so this needs a
  dedicated connection held for the process lifetime; (iii) an operator who wants
  two managers must consciously bypass, which is the point.
- **Consequence for recovery:** with ownership proven exclusive, startup
  reconciliation becomes trivially safe. No age heuristic is needed — see §3.
- **Operational cost:** no horizontal scaling. Two managers cannot share a
  database at all.

### Option B — multi-manager, via `owner_id` + lease/heartbeat

Add `owner_id` (a per-process UUID) and `lease_expires_at` to `worker_roles`; each
manager heartbeats its live rows; reconciliation retires rows whose lease has
expired.

- **Correctness:** weaker. Correctness now depends on a clock and on heartbeats
  arriving. A paused process (SIGSTOP, VM freeze, long GC, blocked event loop) can
  have its lease expire while its workers are very much alive, and a sweep would
  retire them.
- **Multi-host:** supported, at the cost of every above hazard.
- **Failure modes:** heartbeat loss, clock skew between manager and database,
  network partition between a manager and its database, and thundering-herd
  reaping. Each is a path to retiring a live worker.
- **Operational cost:** real complexity — lease renewal, fencing tokens, and the
  fencing problem is genuinely hard to get right. `canHire` would also need
  per-owner accounting, which is a change to production concurrency semantics.

### Recommendation: Option A

The concurrency limit is a machine-wide budget (`max_concurrent_workers`), and
`countActiveTotal()` is machine-wide. Multi-manager operation does not increase
throughput against that budget — 10 workers is 10 workers regardless of who
counts them — so Option B buys no throughput while adding a class of
live-worker-retirement bugs. Option A also requires no schema change and no
change to concurrency accounting.

Advisory locks are session-scoped, so the implementation must take a dedicated
non-pooled client. That is the main engineering risk and should be proven first,
in isolation.

## 3. Recovery design

### 3.1 Worker-to-run correlation — IMPLEMENTED (stage 3 commit)

1. DB `run_id` UUID threading: ✓ `orchestrator.ts:runWorker` now passes the
   real run_outcomes UUID into `RunWorkerOpts.runDbId`, appended to
   `hireWorker`'s signature and bound at INSERT; ctx.runId is never used
   there (FK rejects it). `markWorkerRunning` sets `status='running'` and
   `started_at=now()` fire-and-forget at first successful fork, guarded on
   `status='pending'` so a late spawn can never resurrect a terminal row.
   Regression suite: `src/__tests__/workerCorrelation.test.ts`.

1. Thread the DB `run_id` UUID from `orchestrator.ts:494` through to `runWorker`
   and into `hireWorker`, replacing the hardcoded `VALUES (NULL, …)` with a
   parameter. It **must not** be `ctx.runId` (F2 — wrong type, FK would reject).
   Dry runs never reach `hireWorker`, so no null path is introduced.
2. Set `started_at` on the first transition out of `pending`, so `created_at`
   (hire) and `started_at` (actually running) are distinguishable.

### 3.2 Safe reconciliation — ownership gates it, ages do not

**Corrected by empirically verified subprocess-lifecycle evidence.** The earlier
"Option A ⇒ rows provably orphaned" argument (§3.2 v1) was wrong: ownership
makes the *lock* exclusive but it does not make the *children* die. Observed
directly: a manager forked with the default `fork()` options carries neither
`detached: true` nor a worker-side self-timeout; `WORKER_TIMEOUT_MS` is enforced
only by the manager. When the manager is SIGKILLed, those children reparent as
`Sl` processes, keep ticking, and never time out themselves — a killed
manager's worker was subsequently observed progressing past its prior tick
count (ticks 4→10). Consequently:

  * A new startup's "active rows" are not provably stale: the prior manager
    may simply have died, with its children still live and still writing.
  * Therefore **startup reconciliation may not retire on age alone**, and it may
    not retire rows merely because the advisory lock is now free.
  * Rows no longer qualify as "orphaned" just by association with a dead
    manager pid — only *graceful* manager termination (session tearing down its
    lock and workers normally, attested by the lock-release observing pid
    disconnect) can precede a sweep.

What reconciliation may do instead, safely:

  * **Report, then allow auto-retire only on attested graceful exit.** The
    ownership layer can already prove exclusivity and liveness (lock held by
    *this* process). A sweep is permissible only when there is prior written
    evidence (e.g. the previous manager's explicit finalise/teardown) that the
    workers did not outlive it; otherwise the sweep reports orphans for human
    triage.
  * **Per-fork lifetime bound.** Until workers fork with `detached: false` and
    a worker-side self-termination, the unbounded-orphan window is a
    prerequisite gap, not an S8-level design decision. Propose: child exits on
    WriteError of parent pipe / a held timeout inside the worker — independent
    of manager survival.
  * **Kill + re-hire remains gated.** Reconciliation must not surprise a
    genuinely-running live worker belonging to this host; safe only once the
    ownership + lifetime-bound prerequisites are demonstrated.

What changed structurally with stages 1–3 (so the report is now useful even
when we only report): each active row now carries its real `run_outcomes`
UUID and a true `started_at`, and `started_at` distinguishes "hired" from
"actually spawned". `status` now legitimately transitions
`pending → running → success/failed`, which makes a stranded `running` row
clearly identifiable without SOR help. `retireWorker` stays dead code until
the above prerequisites are satisfied.

### 3.3 The leak paths

Graceful shutdown already routes through the normal failure path to line 526, so
the fix is not to change shutdown but to make leaks recoverable and visible:

| Path | Current | Proposed |
|---|---|---|
| Normal completion | reaches 526 | unchanged |
| Single signal | reaches 526 | unchanged |
| Second signal | `forceExit`, leaks | unchanged; recovered next startup |
| Finalize > 10s guard | killed mid-finalize, leaks | recovered next startup |
| Crash / SIGKILL / OOM | leaks | recovered next startup |
| DB error at 526 | swallowed silently | **warn + count**, then recovered next startup |

Making the line-526 failure visible is the highest-value, lowest-risk item: today
a failed status write is indistinguishable from success, so the leak rate is
unmeasurable.

### 3.4 SOR audit trail

Hiring and retirement belong in the tamper-evident trail — they are exactly the
kind of privileged, capacity-consuming state an audit chain exists to record.
This needs new `SorEventType` members (e.g. `worker_hired`, `worker_retired`,
`worker_orphan_reaped`), and **AGENTS.md "Ask first" explicitly covers changes to
SOR event shapes**, so this cannot ship without separate sign-off.

## 4. Acceptance tests — defined before any code

Expected behavior is specified first so the tests are a specification, not a
retrofit. All DB tests run against `fleet_test` (see `vitest.config.ts`).

**T1 — competing managers.** Two clients attempt ownership. Second must fail to
acquire and refuse to start. Must hold across separate *hosts*, so it is tested
via two independent connections, not two in-process mocks.

**T2 — live worker survives.** With ownership held and a worker `running`, another
startup attempt by a non-owner must be refused, and the live row must remain
active. This is the regression test for the entire design.

**T3 — stale worker reaped.** Owned manager starts, finds an orphaned active row,
retires it with reason `orphaned_at_startup`, and the row leaves the active set.

**T4 — crash recovery.** Simulate by inserting an active row and abandoning it
(no terminal update), then restarting: row is retired exactly once, and the SOR
event count is 1 (not 0, not 2 — idempotence).

**T5 — failed terminal write.** Force the line-526 update to fail; assert it warns
rather than silently succeeding, and that the subsequent startup reaps the row.

**T6 — startup reconciliation idempotence.** Running startup twice must not double-
retire or error.

**T7 — graceful shutdown.** Single signal during an active run leaves no active
row behind (existing behavior, now asserted rather than assumed).

**T8 — correlation.** A hired worker carries the `run_outcomes` UUID, not
`ctx.runId`; `started_at` is set on transition. Guards F2 specifically.

**T9 — ownership released on crash.** Kill a lock-holding client; a second client
must acquire promptly. Guards the main operational risk of Option A.

## 5. Recommended implementation order

Strictly sequential; each step is independently reviewable and revertable.

1. **T9/T1 proof-of-concept for the advisory lock**, in isolation, including the
   dedicated-connection detail. *No behavior change.* If this proves fragile,
   stop and revisit §2 before anything else is built.
2. **Make line-526 failures visible** (warn, non-fatal). Smallest change with the
   largest diagnostic value, and it makes leak rate measurable before any sweeping.
3. **Populate `run_id` and `started_at`.** Makes orphans attributable. Schema
   already supports it; no migration required.
4. **Enforce ownership at startup.** Manager refuses to start without the lock.
5. **Startup reconciliation**, gated on proven ownership, with SOR emission.
6. **SOR worker events** — only after separate `AGENTS.md` "Ask first" approval.

Steps 4 and 5 must not be separated, and neither may land before step 1. Steps 1–3
change no retirement behavior; step 5 is the first step that does.

## 6. Explicitly unchanged

`countActiveTotal()` and production concurrency accounting · worker-retirement
behavior · per-role tool gating · bash worktree cwd-locking · S3 (SDK bump) ·
S5 (prompt-injection threat model).
