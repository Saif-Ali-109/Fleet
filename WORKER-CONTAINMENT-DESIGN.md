---
title: "Worker Containment Design — Process Trees, Limits, and Evidence"
status: design
date: 2026-10-16
owner: ain
audience: reviewers approving worker-lifecycle safety proposals
related: "S8-DESIGN.md (orphan recovery strategy), src/agentRunner.ts, src/workforce/ownership.ts"
---

# Worker Containment Design

## 0. Constraints of this document

- `AGENTS.md` "Ask first" and boundaries remain unchanged: no reconciliation and no retirement changes here; no modifications to `countActiveTotal()` or SOR event types; S3, S5, tool gating, and bash working-directory locking are untouched.
- This document is design and evidence only. Acquisition of the advisory lock remains a coordination aid, not proof that older workers are dead (S8-DESIGN §3.2). Any implementation is gated behind separate approval.
- Replacement names are illustrative but concrete enough to implement. A proposal that cannot compile or cannot be exercised end-to-end is not ready as a specification.

---

## 1. Problem statement

Fleet's current worker containment model is manager-centric and signal-optimistic:

- A manager `fork`s workers with `child_process.fork()` using the default options (`detached: false`). Under those options the child inherits the manager's process group and usually reparents to pid 1 on manager crash rather than dying.
- `WORKER_TIMEOUT_MS` is enforced by the manager only. The worker supplies no self-termination clock and does not notice that the manager has died.
- `killActiveWorkers()` sends only `SIGTERM` to direct children. It does not escalate to `SIGKILL`, and does not include descendants that the worker itself forked.
- Worker cooperation is latent rather than contractual. `longWorker.mjs` in the test suite can survive `SIGTERM`; a `SIGTERM`-trapping worker (see `stubbornWorker.mjs`) survives until the process becomes foreign or the host is rebooted.
- `retireWorker` is still dead code; `reconcile` does not exist. The evidence that a worker is active or dead cannot be derived from the advisory lock.
- `status`, `started_at`, and `ended_at` attempt to give a worker a lifecycle in the database, but nothing in the model ensures that the writer and the process agree on whether a child has left the machine.

Containment must therefore reason from observable resources (process tree, cgroup, manager/process-group relationship, DB lifecycle witnesses) instead of from intent or from the lock alone.

---

## 2. Core design invariant

A worker is "active" only when both of the following hold simultaneously:

1. Its DB row is in `pending`/`running` as this manager's picture and is attributable to (a) its parent manager and (b) its process group or cgroup.
2. At least one process in the process group or cgroup that the manager opened for that worker is still alive according to the host.

A worker is "inactive" — and becomes a candidate for retirement — only after at least one of:

- The manager wrote the terminal `success`/`failed`/`retired` row with `ended_at` and its writer connection observed the commit; or
- The host observed all processes assigned to the worker's process group/cgroup as terminated and the manager's process group for that worker reached an attested shutdown; or
- Ownership recovered after attested graceful termination, with the previous manager exit recorded and all worker groups the manager opened proven empty.

Corollary: a `killActiveWorkers()` call merely tells a worker to begin exiting. Whether it has actually exited, and whether the signal reached it or its descendants, is an evidence question answered against process and resource witnesses, not against the signal API's return value.

---

## 2A. Refinement: independent enforcement when the manager receives SIGKILL

### 2A.1 Mechanism responsible for terminating worker and descendant processes

The only mechanism that survives a SIGKILL of the manager is an **independent containment sentinel supervising Linux cgroup v2 scopes**. Manager-based signal delivery stops as soon as the manager is returned for SIGKILL; worker-local deadlines only apply if the worker's event loop unblocks; a separate supervisor can be SIGKILLed only with arbitrary authority, which the trusted host controls.

- The manager creates a leaf cgroup for every worker:
  - `cgroup.type=domain`
  - `memory.max`
  - `cpu.max`
  - `pids.max` (controls how far a fork bomb could reach)
  - `cpuset.cpus` (optional but recommended)
