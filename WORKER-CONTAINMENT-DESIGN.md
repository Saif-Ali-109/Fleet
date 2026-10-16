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

### 7.2 Tests needed for containment approval (proposed, not yet implemented)

These are explicitly drafted to emulate real process systems, not advisory evidence.

- `procs._terminate_premise_test`: Fork a child that itself spawns a grandchild. Verify the current direct-child SIGTERM strategy leaves `grandchild_worker` alive — report that and add the process-group remediation only after approval.
- `cgroup_accountancy_check`: Child enters memory stress and OOMs; verify manager receives 137 and marks the DB row failed, rather than leaving it pending.
- `pdeath_signal_check`: Manager deliberately dies, but the worker sets `PR_SET_PDEATHSIG` and terminates within a observed cap (suggest 2 s). Use a small C or Rust helper or a Node N-API module to set `prctl`; do not attempt to rely solely on fork flag.
- `escalation_check`: Stubborn child that traps SIGTERM must still be gone after 3 × `WORKER_TIMEOUT_GRACE_MS` with process-group kill.
- `descendant_escape_check`: Child calls `setsid()`; verify cgroup still kills everything while process-group kill fails.
- `host_crash_evidence_check`: Simulated absence of DB heartbeat/report; manager must refuse to retire and just report.

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