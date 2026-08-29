---
title: Agent Factory — SoR System of Record Specification
status: locked
date: 2026-08-29
owner: ain
audience: implementation agents
revision: 2
supersedes: plan-sor.md
---

# Agent Factory — SOR (System of Record) Specification

## 0. Scope & document type

This is an **architecture/contract specification** that answers the seven standard spec
questions: **Goal** (§1), **User scenarios** (§2), **Functional requirements** (§3),
**Edge cases & rules** (§4), **Out of scope** (§18), and **Acceptance criteria** (§17).
Concrete types, DDL, and function signatures are decided per phase by implementers,
**subject to the contracts and invariants in this document** (HOW that was explicitly locked
in earlier review rounds — §8, §12, §15, §16, §21 — is retained here by decision).

## 1. Goal

The audit chain records what happened but cannot govern what may happen: agent capability is
decided by code alone, and agents answer from model memory rather than governed knowledge.
This SoR layer makes organizational truth authoritative — policy governs what agents **may
do** (enforced at execution), content governs what agents **know** (with provenance proof),
context describes the **situation** agents operate in, and the audit chain remains the
immutable evidence of what was known, decided, and done.

## 2. User scenarios

1. **Operator adds a capability:** when an operator upgrades the code adding a new tool, they
   see drift recorded (`policy_sync {kind:"drift-detected"}`) and the **old policy stays
   binding** until they run `sor:policy reconcile <role> <file>` — after which the new tool is
   active for that role. Until reconcile, agents with that role do **not** see the new tool.
2. **Agent answers from grounded knowledge:** when an agent queries Content SoR, every answer
   cites `{source, document, section, version, content_hash}`. When the source is unavailable,
   the agent **states it cannot answer from authoritative content** instead of guessing.
3. **Agent attempts a denied action:** when an agent calls a tool its policy denies (or an
   input a `toolRule` denies), the PEP returns **DENY before `impl.exec` runs** — the action
   leaves zero side effects, and a `policy_decision` event records the denial and reason.
4. **Operator provisions constraints:** when an operator provisions org constraints (allowed
   git hosts, push policy, worktree ownership) via CLI/config, every agent reads them as
   context with an explicit staleness marker `{state, fresh, staleAfter}` — stale-within-TTL
   usable only with caveat, beyond TTL treated as non-authoritative.

## 3. Functional requirements