- Before it forks the worker, the manager performs a cgroup assignment handshake with the sentinel. The handshake records `worker_id`, `cgroup_path`, `parent_pid` (manager), `manager_pid`, `created_at`, and `deadline`. The sentinel retains this registry; no new path is opened for a worker that only the manager can describe.

- The child is started with `PR_SET_PDEATHSIG` (Linux, direct child only; through a helper wrapper because the marker is per-thread). The signal (default SIGTERM) is delivered by the kernel if its parent goes away, without waiting for userspace to run.

- The sentinel itself is a separately-rooted process, launched before the manager's first fork. The manager registers each worker and the sentinel listens for a manager-loss condition (see §2A.2). The sentinel does not schedule work, restart workers, or modify the DB. Its sole job is containment and evidence collection.

- If cgroup permissions are absent, the runtime is operating in **degraded `report-only` mode**; see §2A.4 startup/failure behavior.

### 2A.2 Who invokes cgroup.kill if the manager has already exited

There are three distinctly accountable actors:

1. **Manager (while alive):** opens and owns the cgroup scope, registers workers, can kill blocked workers.
2. **Containment sentinel (independent):** records each worker's group at registration time; reacts when manager liveness fails, then executes `cgroup.kill` (cgroup v2 feature) against the registered scopes and records its own `{ts, scope, action, error}` log. No DB signal change.
3. **Kernel:** executes writes; if neither the manager nor the sentinel can exercise this (for instance on a degraded platform), the processes remain alive but the system has explicit evidence of the degraded mode because the sentinel can still report cgroup occupancy, absent errno.

Without the sentinel, the manager cannot kill its own children once it has exited. With only process-group (`-pgid`) semantics, a forked process that calls `setsid()` leaves the group. Cgroup kill is the final shared surface because the kernel membership is the authority before group leaders and descendants.

### 2A.3 Distinguishing enforcement classes

- **Cooperative deadline:** worker checks its own clock and exits. Efficient, deterministic only when the event loop is alive.
- **Parent-death notification:** `PR_SET_PDEATHSIG`. Strength: fires even on abrupt manager death. Limitation: direct child only, and it assumes the signal is not lost, blocked, or ignored.
- **Externally enforced process termination:** sentinel or another independent host actor invoking `cgroup.kill`, `kill -9 -pgid`, or procfs termination.
- In a supported system all three layers may contribute, but at least **(a) worker-local deadline**, **(b) cgroup membership**, and **(c) sentinel detection** are mandatory. A timeout alone is insufficient unless the sentinel can terminate the cgroup; a pdeath signal alone is insufficient once a process leaves its original process group.

### 2A.4 Supported platforms, cgroup capabilities, startup checks, and degraded behavior

**Supported platform (production target)**:

- Linux only. `prctl(PR_SET_PDEATHSIG)` does not exist on macOS or Windows.
- Kernel version: Linux `>= 5.3` (earlier: `cgroup.kill` missing, systemd scope fallback only).
- Cgroup mode: unified cgroup v2 control hierarchy mounted at `/sys/fs/cgroup`.
- Delegation: manager must run in a sub-cgroup that exposes `{cpuset,cpu,memory,pids}` and allows nested cgroup creation. On systems without delegation (for example some systemd or outer-namespace boundaries):
  - `cgroup.controllers` can't be written by the manager;
  - the sentinel degrades to `report-only`, reporting the missing controllers and active members.
- Runtime permissions: the manager process must be able to create child leaf cgroups and write `cgroup.kill`.
- Systemd configuration (`Delegate=yes`/`MemoryAccounting=yes`/`CPUAccounting=yes`/`TasksAccounting=yes`) is recommended but not hard-coded or required; if it is available the manager's direct checks use it conservatively.

**Startup checks**:

1. Detect the unified hierarchy and check read access to `/sys/fs/cgroup/cgroup.controllers`. If missing or read-permission denied, cgroup containment is unavailable.
2. Check write access in the manager's own cgroup and a trial nested leaf creation (empty + `cgroup.type`, etc). If unavailable, mark cgroup containment unsupported.
3. Check that the controllers actually requested by deployment (`cpu,memory,pids`) are in `cgroup.subtree_control` for the manager's cgroup. If any are missing, record the exact list in the degradation report.
4. Validate the sentinel binary/installation manifest/hash exists at startup; a hash or missing sentinel always downgrades to report-only mode.
5. Validate `PR_SET_PDEATHSIG` availability (Linux); if unavailable, keep the other layers and mark partial mode.
6. Validate that a dead-end kernel killing command such as `cgroup.kill` can be used on the trial leaf; if not available, mark `cgroup.kill` absent and retain manager-only enforcement plus report-only operation.

**Behavior when containment cannot be established**:

- The manager continues to function, with `containment` recorded as `degraded` in whatever operator-facing report exists (console/TUI/dashboard only today, no new SOR event type).
- In `degraded` mode the implementation is not permitted to assert worker termination based on this design because the sentinel or kernel guarantee is absent. It reports, never retires.
- Differential on restart: `pending`/`running` rows remain untouched; no scheduled sweep on age, no reprocessing classification. (Earlier agreement in S8-DESIGN holds.)
- The manager does not use advisory-lock availability to compensate for missing containment.

### 2A.5 Evidence and accounting constraints

- Containment evidence (post-cleanup state) is reported through arbitrary inspector tooling / manual audit only; no new SOR event can be introduced without separate approval.
- Accounting must not be affected by termination actions: only successful terminal `updateWorkerStatus` modifies accounting. Cgroup kill without resulting DB evidence records the orphan locally and does not mutate or automatically retry accounts.
- This must remain transparent to tools that report active inventory (for example focused counts) and to tests that exercise quotas.

## 3. Current process-tree behavior (demonstrated)

Evidence already collected:

1. `managerOwnership.test.ts` (integration, Vitest): `acquireManagerOwnership` fails closed against a competing manager in the same test database; a child manager process is refused at startup. Lock Release on graceful manager death is verified.
2. `ownershipLifecycleIntegration.test.ts`:
   - **Connection-loss path**: `pg_terminate_backend` on the manager's lock session causes `manager_ownership_lost (connection_error)`. `killActiveWorkers()` runs (direct children receive SIGTERM) and the manager calls `process.exit(2)`. Post-exit checks confirm no more `longWorker.mjs` survivors than baseline.
   - **Manager-death path**: `SIGKILL` of a manager while a realistic worker (`longWorker.mjs`, which neither traps SIGTERM nor has a self-timeout) is live leaves the worker alive / unbounded (`SIGKILL` (no exit handler possible) → child survives).
3. The transient probe observed an agent fork with default fork options and no worker-local timeout: the manager's `WORKER_TIMEOUT_MS` is advisory, and there is no enforcement once the manager is gone.

Observed limitations of the current implementation:

- SIGTERM escalation is absent: `killActiveWorkers()` is synchronous and only sends `SIGTERM` to direct children; processes with an explicit `SIGTERM` handler (e.g. `stubbornWorker.mjs`) will survive it. `WORKER_TIMEOUT_GRACE_MS` is not negotiated into this path.
- Descendants of the forked worker are not killed because the current kill only iterates `liveChildren` and does not walk the host's process tree or kill a group.
- No helper exists to report the number of processes alive in a worker's containment scope. The previous `pgrep`-based checks were adequate for manual verification but are not CI-grade evidence.
- A single timeout that is enforced only by the manager is not reliable in the face of manager death; only process-tree/cgroup enforcement survives the manager.

---

## 4. Requirements for hard execution limits

### 4.1 Time (`R-time`)