Numbered requirements. **Ignoring any of these fails the build.** Each links to its
acceptance test (§17, AT-#) and, where applicable, a binding invariant. Grouped by domain.

### 3.1 Kernel

- **FR-1 — Kernel identity.** Every authoritative record carries
  `(sorType, sourceId, namespace, version, hash)`; no record exists without it.
  → AT-6, AT-8.
- **FR-2 — Canonical hash only.** A stored hash is computed from the record's canonical
  representation (§7.4), never from arbitrary serialization; on load, recomputed ≠ stored
  ⇒ the record is invalid and its domain fails closed. → AT-8, AT-9. *(K2)*
- **FR-3 — Derived references authoritative.** Every derived artifact (snapshot, index,
  cache, embedding) carries a resolvable reference `(sorType, sourceId, version, hash)` to
  its authoritative record; an artifact without one is never presented as an answer.
  → AT-8. *(K3)*
- **FR-4 — Provenance on output.** Every agent-facing SOR retrieval returns full provenance
  (content: `{source, document, section, version, content_hash}`; context:
  `{state, fresh, staleAfter}`; policy: decision + reason). → AT-1, AT-7. *(K4)*
- **FR-5 — Access model enforced.** Reads/writes honor §8; agent-facing surfaces are
  read-only; privileged writes occur only through manager/CLI entry points. → AT-3. *(K5)*

### 3.2 Policy

- **FR-6 — Effective grant intersection.** A tool executes iff it is in both the capability
  ceiling (`def.tools ∪ def.mcpAllow`) and the grant (`rules.allowedTools ∪ rules.mcpAllow`)
  and its inputs satisfy all applicable `toolRules`; otherwise **DENY before `impl.exec`**.
  Code may reduce capability but never silently grant. → AT-3, AT-4. *(P-I1)*
- **FR-7 — No drift overwrite.** `rules` is never auto-written when `source_hash` changes;
  drift is recorded and explicit reconciliation is required. → AT-5. *(P-I2)*
- **FR-8 — Mode resolution.** Exactly one enforcement mode (`sor | compatibility |
  fail-closed`) is resolved per spawn and immutable for the session; absent env ⇒ declared
  `compatibility`; invalid/tampered policy ⇒ `fail-closed`; configured-but-unreachable DB ⇒
  `fail-closed` for protected actions. → AT-3. *(P-I3, P-I4)*
- **FR-9 — Lifecycle.** Fresh installs seed version 1 as a capability snapshot; the only
  mutation paths are `seed` (insert-only) and explicit `reconcile`/`update` (CLI/admin).
  → AT-4, AT-5.
- **FR-10 — Decision evidence.** `policy_state` per session, `policy_sync` per
  mutation/drift, `policy_decision` per tool call in `sor`/`fail-closed` modes with
  ALLOW/DENY + reason. → AT-6.
- **FR-11 — Empty policy is zero-grant.** A role whose document has empty
  `allowedTools/mcpAllow/toolRules` is **valid** and grants nothing (mode stays `sor`).
  → AT-3.

### 3.3 Content

- **FR-12 — Canonical ingestion.** Authoritative documents are ingested from in-repo/org
  markdown paths by manual CLI sync; `content_sor` is the sole authoritative record;
  chunks/embeddings are derived. → AT-1. *(C1)*
- **FR-13 — Idempotent re-sync.** Re-ingesting an unchanged document emits no new version
  (`content_sync {kind:"unchanged"}`); changed content ⇒ new version,
  `kind:"updated"`. → AT-1, edge rules §4.4.
- **FR-14 — Unavailable ≠ no-match.** Retrieval failure ⇒ "knowledge source unavailable",
  the agent must not answer from model memory; a successful retrieval with no hits ⇒ the
  distinct "no authoritative content found for \<query\>". → AT-2. *(C2)*
- **FR-15 — Retrieval provenance contract.** Every retrieved item carries the §10.4 tuple
  and the MCP tool contract enforces it. → AT-1. *(C3)*
- **FR-16 — Evidence boundary.** `content_sync` always (per doc sync); `content_access`
  per policy (session aggregate default; per-call opt-in). → AT-6. *(C4)*

### 3.4 Context

- **FR-17 — Records & writers.** Context holds run-scoped operational state + org-level
  constraints; **agents never write**; unauthorized writes are rejected at the service.
  → AT-7. *(X1)*
- **FR-18 — Freshness contract.** Reads return `{state, fresh, staleAfter}`; base TTL with
  per-category overrides; beyond TTL is non-authoritative; within TTL usable with explicit
  caveat. → AT-7. *(X2)*
- **FR-19 — Versioned writes.** Every context write bumps `version` and emits
  `context_update` (with `prevVersion`); **no per-read events** by default. → AT-7.

### 3.5 Audit

- **FR-20 — Event-type widening.** New event types enter only via additive CHECK widening;
  the TS event layer (`SorEventType`/`VALID_TYPES`) moves in lockstep; existing chain
  rows/signer/key-registry/verify/repair are untouched. → AT-9. *(K7, §21.1)*
- **FR-21 — Non-fatal appends.** SOR audit appends never abort or undo an action; decisions
  stay authoritative (a deny is never downgraded). → AT-9. *(P-I5, K7)*
- **FR-22 — Forensic reconstruction.** Policy version/hash for any historical version is
  reconstructible from the chain (`policy_state` → `policy_sync` full-document embed).
  → AT-6.

## 4. Edge cases & rules (explicit)

### 4.1 Empty

- Empty policy document ⇒ **valid zero-grant** (FR-11), mode stays `sor`.
- Empty capability seed (`def.tools`/`def.mcpAllow` empty at seed) ⇒ seed produces an empty
  grant: zero tools for that role.
- Empty content corpus or no-match ⇒ "no authoritative content found" (FR-14), never
  "source unavailable" (which is a retrieval *failure*).
- Empty context record set ⇒ reads return `{state:{}, fresh:false, staleAfter:...}` per the
  freshness contract; an agent must not treat absence as authoritative fact.

### 4.2 Huge

- **Content chunking caps (locked):** per-chunk size cap **≈ 4000 chars** with **≈ 200 char**
  overlap; section-aware boundaries (§10.5). Exact values are finalized in Phase 3, but the
  caps exist to keep citations resolvable and embeddings bounded.
- **Audit payload caps:** `policy_decision` (and all SoR events) reuse the existing audit
  truncation contract — tool input/output truncated at **`TOOL_INPUT_CAP`/`TOOL_OUTPUT_CAP`
  (20 000 chars)**; huge tool args never bloat the chain.
- **`policy_decision` per-call volume** is the locked default; `content_access` stays
  aggregate to avoid a flooding analogue on retrieval (FR-16).

### 4.3 Duplicate

- Content re-sync of identical canonical content is **idempotent**: no version bump,
  `content_sync {kind:"unchanged"}` (FR-13).
- An explicit policy `reconcile`/`update` **always** writes the next version, even if the
  document content is unchanged — it is an explicit human action and the chain records the
  new versioned state.

### 4.4 Malformed

- **Policy:** malformed/undecodable/validation-failing rules ⇒ `fail-closed` at load
  (FR-8); a malformed *write* is rejected at the service (FR-9).
- **Context:** a malformed `operational_state` write is **rejected** at the service; no row
  is created (FR-17).
- **Content:** an unparseable source document produces a `content_sync` warning and a row
  with `status='invalid'` that is **never served** as authoritative (FR-12/C1).
- **Audit:** an event with an unknown `event_type` is rejected by `normalizeEvent` (TS layer)
  before it can reach the chain (FR-20).

### 4.5 Unauthorized

- A tool not in ceiling ∩ grant, or a call failing a `toolRule`, ⇒ **DENY before
  `impl.exec`**, side-effectless, with `policy_decision` recorded (FR-6, FR-10).
- Read-only Content/Context retrieval tools get **no P-I1 exemption** (§21.4) — grants govern
  them like any other tool; a worker without the grant simply lacks the tool.
- Agents **never write** context (FR-17); CLI policy commands (`seed`/`reconcile`) are
  privileged — a local user without admin identity cannot mutate policy (enforced at the CLI
  entry point).

## 5. Critical rule & definitions

> **The Agent Factory SoR Kernel provides authoritative, versioned, provenance-preserving
> sources of organizational truth that agents can retrieve and that execution can be
> governed against.**

> **Content SoR** tells agents what is authoritative knowledge.
> **Policy SoR** tells agents what they are authorized to do.
> **Context SoR** tells agents what authoritative operational state applies.
> **The audit chain** proves what was known, decided, and done.

- The SOR is the **authoritative domain contract** — never "the database." Postgres, pgvector,
  MCP, caches, snapshots, indexes, and workers are implementation mechanisms around it.
- Nothing outside the kernel may treat a derived artifact (snapshot, index, cache, embedding)
  as if it were the authoritative record.
- The kernel is **thin and domain-neutral**: shared lifecycle/identity primitives only. It is
  **not** a generic storage layer and **not** an "everything is JSONB" abstraction. Each domain
  owns its concrete schema and semantics.

## 6. Target architecture

```text
                         AGENT FACTORY
                         SoR KERNEL
                              │
       ┌──────────────────────┼──────────────────────┐
       │                      │                      │
       ▼                      ▼                      ▼
  CONTENT SOR             POLICY SOR            CONTEXT SOR
       │                      │                      │
  knowledge              authorization          operational
  corpus                  rules                  state
       │                      │                      │
       └──────────────────────┼──────────────────────┘
                              │
                    SOR service/API layer
                              │
                         MCP + internal
                              │
                              ▼
                            AGENT
                              │
                     ┌────────┴────────┐
                     │                 │
                  grounding          action
                     │                 │
                     │              PEP
                     │                 │
                     │              ALLOW
                     │                 │
                     └────────┬────────┘
                              ▼
                     ORGANIZATION SYSTEMS
                              │
                              ▼
                   IMMUTABLE AUDIT / PROVENANCE
```

## 7. SoR Kernel contract

### 7.1 Kernel primitives

| Primitive | Provided by kernel | Owned by domain |
|---|---|---|
| authoritative source identity | `(sor_type, source_id)` | — |
| namespace / tenant / vertical | `namespace` field; v1 = single reserved namespace `"fleet"` | which namespaces exist |
| versioning | ordinal-per-source `version` | how versions bump (seed/reconcile/ingest/update) |
| canonical representation | registered per-`sor_type` canonicalizer (§7.4) | the canonical form itself |
| content/policy hash | `computeCanonicalHash()` | what the hash covers |
| provenance | `SourceRef` + provenance shape; audit chain as evidence | external-source mapping |
| source synchronization | sync lifecycle (`sync` / `diff` / `drift`) | ingestion rules |
| retrieval | interface only | domain access/services |
| validation | validation entry point + fail-closed wiring | schema validators |
| access control | access model + enforcement check (§8) | per-domain permissions |
| audit/provenance events | event naming + chain append wiring (§12) | what deserves an event |
| fail-closed semantics | per-domain failure contract (§14) | domain rules |

### 7.2 SoR Record — identity/provenance shape (contract, not a storage schema)

```text
SoR Record
├── sor_type            "content" | "policy" | "context"
├── source_id           identity in the domain (doc id | role | tenant|project|workspace)
├── namespace           "fleet" (v1, single tenant)
├── version             domain ordinal
├── hash                canonical hash of the authoritative record (§7.4)
├── source_version / source_hash   external-source state at acquisition time
├── status              active | superseded | stale | invalid
├── provenance          who/what/where it came from, domain-shaped
└── timestamps          created_at, synced_at (authored_at for content)
```

**Locked:** identity columns are **denormalized into each domain table**
(`agent_registry` for policy, `content_sor`, `context_sor`). No shared `sor_records`
registry table in v1.

- **Locked:** `namespace` is a contract-level constant `"fleet"` carried in kernel types and
  audit event payloads — **not** a physical column in the domain tables in v1 (no tenant
  plumbing until multi-tenancy arrives).

### 7.3 Kernel invariants (K)

- **K1 — Contract, not mechanism.** The SOR is the authoritative domain contract; Postgres,
  pgvector, MCP, caches, snapshots, indexes are mechanisms. A derived artifact is consumed
  only via a resolvable reference to its authoritative record.
- **K2 — Universal identity.** Every authoritative record has
  `(sor_type, source_id, version, hash)`. `hash` is computed **only** from the canonical
  representation of the record — never arbitrary JSON serialization.
- **K3 — Derived can never become authoritative.** Every snapshot/index/cache carries a
  reference `(sor_type, source_id, version, hash)` to its source record. Artifacts without a
  resolvable reference are non-authoritative by construction.
- **K4 — Provenance on record and on output.** Every authoritative record carries provenance;
  every agent-facing retrieval returns it. "Where did this come from?" is always answerable.
- **K5 — PEP is the final boundary.** For protected actions, the execution boundary is the
  **policy evaluator before `impl.exec`**. Prompt text, tool-list exposure, and MCP availability
  are never the final authorization boundary.
- **K6 — Per-domain failure semantics.** Failure behavior is decided per domain (§14). There is
  no single universal fallback.
- **K7 — Chain preservation.** Audit appends remain NON-FATAL, trigger-enforced append-only,
  and verifiable (`sor:verify`) at all times. New event types are added by CHECK widening only
  (006 precedent). Signer, key registry, verify, repair, and historical-chain logic are untouched.

### 7.4 Universal identity & hash contract

Deterministic identity for every authoritative record:

```text
(content, source_id, version, hash)     e.g. book=v12, hash=ABC…
(policy,  role,      version, hash)     e.g. coder=v8,  hash=DEF…
(context, tenant|project|workspace, version, hash)   e.g. fleet|acme|proj-1=v41, hash=GHI…
```

Hash rules:

- `hash = sha256-hex` over the **canonical representation** of the authoritative record, where:
  - **policy / context:** deep key-sorted canonical JSON (keys recursively sorted, stable
    stringify — reuse the audit signer's canonicalization discipline).
  - **content:** canonical text normalization over the canonical document: Unicode NFC,
    normalized EOL (`\n`), trimmed, stable newline handling — **independent of chunking and
    embeddings**.
- The hash must never depend on derived artifacts (chunks, embeddings, snapshots).
- A record whose stored `hash` ≠ recomputed canonical hash is **invalid** and fails closed in
  its domain (FR-2).

## 8. Access model & protocols

### 8.1 Permission table (locked)

| Domain | Read | Write | Notes |
|---|---|---|---|
| **Content** | read (any agent) | ingestion/sync (manager/service + CLI) | agent-facing surface read-only |
| **Policy** | evaluate/read | **privileged write** (manager/CLI policy functions only) | PEP/evaluate is the agent path |
| **Context** | read | **controlled write** (manager boot + CLI/config) | agents never write |
| **Audit** | verify/read (`sor:verify`, dashboards) | **append-only** (trigger-enforced) | never UPDATE/DELETE |

### 8.2 Protocol separation (locked)

- **MCP is one access protocol, not the SOR.** MCP tool implementations call kernel domain
  services; no MCP-specific assumptions live inside the core domain model.
- **Locked:** for Content/Context, agent-facing read access is served by **manager-side
  read-only domain services exposed via the existing MCP plumbing** (read-only tools). Workers
  stay thin; DB access is centralized in the manager-side retrieval services.
- Internal API layering: `SoR Kernel → domain services → MCP / internal API → agents`.

## 9. Policy SoR v1 — first fully enforced domain

### 9.1 Contract & invariants (P)

```text
FleetAgentDef      = capability ceiling (never a grant)
Policy SoR         = authorization source of truth
Effective capability = FleetAgentDef ∩ Policy SoR
```

- **P-I1 — Effective authorization invariant.** A tool executes iff it is in both the
  capability ceiling (`def.tools ∪ def.mcpAllow`) **and** the policy grant
  (`rules.allowedTools ∪ rules.mcpAllow`), and its inputs satisfy all applicable `toolRules`.
  **Code may reduce capability but never silently grant authorization.** (FR-6)
- **P-I2 — No drift-overwrite.** On `source_hash` change, `rules` is **never** overwritten
  automatically. Drift is recorded (`policy_sync {kind:"drift-detected"}`) and requires
  explicit reconciliation. Existing policy stays authoritative until changed through the
  policy lifecycle. (FR-7)
- **P-I3 — Fail-closed.** Unverifiable/invalid/tampered policy never authorizes; affected calls
  are denied. Compatibility degradation exists only for **absence** of a policy source, never
  for **presence** of an invalid one. (FR-8)
- **P-I4 — Mode honesty.** Exactly one enforcement mode (`sor | compatibility | fail-closed`)
  is resolved at spawn, recorded in `policy_state`, and immutable for the session. (FR-8)
- **P-I5 — Non-fatal appends, authoritative decisions.** Audit appends stay non-fatal (never
  abort/undo). Decisions are enforced; a deny is never downgraded to warn-and-continue.
  (FR-21)

### 9.2 Data model (`agent_registry` = Policy SoR v1 table)

Per-role rows; `role` = `source_id`. Denormalized kernel identity + policy fields:

| Column | Meaning |
|---|---|
| `role` | `source_id` — e.g. `analyzer`, `planner`, `coder`, `tester`, `reviewer`, `pr` |
| `rules` | authoritative policy document (§9.3) |
| `policy_hash` | canonical hash of `rules` |
| `policy_version` | ordinal per role (chain is the version store) |
| `source_hash` | canonical hash of the current `FleetAgentDef` (the capability ceiling this policy was reconciled against) |
| `metadata` | JSONB: `systemPromptSha`, `skillsDir`, `capabilityTools[]`, `capabilityMcp[]` (the seed-time snapshot) |
| `synced_at` | timestamp |

### 9.3 Policy document schema (locked)

```ts
type PolicyDocument = {
  schemaVersion: 1;                       // document format version
  meta: { subject_role: string };         // must equal agent_registry.role
  allowedTools: string[];                 // granted fleet registry tool names
  mcpAllow: string[];                     // granted MCP tool names
  toolRules: Record<string, RulePredicate[]>;   // input-level predicates
};

type RulePredicate =
  | { op: "deny";    when: ArgumentMatcher }
  | { op: "require"; when: ArgumentMatcher };   // precondition for allow

// ArgumentMatcher vocabulary (examples; exact DSL is a Phase 2 implementation detail):
//   { path: "gitCommand", oneOf: ["push", "force-with-lease"] }
//   { path: "path", match: "regex" }
//   { path: "repo", notOneOf: [...] }
```

Semantics (locked): a call to tool `t` with input `i` is **ALLOWed** iff

```text
t ∈ allowedTools (or t ∈ mcpAllow for an MCP tool)
AND ∀ r ∈ toolRules[t]: r.op="deny"    ⇒ r.when(i) == false
AND ∀ r ∈ toolRules[t]: r.op="require" ⇒ r.when(i) == true
```

Tool name without entry in the effective registry ⇒ implicit DENY (unknown tools never execute).

### 9.4 Lifecycle (locked)

- **Seed** (fresh install): insert-only, `policyVersion = 1`, `rules =` **capability snapshot**
  of current `FleetAgentDef.tools ∪ def.mcpAllow` (empty `toolRules`). Seed-time snapshot stored
  in `metadata`.
- **Drift**: on `source_hash` mismatch (code capability changed) → record
  `policy_sync {kind:"drift-detected"}`. **No automatic write to `rules`.** (FR-7)
- **Reconcile** (locked): **explicit CLI/admin function** (`sor:policy reconcile <role> <file>`)
  validates the new document, writes the next `policyVersion`, updates `source_hash` to the
  current ceiling, emits `policy_sync {kind:"reconciled"}`. No two-step approval workflow in v1.
- **Update**: same path as reconcile (admin).
- **Validation**: schema+hash validation on store and on load. On-load mismatch ⇒
  `fail-closed` for that role (FR-2, FR-8). Raw SQL writes to `rules` are out of contract —
  detectable as `policyHash` mismatch vs chain history ⇒ fail closed.
- New capabilities in code **never** grant — they are only visible after reconcile.

### 9.5 Enforcement modes (locked resolution at spawn)

| Mode | When | Enforcement |
|---|---|---|
| `sor` | policy validated + loaded from DB | full PEP (registry ∩ rules + toolRules) |
| `compatibility` | **only** genuine absence: no `DATABASE_URL`, DB unreachable, no row/seed failed | static `def.tools` allowed (today's behavior), mode declared |
| `fail-closed` | policy present but invalid/malformed/hash-mismatch | **zero grants — every tool denied** |

- **Locked:** `compatibility` is ONLY for no-SOR-configured. A configured-but-unreachable DB
  fails closed for protected actions.

### 9.6 PEP — execution boundary

```text
agent request
    ↓
capability filter          (effective registry = ceiling ∩ grant)
    ↓
Policy SoR snapshot        (session policy, validated at spawn)
    ↓
policy evaluator           (tool name + parsed input vs toolRules)
    ↓
ALLOW / DENY
    ↓
impl.exec only on ALLOW
```

This strengthens existing tool gating; per-role toolsets and worktree cwd-locking are preserved.
The PEP lives in the worker's execution loop (`src/fleet/loop.ts`) before `impl.exec`. (FR-6)

### 9.7 Worker snapshot & env contract

- Manager resolves mode + snapshot at spawn; injects env:
  `SOR_POLICY_MODE`, `SOR_POLICY_HASH`, `SOR_POLICY_VERSION`, `SOR_POLICY_JSON_B64`.
- Worker emits `policy_state` at init; enforces per call; emits `policy_decision` (§12.2).
- **Absent env ⇒ declared `compatibility` baseline** (today's behavior) — with mode honesty.

### 9.8 Events

`policy_state` (per session), `policy_sync` (per mutation/drift), `policy_decision` (per call —
**locked: always**, in `sor`/`fail-closed` modes). (FR-10)

## 10. Content SoR v1

### 10.1 Pipeline & roles (locked)

```text
source document (org markdown paths)
    ↓  manual CLI sync (npm run sor:content:sync)
ingestion/sync — worker-child embedding (model calls stay in worker processes)
    ↓
canonical content (content_sor)
    ↓
section-aware chunks + metadata (content_chunks)
    ↓
Postgres / pgvector (+ lexical FTS)
    ↓
manager-side read-only MCP tools → agent
```

- **Sources (locked):** in-repo / org **markdown paths** (filesystem or git-tracked
  directories) — no HTTP fetch or GitHub plumbing in v1.
- **Cadence (locked):** **manual CLI sync** — no scheduler, no watcher.
- **Embedding (locked):** computed by a **worker child process spawned by the sync pipeline**
  (provider config worker-side; respects AGENTS.md "model calls only inside worker child
  processes"). Manager never calls models.

### 10.2 Data model

- **`content_sor`** — authoritative records. Denormalized kernel identity columns +
  `canonical_content` (the authoritative text), `metadata` (`title`, `source`, `document`,
  `section` index, `version`, `license`…), `provenance` (`externalRef`, `acquiredAt`,
  `source_hash`), `status`. One row per canonical document version.
- **`content_chunks`** — **derived** index. `(doc_id, version, section, chunk_index, text,
  content_hash, embedding vector)`. Each chunk carries the kernel reference tuple of its
  authoritative record (K3).
- **Hash distinction (locked):** `chunk.content_hash` is the **chunk-level text hash**
  (derived, used by the index); the provenance tuple's `content_hash` (§10.4) is the
  **canonical document hash** from `content_sor` — the authoritative identity that every
  retrieval resolves to (K3/C1).

### 10.3 Authoritative vs index (locked)

```text
AUTHORITATIVE    canonical content (content_sor)
                     ├──→ lexical index    (pg FTS / tsvector)   = derived
                     └──→ vector index     (pgvector)            = derived
```

> **C1 — Canonical content authoritative.** Embeddings and lexical tokens are retrieval indexes
> only; retrieval always resolves back to the canonical document. **pgvector is never the
> source of truth.** A vector hit with no resolvable authoritative record is not an answer.
> (FR-3, FR-12)

### 10.4 Provenance on every output

Every retrieved item carries, and the MCP tool contract enforces:

```text
{ source, document, section, version, content_hash }
```

> **C3 — Provenance on output.** No retrieval result without the full tuple above. Every answer
> built from Content SoR must be able to answer **"Where exactly did this come from?"**.
> (FR-4, FR-15)

### 10.5 Chunking & citations (locked)

- **Section-aware** chunking: respect document structure (title/heading/section boundaries)
  with a **per-chunk size cap ≈ 4000 chars and overlap ≈ 200 chars** for continuity (§4.2,
  exact values finalized in Phase 3).
- Every chunk stores `section` + `chunk_index`; provenance resolves
  `source → document → section → chunk → content_hash`.

### 10.6 Retrieval (manager-side read-only MCP tools)

- Similarity search (pgvector ANN) for ranking; **lexical (pg FTS) for deterministic lookup**.
  Both return provenance-tagged items resolved to canonical records.
- Read-only MCP tools (manager-side retrieval service, locked): `retrieve_knowledge(query,
  source?)`, `list_sources()`, `get_document(source, document, section?)`.
- Modifications exist only on the ingestion path — never on agent-facing tools.

### 10.7 Unavailable-source semantics (locked)

> **C2 — No fabrication.** If authoritative content cannot be retrieved, the agent must **not**
> answer from model memory as if it were SOR knowledge. (FR-14)

- Retrieval failure ⇒ tool returns "knowledge source unavailable"; agent states it cannot
  answer from authoritative content.
- Retrieve-succeeded-but-no-match is **distinct**: "no authoritative content found for
  `<query>`".
- **Enforcement (locked):** (a) worker **system-prompt grounding directive** (never claim
  SOR-backed knowledge without an actual retrieval; state source-unavailable when so), plus
  (b) the **retrieval tool contract** returning enforced provenance. Observable in outputs.

### 10.8 Sync semantics (idempotency & events)

- **Re-sync of an unchanged canonical document** is idempotent: no version bump,
  `content_sync {kind:"unchanged"}` (FR-13, edge §4.3).
- **Changed content** ⇒ new version, `content_sync {kind:"updated", status}`.
- **Unparseable source** ⇒ sync warning + row with `status='invalid'`, never served
  (edge §4.4).

### 10.9 Evidence boundary (locked, per C4)

- **`content_sync`** — always, one event per document sync/version
  (`{kind: added|updated|removed|unchanged, status}`).
- **`content_access`** — default **per-agent-session aggregate** (count, top sources,
  session id); **per-call logging is an opt-in config** for low-volume deployments. Rationale:
  retrieval volume can exceed chain value; per-retrieval logging is a config, not a contract.
  "Source unavailable" remains checkable (the failing retrieval's tool result records it; the
  absence of `content_access` entries corroborates the agent's claim). (FR-16)

## 11. Context SoR v1 — define now, implement minimum

### 11.1 Definition

Context SoR is authoritative **operational state** — not conversation history, not model
memory. No generic memory system will ever be built on it.

> **X1 — Operational state, not memory.** This domain stores authoritative operational state
> only; conversation and retrieval history live in traces/audit, never here. (FR-17)

### 11.2 Records (locked)

1. **Run-scoped operational state** derived from the product's `RunContext`: run id, repo,
   branch, worktree, environment, resource ownership.
2. **Org-level action constraints**: allowed git hosts, push policy, worktree ownership.

Key question: **"What authoritative context is this agent operating in?"**

### 11.3 Data model (`context_sor`)

- Composite `source_id` = `namespace|tenant|project|workspace` (v1: `fleet|…`).
- Denormalized kernel identity columns + `operational_state` JSONB (validated against a
  registered schema per context category), `fresh_until`, `stale_after`, `status`.

### 11.4 Freshness contract (locked, per X2)

- Reads return `{ state, fresh: boolean, staleAfter }`. (FR-18)
- **Within TTL:** stale state may be used **with an explicit caveat**.
- **Beyond TTL:** treated as non-authoritative — agent re-fetches or declines.
- **Locked:** base TTL for all categories **with per-category overrides** (e.g., org
  constraints vs ephemeral run state). Numeric defaults (base ~24h) are a Phase 4 detail,
  but the **mechanism** (base + overrides, explicit staleness markers) is contract.

### 11.5 Writes & reads (locked)

- **Writer roles (locked):** orchestrator/manager seeds run-scoped context at run start;
  org constraints provisioned via CLI/config. **Agents never write.** (FR-17)
- Read: any agent, via manager-side read-only service/MCP (staleness marker always returned).
- Controlled write enforced **in the service**, not by convention; malformed writes rejected.

### 11.6 Events

`context_update` on every versioned write (records previous version) (FR-19). **No per-read
events** (default) — reads are covered by evidence boundaries analogous to C4.

## 12. Audit chain integration

### 12.1 Preserved contract

The existing chain — append-only trigger, key HMAC rotation, `sor:verify`, `sor:repair`,
NON-FATAL appends — is **not replaced or weakened**. It is the provenance/evidence layer for
SoR operations, able to establish **which SoR / domain / version / hash / actor / decision /
action / result**. K7 and FR-20/FR-21 govern all changes.

### 12.2 Event registry (locked)

New event types added by **single additive CHECK widening** in migration 013 (006 precedent;
no backfill; existing rows untouched); the TS event layer moves in lockstep (§21.1):

| Event | Domain | Emitter | Always / Policy |
|---|---|---|---|
| `policy_state` | policy | worker init | always (per session) |
| `policy_sync` | policy | manager | always (per mutation/drift) |
| `policy_decision` | policy | worker | **always (per tool call in sor/fail-closed)** |
| `content_sync` | content | ingestion/sync | always (per document sync) |
| `content_access` | content | retrieval service | **per policy** (session aggregate default; per-call opt-in) |
| `context_update` | context | context service | always (per versioned write) |

**Payload shape (locked):**

```text
base:  { sorType, sourceId, namespace:"fleet", version, hash, actor, ts }
policy_decision adds: { decision:"ALLOW"|"DENY", action, result:"ok"|"blocked"|"error", reason }
policy_state adds:    { mode:"sor"|"compatibility"|"fail-closed", policyVersion, policyHash, sourceHash }
policy_sync adds:     { kind:"seeded"|"reconciled"|"updated"|"drift-detected", prevVersion, document? }
content_sync adds:    { kind:"added"|"updated"|"removed"|"unchanged", status }
content_access adds:  { sessionId, mode:"aggregate"|"percall", count, topSources[] }
context_update adds:  { prevVersion }
```

- `policy_sync.document` (full policy document) is embedded on
  `seeded|reconciled|updated` — the chain is the policy version store; it is omitted on
  `drift-detected`.
- Audit payload truncation caps apply to all events (§4.2).

### 12.3 Forensic reconstruction

- Policy version/hash is reconstructible: `policy_state` (session claim) → `policy_sync`
  (full document embed) for any historical `policyVersion`. (FR-22)
- `sor:verify` stays green through all phases; parity/verify tests cover new event types.

## 13. Agent interaction model

- **Grounding** — `Agent → Content SoR → authoritative knowledge`. "What should I know?"
  Read-only retrieval with mandatory provenance; never guessing on unavailability.
- **Acting** — `Agent → Policy SoR → authorization → PEP → organization system`. "What am I
  allowed to do?" Every protected action clears the PEP under the session's policy snapshot.
- **Context** — `Agent → Context SoR → authoritative operational state`. "What situation am I
  operating in?" Read with explicit freshness.
- **Phase 5 (later):** consistent conceptual client (`retrieve knowledge`, `retrieve context`,
  `evaluate policy`, `record provenance`) over domain-specific semantics underneath.

## 14. Failure semantics per domain (locked — no universal fallback)

| Domain | No SOR configured | Unavailable | Invalid/tampered |
|---|---|---|---|
| **Policy** | `compatibility` (declared, P-I4) | **fail closed** for protected actions (configured-but-unreachable DB) | **fail closed** (P-I3) |
| **Content** | n/a | never guess; "source unavailable" (C2 / FR-14) | treat as unavailable — never serve unverifiable content |
| **Context** | n/a | staleness window (X2); beyond TTL ⇒ non-authoritative | fail closed / non-authoritative |

Freshness contracts: policy = per-session snapshot; content = document version; context =
explicit `fresh_until`/`stale_after`.

## 15. Migrations & dependencies

| Migration | Domain | Contents |
|---|---|---|
| `013_sor_policy_events.sql` | audit | **one additive CHECK widening** for all new event types (§12.2) |
| `014_agent_registry_policy.sql` | policy | `policy_hash`, `policy_version` columns + legacy backfill (§21.3) |
| `015_content_sor.sql` | content | `content_sor`, `content_chunks`, `CREATE EXTENSION vector` |
| `016_context_sor.sql` | context | `context_sor` with freshness fields |

- pgvector requires **Postgres ≥ 14** with the extension available on the deploy target.
- `.env.example` updated for any new env vars (Phase 2: none beyond existing; Phase 3:
  content sync config, optional `CONTENT_SAMPLE_RATE`, content MCP base URL).
- Migrations `013`–`016` provide DOWN scripts; the test tail asserts the sequential
  UP/DOWN round-trip (§21.6).
- All changes keep `npm run sor:verify` green.

## 16. Phases & first slice

| Phase | Deliverable |
|---|---|
| **1** | SoR Kernel contract + scaffolding: `src/sor/kernel/{types,hash,provenance,access}.ts` + unit tests. No large refactor. → done checklist §17.2 |
| **2** | **Policy SoR v1 end-to-end** (§9): migrations 013/014, `src/fleet/policy.ts`, `policyEval.ts`, `agent_registry` seed/load/reconcile, PEP in `loop.ts`, snapshot env in `agentRunner`/worker, policy events, tests. Touchpoint file map: §21.5. → done checklist §17.3 |
| **3** | Content SoR v1 (§10): migration 015 + pgvector, markdown ingestion CLI, worker-child embedding, chunking, retrieval service + read-only MCP tools, `content_sync`/`content_access`, C2 prompt directive. → done checklist §17.4 |
| **4** | Context SoR v1 (§11): migration 016, run-scoped seed in manager boot, org-constraint CLI, freshness markers, `context_update`. → done checklist §17.5 |
| **5** | Unified agent surface (§13, four operations) — preserves domain semantics. |
| **6** | Cross-domain acceptance tests (§17.1). |

**First code slice (locked):** **Phase 1 kernel scaffolding + Phase 2 Policy SoR.**
Every commit green: `npm run typecheck && npm test`; `npm run sor:verify` re-checked.
SPEC §17 ticked for any SPEC-affecting work (per AGENTS.md).

## 17. Acceptance criteria

### 17.1 Cross-domain acceptance tests (the ten)

| # | Test | Linked FRs |
|---|---|---|
| AT-1 | Content retrieved from SOR includes exact provenance `{source, document, section, version, content_hash}` | FR-4, FR-12, FR-15 |
| AT-2 | Content SOR unavailable → agent does not guess (states source unavailable) | FR-14 |
| AT-3 | Policy SOR denies unauthorized tool → `impl.exec` never runs (no side effect) | FR-5, FR-6, FR-8, FR-11 |
| AT-4 | Code capability cannot exceed policy authorization | FR-6, FR-9 |
| AT-5 | Policy drift cannot silently grant permissions | FR-7, FR-9 |
| AT-6 | Policy version/hash reconstructible from the audit chain (`policy_state` → `policy_sync` → full document) | FR-1, FR-10, FR-16, FR-22 |
| AT-7 | Context versioned; freshness explicit and honored | FR-4, FR-17, FR-18, FR-19 |
| AT-8 | Derived indexes/snapshots cannot become authoritative accidentally — vector hit with no resolvable record is not an answer | FR-1, FR-2, FR-3 |
| AT-9 | Existing audit chain remains verifiable (`sor:verify` green through all phases) | FR-2, FR-20, FR-21 |
| AT-10 | An agent consumes Content + Context + Policy without treating any of them as model memory (behavioral: prompt-injected non-SOR knowledge is not cited as grounded) | FR-5 |

### 17.2 Per-phase done checklists

**Phase 1 — Kernel scaffolding.**
- [x] `src/sor/kernel/{types,hash,provenance,access}.ts` present with the identity tuple,
      canonical-hash registry (§7.4), provenance, and access types.
- [x] Unit tests cover FR-1..FR-5 at type/hash level.
- [x] `npm run typecheck && npm test` green; `npm run sor:verify` green.

**Phase 2 — Policy SoR v1.**
- [ ] Migrations `013` + `014` up/down round-trip; `013` CHECK widening includes all six types
      and `src/sor/events.ts` union moves in lockstep (§21.1).
- [ ] `014` legacy backfill per §21.3 (legacy rows = seeded v1; `policy_hash` at first boot).
- [ ] `ensurePolicyRegistry`/`loadRolePolicy`/`reconcileRolePolicy` replace dormant
      `syncAgentRegistry`; appends stay NON-FATAL.
- [ ] Mode resolution at spawn (§9.5) with `SOR_POLICY_*` env injection; worker builds the
      effective registry and emits `policy_state`.
- [ ] PEP before `impl.exec` enforces FR-6 + FR-11 (input-level `toolRules`; unknown tools deny).
- [ ] `policy_decision` per call in `sor`/`fail-closed`; `policy_sync` on mutations; payloads
      per §12.2 with truncation caps (§4.2).
- [ ] CLI `sor:policy seed | reconcile <role> <file> | show <role>` wired in `src/index.ts`.
- [ ] FR-6..FR-11 held; AT-3, AT-4, AT-5, AT-6 green; typecheck + tests + `sor:verify` green.

**Phase 3 — Content SoR v1 (stub-level).**
- [ ] Migration `015` + pgvector; markdown-path ingestion CLI; worker-child embedding;
      section-aware chunking with caps (§4.2); manager-side read-only MCP tools; provenance on
      output; unavailable ≠ no-match; idempotent sync; evidence boundary; C2 prompt directive.
- [ ] FR-12..FR-16 held; AT-1, AT-2 green.

**Phase 4 — Context SoR v1 (stub-level).**
- [ ] Migration `016`; run-scoped seed at boot + org-constraint CLI; freshness markers;
      `context_update`; write rejection for agents.
- [ ] FR-17..FR-19 held; AT-7 green.

**Phase 5 — Unified surface.** Conceptual client (§13) over domain services; no regressions.

**Phase 6 — Verification.** Full AT suite green in one pass; `sor:verify` green.

## 18. Out of scope / explicit non-goals

- Generic "everything is JSONB" kernel storage; generic memory system; Context SoR as
  conversation/memory.
- Weakening the audit chain, append-only trigger, key rotation, verify/repair, NON-FATAL
  appends.
- Live/online PEP over IPC in v1 (spawn-time snapshots; quota IPC is a later option).
- Admin policy-editing UI or content curation UI; **no self-serve admin UI for
  policy/content**.
- Embeddings as truth; retrieval without a resolvable authoritative record (K3/C1).
- Prompt/tool-list/MCP as the authorization boundary (K5).
- **No HTTP-fetched content sources in v1** (markdown paths only, §10.1).
- **No GitHub-repo content syncing in v1.**
- **No scheduler/watcher for content sync in v1** (manual CLI only).
- **No multi-tenant** in v1 — reserved namespace `"fleet"` (§7.2).

## 19. Phase-implementation deferred details (explicitly NOT locked here)

- `RulePredicate`/`ArgumentMatcher` exact DSL syntax, tool-path vocabulary (Phase 2).
- Policy registry module layout beyond the named files (§16, §21.5).
- Exact chunk size cap/overlap numbers within the §4.2 bounds (~4000/~200) (Phase 3).
- Embedding provider/model selection & quota wiring (worker-side config; Phase 3).
- Context TTL numeric defaults & per-category taxonomy within the §11.4 mechanism (Phase 4).
- Manager-side service/MCP endpoint naming for content & context (Phases 3–4).

## 20. Decision log (locked via clarification interview + residue review, 2026-08-29)

| # | Topic | Locked decision |
|---|---|---|
| 1 | Spec placement | repo root `sor-spec.md`; **supersedes `plan-sor.md`** (retired on placement) |
| 2 | Spec level | architecture/contract spec (implementers decide types/DDL per phase) |
| 3 | Kernel identity storage | **denormalized identity columns per domain table** |
| 4 | Tenancy | **single-tenant**, reserved namespace `"fleet"` |
| 5 | Policy seed | **capability snapshot** (v1); reconciliation after |
| 6 | Compatibility gate | **no-SOR-configured only**; unreachable configured DB fails closed |
| 7 | Content sources v1 | in-repo/org **markdown paths** |
| 8 | Ingestion cadence | **manual CLI sync** |
| 9 | Embedding execution | **worker-child embed at sync** (models stay in workers) |
| 10 | pgvector | **included now** — migration 015, `CREATE EXTENSION vector`, PG14+ |
| 11 | content_access boundary | **session aggregate default, per-call opt-in** |
| 12 | Context v1 records | **RunContext-derived + org action constraints** |
| 13 | Context freshness | **base TTL + per-category overrides**; reads return `{state, fresh, staleAfter}` |
| 14 | Retrieval hosting | **manager-side read-only services via MCP** |
| 15 | policy_decision volume | **always per tool call** in sor/fail-closed modes |
| 16 | Event payload/names | **confirmed as proposed** (§12.2) |
| 17 | First implementation slice | **Phase 1 kernel scaffolding + Phase 2 Policy SoR** |
| 18 | Policy document schema | `allowedTools + mcpAllow + toolRules` (§9.3) |
| 19 | Reconciliation | **explicit CLI reconcile**; no automatic writes to rules |
| 20 | Context writers | **manager boot (run-scoped) + CLI/config (org constraints)**; agents never write |
| 21 | Grounding honesty (C2) | **prompt directive + retrieval tool contract** |
| 22 | Chunking | **section-aware with cap + overlap**; `section` + `chunk_index` stored |
| 23 | TS event layer (residue) | moves in lockstep with migration 013 — `SorEventType` + `VALID_TYPES` gain all six new types (§21.1) |
| 24 | `policy_state`/`policy_sync` payloads (residue) | locked — §12.2 |
| 25 | 014 backfill for existing installs (residue) | legacy rows = **seeded v1**; `policy_hash` computed at first manager boot (§21.3) |
| 26 | Read-only tool policy (residue) | **no P-I1 exemption** — grants govern read tools exactly like any other tool (§21.4) |
| 27 | Policy implementation touchpoints (residue) | file map locked — §21.5 |
| 28 | Migration DOWN scripts (residue) | 013–016 reversible; sequential UP/DOWN round-trip asserted (§21.6) |
| 29 | Goal section (this round) | **approved as drafted** — §1 |
| 30 | User scenarios (this round) | **4 scenarios** — §2 |
| 31 | FR structure (this round) | numbered FR list + acceptance links (§3); invariants retained |
| 32 | Empty policy (this round) | **valid zero-grant doc**, mode stays `sor` (FR-11) |
| 33 | Content re-sync (this round) | **idempotent**; unchanged ⇒ no bump, `content_sync {kind:"unchanged"}` (FR-13) |
| 34 | Huge-input caps (this round) | chunk cap **≈4000 chars / overlap ≈200**; SoR events reuse `TOOL_INPUT_CAP`/`TOOL_OUTPUT_CAP` (20k) |
| 35 | Malformed writes (this round) | **reject** policy/context at service; content ⇒ `status='invalid'` row, never served |
| 36 | Out-of-scope additions (this round) | §18 adds: no HTTP fetch, no GitHub syncing, no scheduler/watcher, no multi-tenant, no self-serve admin UI |
| 37 | Acceptance structure (this round) | per-phase done checklists + AT-1..AT-10 with FR links (§17) |
| 38 | HOW placement (this round) | **keep HOW in the spec** (no split into a separate design doc) |

## 21. Residue locks — Phase 2 implementation touchpoints

Resolves the six gaps found in the spec review. Implementers MUST satisfy these alongside
§9, §12, §15, and §16 on the first slice.

### 21.1 Events — TS layer moves with migration 013

- In the **same change** as `013_sor_policy_events.sql`, extend `src/sor/events.ts`:
  `SorEventType` union and `VALID_TYPES` gain all six types (`policy_state`, `policy_sync`,
  `policy_decision`, `content_sync`, `content_access`, `context_update`).
- `normalizeEvent` must accept them; existing types are never removed.
- The DB CHECK widening (013) and the TS union MUST land together: a widened DB with a
  rejecting TS normalizer breaks every `sorEmit` call, which is both wrong and fatal-looking
  even though appends are non-fatal. (FR-20)

### 21.2 Policy event payloads

As defined in §12.2, including `policy_state` (`mode`, `policyVersion`, `policyHash`,
`sourceHash`) and `policy_sync` (kind; `document` embedded except on `drift-detected`).

### 21.3 Migration 014 backfill semantics (existing installs)

- 014 adds `policy_hash TEXT` (nullable) and `policy_version INTEGER NOT NULL DEFAULT 1` to
  `agent_registry`.
- Existing rows: `policy_version = 1`; legacy `rules` stay authoritative — they are treated as
  **seeded v1**, consistent with §9.4 seed semantics.
- `policy_hash` for legacy rows is computed from the **canonicalized existing `rules`** and
  persisted at **first manager boot** (`ensurePolicyRegistry`), before any drift check. The
  migration itself does not hash JSON.
- `metadata` keeps its existing shape across the transition; `capabilityTools[]` /
  `capabilityMcp[]` are reconciled at first boot.
- Fresh installs seed exactly per §9.4.

### 21.4 Policy ⇄ read-only tools — no exemption

- Content/Context retrieval tools follow **P-I1 exactly**: a tool executes only if it is in
  both the capability ceiling (`def.tools ∪ def.mcpAllow`) AND the policy grant
  (`rules.allowedTools ∪ rules.mcpAllow`). **There is no auto-allow exception.** (FR-6)
- Consequence (deliberate): the fresh-install seed (capability snapshot) grants them by
  default; an org denies read access by not granting or by removing the tool from the ceiling.
  A worker without the grant simply has no such tool, and grounding degrades per C2
  (state source unavailable — never fabricate).

### 21.5 Manager-side touchpoints (file map)

| File | Change |
|---|---|
| `src/sor/events.ts` | union + `VALID_TYPES` + `normalizeEvent` per §21.1 |
| `src/db/audit.ts` | replace dormant `syncAgentRegistry` with `ensurePolicyRegistry`, `loadRolePolicy`, `reconcileRolePolicy`; appends stay NON-FATAL |
| `src/fleet/policy.ts` | new — policy validation, canonical hash, document codec (`SOR_POLICY_JSON_B64`) |
| `src/fleet/policyEval.ts` | new — PEP evaluator (tool name + parsed input vs `toolRules`) |
| `src/fleet/loop.ts` | PEP step before `impl.exec` |
| `src/agentRunner.ts` | resolve mode + snapshot at spawn; inject `SOR_POLICY_MODE/HASH/VERSION/JSON_B64` |
| `src/runtime/worker/main.ts` | parse env, build effective registry, emit `policy_state`, feed PEP into the loop |
| `src/index.ts` | CLI: `sor:policy seed \| reconcile <role> <file> \| show <role>` |
| `src/fleet/sorEmit.ts` | sink is event-agnostic; verify it forwards new types unchanged |

### 21.6 Migration DOWN scripts

- `013`–`016` each provide a DOWN that restores the prior CHECK (`013`) or drops added
  columns/tables (`014`–`016`).
- The migration test tail asserts the sequential `013 → 016` UP/DOWN round-trip.