- Each worker gains a **worker-local wall-clock deadline** written by the manager into the child's environment as a monotonic epoch (`FLEET_WORKER_DEADLINE_MS`, already implied by `WORKER_TIMEOUT_GRACE_MS` semantics). The worker's main loop queries its own deadline and commits suicide (`process.exit(143)` or equivalent) when exceeded, independent of the manager. This is the only timeout that survives manager death.
- The manager may still enforce its own earlier deadline, but it must be treated as an optimization, not the containment source.
- Deadlines are calculated with `Date.now()` at fork and should include both the base `WORKER_TIMEOUT_MS` and any per-role override forwarded via `RunWorkerOpts`.
- Quarantine mode: workers that reached the *local* deadline must leave a terminal `failed` cause ("worker deadline exceeded") so the leak becomes measurable.

### 4.2 CPU and memory (`R-cpu`, `R-mem`)

- Working memory limits should be enforced with an absolute per-worker cgroup constraint configured by `FLEET_WORKER_CGROUP_LIMIT_MEM` (or a compiled default) — e.g. `memory.max=...` with `memory.swap.max=0`. Exceeding the constraint produces OOM-kill by the kernel, which is independent of the manager.
- CPU bandwidth throttling may use `cpu.max`, with a conservative cap, but CPU is better policy than safety: memory is the hard requirement because OOM can bring the host.
- These limits should initially be optional, default off on hosts without a writable cgroup v2 controller, but production defaults must be on for managed single-manager deployments.

### 4.3 Descendants, file handles, and resources (`R-desc`)

- Every worker must be forked in a dedicated process group (`setsid` / `POSIX_SPAWN_SETPGROUP`) so a single `kill(-pgid, SIGKILL)` reaches descendants that still share the group.
- A forked worker should set `PR_SET_PDEATHSIG` (Linux) so that it receives a terminal signal if the manager dies, even without a cooperative deadline.
- A non-cooperative worker can survive by:
  1. Being forked with `unshare(CLONE_NEWPID | CLONE_NEWNS)` plus a cgroup fork wrapper; or
  2. A worker that explicitly calls `setsid` or ignores the pdeath signal. In that case only the local deadline (which the child sets itself) reliably terminates it; the manager can keep a watchdog on `/proc` within the cgroup.
- Process monitoring should prefer kernel evidence (cgroup v2 `cgroup.procs` and `pids` controllers) plus manager-side `pidfd` descriptors. The existing `liveChildren` list is retained as a convenience and is not treated as proof of liveness.

### 4.4 Manager-side escalation (`R-esc`)

`killActiveWorkers()` is upgraded from a single signal into a ladder:

1. `SIGTERM` (current slow-default) for graceful in worker paths that support child shutdown.
2. `SIGKILL` at `T + WORKER_TIMEOUT_GRACE_MS`.
3. `kill(-pgid, SIGKILL)` after `T + 2 * grace` for cooperative children.
4. `cgroup.kill` after `T + 3 * grace` (cgroup v2 kernel kills all member tasks).

Ownership loss does not by itself strip a worker of its resources; the last step guarantees that when the owning manager's process group identity is lost, the cgroup kill is still scheduled by whatever manager replaces it — the replacement can reach cgroup kill by name. Graceful owner termination should always complete within the short escalation horizon.

### 4.5 Host and manager failure (`R-host`)

- The manager record in `run_outcomes` / a dedicated liveness signal remains the high-level witness: a manager should update a heartbeat only as a reporting mechanism (never for authorization) so operators can see whether work is stalled.
- If the host crashes/reboots, no process survives; the next manager observes `started_at` older than `grace` and has three options to act deterministically:
  - emulate ownership with a previous-manager grace window and only sweep after that window proves no new writes; or
  - never sweep on age alone, as currently decided (S8-DESIGN §3.2).
- SOR events are the chain-of-custody audit. Retiring a worker or a run still requires an explicit, committed CovEvent only if `SOR_SIGNING_KEY` can represent it. Until approval, remaining proposals report via console/TUI/dashboard only, as they are now.
- No host identification change is needed: OS-level evidence (`/proc/<pid>/stat` derivatives) is valid for this single-host deployment; multi-host would need an additional host-identity witness before reconciliation.

---

## 5. Evidence required to prove a worker has terminated

For a specific `worker_roles.role_id`, "no longer active" requires:

1. Terminal DB state (`success`, `failed`, `retired`) with `ended_at` accepted by the HTTP API path or by a successful manager-side transaction; or
2. A host-management action that records, in the same transaction as the absence check, a liveness assertion that "the worker's process group and cgroup are empty" via `cgroup.procs` + `pids` snapshot, plus either `pg_backend_pid` owner gone (for manager-replacement cases) or a `kill -0` check against every known PID (PID `0` and Zombie (`Z`) states should not be counted as alive).
3. Absence reports should include the count of processes observed, their PIDs, the cgroup membership list, the snapshot timestamp, and the verifier's identity (this manager's pid) so the evidence chain survives later review.
4. For liveness entering the reporting system, never accept a lack of DB updates for more than `WORKER_TIMEOUT_MS + grace` as proof — that is age reasoning and is expressly rejected by S8-DESIGN §3.2.
5. For crash-recovery evidence: after a failed host the surveillance subsystem (manager) must be able to note that it could not observe remains. Do not garbage-collect row in that case; leave rows and mark them `pending`/`running` with `started_at`; re-verify at next startup under the ownership model.

Suggested change to existing observers (not yet implemented):
- `killActiveWorkers()` should return both count killed and the post-loop residual process IDs, usable as evidence.
- `updateWorkerStatus` terminal writes already capture `ended_at`; no worker liveness assertion is required beyond that.
- A new read-only `identifyLiveWorkerProcesses` function can enumerate `/proc` for manager-interest pids, without modifying the `liveChildren` set or changing accounting.

---

## 6. Proposed phased implementation

### Phase 0 (existing work; safe and complete)

- Advisory ownership exclusive lock; manager death kills lock; unbounded stand-alone worker containment not yet provided.
- Observability on terminal DB writes.
- Run correlation + true `started_at`.
- Tests from `ownershipLifecycleIntegration.test.ts` already gather the process-tree facts above.

### Phase 1 (authority and contract changes — still gated here)

1. Fork options change: process group, `detached` semantics, and pdeath signals.
2. Add `FLEET_WORKER_WOS` permission wrapper (workshop) to start workers with explicit executor.
3. `child_process.spawn` replacement with fork-group kill logic.
4. Worker-local deadline + reporting outcome.
5. Cgroup v2 scaffolding (optional but recommended on supported hosts).

### Phase 2 (containment hardening)

1. Escalation ladder (R-esc).
2. Host-liveness reporting as metrics and SOR-safe audit events after separate approval (this document does not authorize them).
3. Evidence persistence in DB (new columns / `worker_roles` extension) requires review under AGENTS "Ask first".

### Phase 3 (reconciliation — still blocked)

1. Startup scan gated strictly on Phase 1 and 2 prerequisites.
2. Retirement only when Phase 3 evidence criteria hold.
3. Facilities for zombie process capture in `/proc` and later dry-run reporting.

Dependencies and gating (not to implement yet):

- Process-group and pdeath signal helpers should be verified on Linux; macOS can be unsupported with cold starts, since this is Linux-only target per env/arch.
- Cgroup v2 requires controller write access. On containers lacking writable `cpuset`/`memory` controllers, containment degrades to process-group-only, and evidence reports degradation.

---

## 7. Tests that demonstrate actual process-tree behavior

### 7.1 Tests already present

- `src/__tests__/ownershipLifecycleIntegration.test.ts::first_case`:
  - Manager holds lock while worker active;
  - `pg_terminate_backend` → manager status path and `killActiveWorkers` exhausts direct children;
  - manager exits 2;
  - post-exit, no more `longWorker.mjs` processes than baseline.
- `src/__tests__/ownershipLifecycleIntegration.test.ts::second_case`:
  - manager `SIGKILL` while worker active;
  - worker still present after parent death, cleaned up by test.
- `managerOwnership.test.ts::SIGKILL crash-releases lock`: lock goes free (verified before) but *does not* (and cannot) prove worker death.

### 7.2 Controlled tests required for containment approval (not yet implemented in production)

Each test is a controlled prototype. "Blocked" or "surviving" outputs must be
treated as expected baselines today, not as failures of the design.

- `control.ignored_sigterm_survives_current_strategy`:
  - Parent forks `stubbornWorker.mjs` which ignores SIGTERM.
  - Parent invokes `killActiveWorkers()`. Expected baseline:
    1. `killActiveWorkers()` returns `1`;
    2. direct process remains alive after 2 full grace cycles;
    3. only the direct child has a signal recorded, no escalation occurred.
  - Marks the pre-containment limitation explicitly, and must no longer
    survive under the proposed escalation ladder.
- `control.descendant_escape_current_strategy`:
  - chilled child forks a grandchild via `spawn(..., { detached: false })`
    and refuses `SIGTERM`; direct-child kill leaves the grandchild alive.
  - Adds a request check that the scope kill reaches both pid objects.
- `control.manager_exit_while_worker_active` already has an executed
  form in `ownershipLifecycleIntegration.test.ts::second_case`: manager
  receives `SIGKILL`, worker survives independently, test cleans up. This is
  expected independently-verified behavior and must remain documented.
- `control.blocked_worker_wakes_at_deadline`:
  - worker busy-loop not reading stdin; parent-side deadline kills. With
    cgroup containment, the deadline comes from process limits, not an event
    loop.
- `control.process_group_escape_cgroup_fallback`:
  - worker calls `setsid()` and moves to its own session. Process-group kill
    no longer targets it; cgroup kill does, requiring both group and cgroup
    evidence fields.
- `control.cgroup_budget_exhausted`:
  - worker exceeds `pids.max` or memory limit. Expected kernel refusal,
    watchdog detects and reports only.
- `control.sentinel_manager_lost`:
  - manager process loses its heartbeat file descriptor or cgroup session.
    sentinel runs cgroup kill; manager state is marked drained on return.
- `control.degraded_cap_mode`:
  - run in an environment without cgroup delegation, verifier records
    report-only and refuses to claim termination occurred.

These are evidence contracts, not implementation behavior.

### 7.3 Baseline bug hunt

Observed/factor-finding capture the containment gap. The current `killActiveWorkers()` fixed that fact.

Observed now:
- `killActiveWorkers` returns immediately after issuing SIGTERM. Without escalation, any worker that touched agent side-effects (network, subshell) before trustfully exiting can survive.
- No `liveChild` interface gives an actor in this repo destructor hooks.
- `liveChildren` is unexported; containing to only entity IDs works through process tree only.

---

## 8. Risk and stop conditions

Immediate blockers (not hardened yet):
- No process-group or cgroup creation code is present.
- No worker-side deadline clock is present.
- No evidence collection format in the DB.
- Host fails outright.
- Workers with a self-serving setsid (e.g. tool commands with `setsid`) can evade both.

If those prerequisites are not met, reconciliation remains **report only**.

---

## 9. Ask / next decisions

Before any code changes:

1. Authorize process group + pdeath signal implementation on Linux (`fork` options changes, worker C shim).
2. Decide whether cgroup v2 is a universal on-mode, feature-flag, or out-of-scope for containers without writable controllers.
3. Approve any evidence schema columns / export endpoints only after client-side audit deliverables.

This document does not authorize them.
EOF
echo done