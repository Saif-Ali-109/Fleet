---
title: "SoR — implementation plan (Phase 1 kernel + gap fixes + Phase 2 Policy SoR v1)"
status: active
date: 2026-08-29
owner: ain
audience: implementation agents
revision: 3
derived-from: sor-spec.md (revision 2)
---

# SoR — implementation plan (Phase 1 kernel + gap fixes + Phase 2 Policy SoR v1)

Build plan for the **first code slice** (spec §16 / §17.2 + §17.3): the domain-neutral
**SoR Kernel contract + scaffolding**, then the **real-bug gap fixes** in the existing
signed audit chain, then **Phase 2 Policy SoR v1** end-to-end (spec §9, §12, §15, §16,
§17.3, §20, §21). Each phase lands on a green tree. Content/Context (spec §10/§11) are
explicitly out of scope here and pointed to as later phases.

This revision (3) supersedes revision 1, which covered only Phase 1 kernel scaffolding.
Revision 3 keeps that plan (lightly polished) and adds the gap-fix and Phase 2 sections.

---

## PART A — Phase 1: SoR Kernel scaffolding (unchanged from rev 1, lightly polished)

Build plan for **Phase 1 only** (spec §16 / §17.2): the domain-neutral **SoR Kernel
contract + scaffolding**. Delivers `src/sor/kernel/{types,hash,provenance,access}.ts`
plus unit tests. **No DB, no migrations, no policy/content/context logic, no chain
changes.** Pure TypeScript (no I/O), fully unit-testable without a database.

### A1. Purpose

Give the SOR domains a shared, tested contract layer so Phase 2+ can build on stable
identity, hashing, provenance, and access primitives.

### A2. Locked contract inputs (from sor-spec.md)

| Spec ref | What it forces |
|---|---|
| FR-1 (Kernel identity) | `(sorType, sourceId, namespace, version, hash)` on every authoritative record |
| FR-2 (Canonical hash only) | hash = sha256-hex over **canonical representation** only; mismatch ⇒ invalid ⇒ fail-closed |
| FR-3 (Derived refs) | `SourceRef` `(sorType, sourceId, version, hash)` on derived artifacts; no ref = non-authoritative |
| FR-4 (Provenance on output) | content tuple `{source, document, section, version, content_hash}`; context `{state, fresh, staleAfter}` |
| FR-5 (Access model) | §8.1 permission table enforced by a pure check |
| §7.4 (hash rules) | content → canonical text normalization; policy/context → deep key-sorted canonical JSON; never depends on derived artifacts |
| §17.2 (Phase 1 Done) | the three-item checklist this plan must fully satisfy (mapped in §A7) |

### A3. Deliverables (file map)

| File | Contents | Status |
|---|---|---|
| `src/sor/kernel/types.ts` | identity, record, ref, status, provenance-source types | **new** |
| `src/sor/kernel/hash.ts` | canonicalization + self-hash registry + verify/assert | **new** |
| `src/sor/kernel/provenance.ts` | output-tuple builders/validators + freshness | **new** |
| `src/sor/kernel/access.ts` | §8.1 permission table as a pure check | **new** |
| `src/sor/kernel/index.ts` | barrel export | **new** |
| `src/sor/kernel/__tests__/{types,hash,provenance,access}.test.ts` | unit tests, test-led | **new** |

Imports use explicit `.ts` extensions. No new runtime dependencies (`node:crypto`
already used by `src/sor/signer.ts`).

### A4. Module specifications

#### A4.1 `src/sor/kernel/types.ts` — identity, record, refs (FR-1, FR-3)

```ts
export const RESERVED_NAMESPACE = "fleet" as const; // namespace is a contract constant, not a DB column
export type Namespace = typeof RESERVED_NAMESPACE;

export type SorType = "content" | "policy" | "context";
export type SorStatus = "active" | "superseded" | "stale" | "invalid";

export interface SourceProvenance {
	externalRef?: string;
	acquiredAt?: string;             // ISO timestamp
	sourceHash?: string;
	acquiredBy?: string;
	acquiredFrom?: string;
}

export interface SorRecordIdentity {         // FR-1 / K2: universal identity
	sorType: SorType;
	sourceId: string;
	namespace: Namespace;                    // always "fleet" in v1
	version: number;                         // ordinal per sourceId
	hash: string;                            // canonical self-hash (FR-2)
}

export interface SorRecord extends SorRecordIdentity {
	status: SorStatus;
	sourceVersion?: string;
	sourceHash?: string;
	provenance: SourceProvenance;
	createdAt: string;                       // ISO
	syncedAt?: string;                       // ISO
}

export interface SourceRef {                 // K3 / FR-3: resolvable reference on derived artifacts
	sorType: SorType;
	sourceId: string;
	version: number;
	hash: string;
}

export function isSorRecordIdentity(x: unknown): x is SorRecordIdentity;
```

TODO:
- [ ] T1.1 Define the types above; `namespace` is the literal `"fleet"` type, never a runtime string value.
- [ ] T1.2 `isSorRecordIdentity` guard used by hash/provenance load paths (invalid ⇒ fail-closed callers).
- [ ] T1.3 Mirror repo formatting (tabs, `interface` over `type`) — match `src/sor/signer.ts` style.

#### A4.2 `src/sor/kernel/hash.ts` — canonicalization + self-hash (FR-2, §7.4)

```ts
export function sha256Hex(input: string): string;
export function canonicalizeText(text: string): string;   // §7.4 content rules
export function canonicalizeStructured(body: unknown): string; // delegate to ../signer.ts canonicalJson
export function canonicalRepresentation(input: { sorType: SorType; body: unknown }): string;
export function computeCanonicalHash(input: { sorType: SorType; body: unknown }): string;
export function verifyCanonicalHash(record: SorRecordIdentity, body: unknown): boolean;
export function assertCanonicalHash(record: SorRecordIdentity, body: unknown): void;
```

Design rules: structured path **delegates to `src/sor/signer.ts` `canonicalJson`** (single
discipline, no fork). Text path is content-domain only, independent of chunking/embeddings.
The `hash` field is excluded from every canonical body — tested explicitly.

TODO:
- [ ] T2.1 `sha256Hex` + `canonicalizeText` (BOM, NFC, `\r\n`/`\r`→`\n`, trim line/corpus edges).
- [ ] T2.2 `canonicalizeStructured` as a **delegate** to `canonicalJson`.
- [ ] T2.3 Dispatcher, `computeCanonicalHash`, `verifyCanonicalHash`, `assertCanonicalHash`.
- [ ] T2.4 Tests (§A5.2) incl. locked vectors.

#### A4.3 `src/sor/kernel/provenance.ts` — output contract (FR-4, C3, X2)

```ts
export interface ContentProvenance { source: string; document: string; section: string; version: number; contentHash: string; }
export interface ContextProvenance { state: unknown; fresh: boolean; staleAfter: string; }
export function contentProvenanceOf(input: { ref: SorRecordIdentity; source: string; document: string; section: string }): ContentProvenance;
export function assertContentProvenance(p: ContentProvenance): void;
export function freshnessOf(input: { updatedAt: string; ttlMs: number; now?: string }): ContextProvenance;
export function sourceRefOf(identity: SorRecordIdentity): SourceRef;
```

TODO:
- [ ] T3.1 Tuple types exactly as above (field names are contract — C3).
- [ ] T3.2 `contentProvenanceOf` / `assertContentProvenance` (rejects missing fields + non-hex `contentHash`).
- [ ] T3.3 `freshnessOf` (strict — `now == staleAfter` ⇒ `fresh: false`).
- [ ] T3.4 `sourceRefOf`.

#### A4.4 `src/sor/kernel/access.ts` — §8.1 permission table (FR-5)

```ts
export type AccessPrincipal = "agent" | "manager" | "cli" | "service";
export type AccessOperation = "read" | "write";
export type AccessDomain = SorType | "audit";
export interface AccessDecision { allowed: boolean; domain: AccessDomain; operation: AccessOperation; principal: AccessPrincipal; note?: string; }
export function checkAccess(domain, operation, principal): AccessDecision;
export function assertReadAllowed(domain, principal): void;
export function assertWriteAllowed(domain, principal): void;
export function isAppendOnly(domain): boolean; // audit only
```

Locked table (§8.1):
- content: read [all four]; write [manager, cli, service]
- policy:  read [all four]; write [manager, cli] (privileged)
- context: read [all four]; write [manager, cli] (agents never write)
- audit:   read [all four]; write [manager, service] — **append-only**: update/delete always denied

TODO:
- [ ] T4.1 Table as `Record<AccessDomain, { read: AccessPrincipal[]; write: AccessPrincipal[] }>`.
- [ ] T4.2 `checkAccess` + the two asserts + `isAppendOnly`.
- [ ] T4.3 Tests assert **every cell** of the table (§A5.4).

#### A4.5 `src/sor/kernel/index.ts` — barrel

- [ ] T5.1 Re-export `types`, `hash`, `provenance`, `access`. Commit last so every intermediate commit typechecks.

### A5. Tests (test-led, mirror `src/sor/__tests__/signer.test.ts` style: `describe`/`it`/`expect`, vitest)

#### A5.1 `types.test.ts`
- [ ] T6.1 identity shape; namespace literal `"fleet"`.
- [ ] T6.2 `isSorRecordIdentity` accept/reject.
- [ ] T6.3 `SourceRef` tuple.

#### A5.2 `hash.test.ts` — locked vectors included
- [ ] T7.1 `sha256Hex('{"a":"b"}')` === `db4a7ecb114bc66c623a06c4ff6fe8daa2f49cc270ebbf7a1f81e22ab061c837`.
- [ ] T7.2 `canonicalizeText` NFC/`\r\n`/`\r`/trailing-space/blank-line/BOM.
- [ ] T7.3 `sha256Hex(canonicalizeText('line1\nline2'))` === `683376e290829b482c2655745caffa7a1dccfa10afaa62dac2b42dd6c68d0f83`.
- [ ] T7.4 structured canonicalization stable under key insertion order.
- [ ] T7.5 `computeCanonicalHash` deterministic; differs when body changes.
- [ ] T7.6 `hash` field excluded from canonical body.
- [ ] T7.7 `verifyCanonicalHash`/`assertCanonicalHash` on match/mismatch.
- [ ] T7.8 dispatcher routing content→text, policy/context→structured.

#### A5.3 `provenance.test.ts`
- [ ] T8.1 exact five-field tuple.
- [ ] T8.2 validator throws on missing field / non-hex `contentHash`.
- [ ] T8.3 `freshnessOf` strict inequality + ISO `staleAfter`.
- [ ] T8.4 `sourceRefOf` drops namespace.

#### A5.4 `access.test.ts`
- [ ] T9.1 every read cell allowed for all four domains.
- [ ] T9.2 content write: manager/cli/service allowed; agent denied.
- [ ] T9.3 policy write: manager/cli allowed; agent + service denied.
- [ ] T9.4 context write: manager/cli allowed; agent + service denied.
- [ ] T9.5 audit: update/delete never; `isAppendOnly("audit")` true, others false.
- [ ] T9.6 asserts return clear notes on deny.

### A6. Phase 1 build order (each step ends green: `npm run typecheck && npm test`)

1. `git checkout -b feat/sor-kernel-phase1`
2. `src/sor/kernel/types.ts` + `__tests__/types.test.ts` → commit `feat(sor): kernel identity and record types`
3. `src/sor/kernel/hash.ts` + `__tests__/hash.test.ts` → commit `feat(sor): canonical representation and self-hash`
4. `src/sor/kernel/provenance.ts` + `__tests__/provenance.test.ts` → commit `feat(sor): provenance output contract`
5. `src/sor/kernel/access.ts` + `__tests__/access.test.ts` → commit `feat(sor): access model enforcement`
6. `src/sor/kernel/index.ts` barrel → commit `feat(sor): kernel module barrel`

### A7. Phase 1 definition of done (spec §17.2, mapped)

- [ ] Kernel module present with identity tuple, canonical-hash registry, provenance, access — **FR-1..FR-5**.
- [ ] Unit tests cover FR-1..FR-5 at type/hash level — **all T1.x..T9.x ticked**.
- [ ] `npm run typecheck` — 0 errors; `npm test` — all pass.
- [ ] `npm run sor:verify` — `ok: yes` (chain untouched).
- [ ] `npm run dry` — keyless smoke still green (no run-path change).

---

## PART B — SOR Gap Fixes / Hardening (real bugs in the existing audit chain)

These are pre-existing defects, independent of Phase 2. Fix them on the green Phase 1 tree
**before** Phase 2 so Phase 2's new event types and key handling never inherit them. Every
combines into a hardening branch; logical units commit separately.

### B1. `sor:repair` broken by the append-only trigger (migration 011)

**Bug.** `src/sor/repairChain.ts` issues `UPDATE audit_events SET prev_hash=…, hash=…`
(lines 129–132), but migration `011_sor_append_only.sql` adds
`BEFORE UPDATE OR DELETE … FOR EACH ROW … RAISE EXCEPTION` (`audit_events_append_only_trigger`).
Once 011 is applied, every `UPDATE` raises — `npm run sor:repair` crashes at the first
`needsUpdate > 0` row and can never repair a chain. There is no code to drop/disable the
trigger first.

**Fix.** In `repairChain`, immediately after `BEGIN` and `LOCK TABLE audit_events IN ACCESS
EXCLUSIVE MODE`, run:
```sql
ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only_trigger;
```
perform the updates, then (always, before `COMMIT` — use `try/finally`):
```sql
ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only_trigger;
```
So both statements live **inside the existing single transaction** that already wraps the
repair lock (lines 123–151, with the `finally`/`client.release()` at 149–151). If anything
throws, `ROLLBACK` reverts the DISABLE too, so the trigger is never left disabled outside a
committed repair.

Note: the same transaction also updates `sor_chain` (the chain-tail pointer, ~137–140).
`sor_chain` has no append-only trigger (only `audit_events` does, via 011), so the repair
fix is unaffected there — no DISABLE/ENABLE is needed for that UPDATE.

**Safety constraints (locked for the plan):**
- Only `sor:repair` disables the trigger; `appendAuditEvent`/`ensureChain`/`verifyChain`
  never touch it. The append-only invariant is preserved for every other path (§12.1, K7).
- The enabled state is restored in `finally` even on error, and the whole thing runs inside
  the same transaction as the ACCESS EXCLUSIVE lock — no orphan window where appends could
  silently UPDATE.
- Alternative noted but **not** used: `session_replication_role=replica` bypasses all triggers
  but requires superuser/owner and is broader than needed; the single named-trigger
  disable/enable is minimal and self-documenting.

**Tests.** Extend the repair test to run against a schema with 011 applied:
- [ ] F1.1 repair with a corrupt row: succeeds (exit 0), row updated, `sor:verify` green.
- [ ] F1.2 after repair, `UPDATE audit_events` from a normal session still raises the trigger
      (invariant preserved).
- [ ] F1.3 repair failure path (e.g. bad key) rolls back and does not leave the trigger disabled.

### B2. Key-rotation signing protocol flaw on the first post-rotation append

**Bug.** In `appendAuditEvent` (src/db/audit.ts):
- `keyId = getCurrentKeyId()` → the **new** key (e.g. v2).
- `key = getCurrentKey()` → the new key's secret.
- `hash = signEvent(key, chain.hash, normalized, chain.key_id)` — embeds **`chain.key_id`**
  (the **old** tail, v1) into the canonical record.
- Row is stored with `key_id = keyId` (v2); `sor_chain.key_id` advances to v2.
- `verifyChain` recomputes using **`row.key_id`** (v2) as the embedded field.

So the embedded v1 never equals the recomputed v2 → the **first row after rotation fails
verification**, and every subsequent row POISONS on it (chain.cascade). The chain is broken
from rotation until repaired by hand.

**Fix.** Embed the **current/row** key id consistently: `signEvent(key, chain.hash,
normalized, keyId)` — i.e. use `keyId` (the value written to `audit_events.key_id` and
`sor_chain.key_id`), not `chain.key_id`. This makes `verifyChain` (which reads `row.key_id`)
reproduce the same canonical record.

**Safety / consistency (locked for the plan):**
- `signEvent` is unchanged (it already sources the embedded field from the 4th arg).
- Only the caller's choice of which key id to embed changes. `chain.key_id` is no longer read
  for signing; it remains the chain's pointer to the current tail key for diagnostics.
- Confirm `sor_chain.key_id` and the row's `key_id` are always the same value post-append
  (they already are, line 117 & 123) — so this fix restores full interlock.

**Tests.**
- [ ] F2.1 rotate-then-append-then-verify: key `v1` → `SOR_KEY_ID=v2` (both keys set),
      append one event, run `verifyChain` ⇒ `ok: true`.
- [ ] F2.2 regression: single-key (v1) append + verify still green (existing coverage).
- [ ] F2.3 multi-append across a rotation boundary: tail of v1 events + first v2 event
      verify end-to-end; firstBadSeq === null.

### B3. `ensureChain` hardcodes `'v1'`

**Bug.** `ensureChain` (`INSERT INTO sor_chain (id, seq, hash, key_id) VALUES (1, 0, $1, 'v1')`)
hardcodes `'v1'` instead of the current key id.

**Fix.** Use `getCurrentKeyId()` for the inserted `key_id`:
```ts
import { getCurrentKeyId } from "../sor/keyRegistry.ts";
await pool.query(
	"INSERT INTO sor_chain (id, seq, hash, key_id) VALUES (1, 0, $1, $2) ON CONFLICT (id) DO NOTHING",
	[GENESIS_HASH, getCurrentKeyId()],
);
```
This keeps the genesis row's recorded key consistent with the actual current key on a
fresh install under a nonzero `SOR_KEY_ID`.

**Test.**
- [ ] F3.1 `ensureChain` with `SOR_KEY_ID=v2` inserts `sor_chain.key_id = 'v2'`;
      existing-row conflict path leaves it untouched.

### B4. Untested modules / untestable CLI

The following units have **no** test coverage and (for repair) are not importable as a pure
function:

- `src/sor/keyRegistry.ts` (`getKey`, `getCurrentKeyId`, `getCurrentKey`).
- `src/sor/repairChain.ts` — top-level CLI; refactor to export a callable
  `repairChainForPool(pool: Pool, keyId?: string, key?: string)` returning a
  `{ total, needsUpdate, updated, skipped }` report, keeping a thin CLI wrapper around it that
  owns `pool` + `process.exit`. This makes repair testable against a real pool without forking.
- `ensureChain` direct (its only current coverage is incidental through append).
- `syncAgentRegistry` (dormant — will be **replaced** in Phase 2, §E3; do not invest test
  effort now, only a const guard that it is wired, or defer to Phase 2).
- `quotaSignals` helpers `rateLimitSwitchError` and `parseRateLimitSwitch`
  (`src/fleet/quotaSignals.ts`).

**Fix.** Add unit tests for each; refactor `repairChain` as described (keeping the CLI
`npm run sor:repair` entry identical).

**Tests.**
- [ ] F4.1 `keyRegistry`: `getKey` normalization (`v2`→`SOR_KEY_V2`, `v1.x`→`SOR_KEY_V1_X`),
      v1 fallback to `SOR_SIGNING_KEY`, `undefined` when unset; `getCurrentKeyId` default `v1`;
      `getCurrentKey` throws when unset.
- [ ] F4.2 `repairChainForPool`: empty set ⇒ no-op report; valid chain ⇒ `needsUpdate 0`;
      corrupt row ⇒ updated + `sor:verify` green; exercises B1 trigger handling.
- [ ] F4.3 `ensureChain` direct (see F3.1).
- [ ] F4.4 `quotaSignals`: `rateLimitSwitchError` builds the exact
      `GEMINI_RATE_LIMIT_SWITCH:<block>:<waitMs>` string; `parseRateLimitSwitch` round-trips,
      rejects malformed (bad block, `NaN`, negative `waitMs`, missing `:`).

### B5. Minor/housekeeping

- **Stale migration headers.** `011_sor_append_only.sql` header says `-- migrations/010_…`
  and `012_sor_key_rotation.sql` says `-- migrations/011_…`. Fix both to `011_`/`012_` and
  add a migration-test assertion that each file's header `NNN_` prefix matches its filename
  `NNN` (the current test only asserts sequential numbering, not headers).
- **Env-var name inconsistency in spec (no code change).** Code (`keyRegistry.ts`) uses
  `SOR_KEY_<KEY_ID>`; the spec text/env-comment occasionally says `SOR_SIGNING_KEY_V1`.
  The code is authoritative — align documentation in `.env.example` and code comments to the
  `SOR_KEY_*` scheme; no behavior change.
- **`.env.example` doesn't document `SOR_KEY_*`.** Add a commented block:
  ```
  # SOR key scheme — SOR_KEY_<KEY_ID> per key (uppercase, [^A-Z0-9]→"_").
  # v1 falls back to SOR_SIGNING_KEY when SOR_KEY_V1 is unset.
  # SOR_KEY_ID selects the current signing key (default v1).
  SOR_KEY_ID=v1
  ```
- **`sor_chain` tail not verified by `verifyChain`.** Currently `verifyChain` iterates
  `audit_events` only and never checks that `sor_chain.row`'s tail hash matches the last
  event hash. **Optional / nice-to-have (not required):** after the row loop, load
  `sor_chain` and assert `sor_chain.hash === prevHash` (and key_id match), reporting a
  distinct `tailMismatch` flag. Mark clearly as optional — do not gate the gap-fix work on it.

**Tests.**
- [ ] F5.1 migration test asserts header/filename `NNN` agreement.
- [ ] F5.2 (optional) `verifyChain` tail-check test.

---

## PART C — Phase 2: Policy SoR v1 implementation plan

Maps spec §9 (contract), §12.2 (events), §15 (migrations), §16 (phase), §17.3 (done),
§20 (decision log #23–#28), and §21 (residue locks). Delivers Policy SoR v1 end-to-end:
migrations `013`/`014`, policy modules, PEP in the worker loop, snapshot env injection,
policy events, CLI, and tests. **Content/Context (Phases 3–4) are NOT built here** (see
Part E out-of-scope).

### C1. Locked contract inputs

| Spec ref | What it forces |
|---|---|
| FR-6 (Effective grant) | tool executes iff ceiling ∩ grant + `toolRules`; else DENY before `impl.exec` |
| FR-7 (No drift overwrite) | `rules` never auto-written on `source_hash` change; explicit reconcile only |
| FR-8 (Mode resolution) | exactly one mode per spawn; absent env ⇒ compatibility; invalid/tampered ⇒ fail-closed; configured-but-unreachable DB ⇒ fail-closed for protected actions |
| FR-10 (Decision evidence) | `policy_state` per session; `policy_sync` per mutation/drift; `policy_decision` per call in sor/fail-closed |
| FR-11 (Empty = zero-grant) | empty allowedTools/mcpAllow/toolRules valid, grants nothing, mode stays `sor` |
| FR-20/FR-21 (K7) | additive CHECK widening only; TS event layer in lockstep with 013; appends NON-FATAL |
| §9.3 | PolicyDocument schema (schemaVersion, meta.subject_role, allowedTools, mcpAllow, toolRules) |
| §9.5 / §14 | mode table; compatibility is no-SOR-configured only |
| §9.6 / K5 | PEP lives in `loop.ts` before `impl.exec` |
| §9.7 | env `SOR_POLICY_MODE/HASH/VERSION/JSON_B64`; worker snapshots + emits `policy_state` |
| §12.2 / §21.2 | six event types + locked payload shapes |
| §21.1 | `events.ts` union locks with 013 in the same change |
| §21.3 | 014 backfill: legacy rows = seeded v1; `policy_hash` at first manager boot |
| §21.4 | read-only tools get NO P-I1 exemption |
| §21.5 | manager-side file map |
| §21.6 / §15 | 013/014 have DOWN; sequential UP/DOWN round-trip asserted |
| §17.3 | the Phase 2 done checklist (mapped in C11) |

### C2. Deliverables (file map — from §21.5)

| File | Change | Status |
|---|---|---|
| `migrations/013_sor_policy_events.sql` | one additive event_type CHECK widening (six new types) | **new** |
| `migrations/014_agent_registry_policy.sql` | `policy_hash`, `policy_version` columns + legacy backfill hooks | **new** |
| `src/sor/events.ts` | `SorEventType`, `VALID_TYPES`, `normalizeEvent` gain all six (in lockstep with 013) | **edit** |
| `src/db/audit.ts` | replace dormant `syncAgentRegistry` with `ensurePolicyRegistry`, `loadRolePolicy`, `reconcileRolePolicy`; appends stay NON-FATAL | **edit** |
| `src/fleet/policy.ts` | policy validation, canonical hash, document codec (`SOR_POLICY_JSON_B64`) | **new** |
| `src/fleet/policyEval.ts` | PEP evaluator (tool name + parsed input vs `toolRules`) | **new** |
| `src/fleet/loop.ts` | PEP step before `impl.exec` | **edit** |
| `src/agentRunner.ts` | resolve mode + snapshot at spawn; inject `SOR_POLICY_MODE/HASH/VERSION/JSON_B64` | **edit** |
| `src/runtime/worker/main.ts` | parse env, build effective registry, emit `policy_state`, feed PEP into loop | **edit** |
| `src/index.ts` | CLI `sor:policy seed \| reconcile <role> <file> \| show <role>` | **edit** |
| `src/fleet/sorEmit.ts` | NOT used for policy events — `buildToolEmission` hardcodes `tool_call`; policy events append via `appendAuditEvent` directly. Verify only: no code change, add a round-trip test | **verify** |
| tests | policies/eval/loop-PEP/audit-policy/migration/gap-fix suites | **new** |

Do **NOT** modify: `src/sor/signer.ts`, `src/sor/verify.ts`, `src/sor/keyRegistry.ts`
(except B-tested), migrations 004/006/008/009/010/011/012, `orchestrator.ts`.

### C3. Migration specs

#### C3.1 `migrations/013_sor_policy_events.sql`

Single **additive** event_type CHECK widening (006/008/009/010 precedent; §21.1; FR-20).
The UP drops the current 14-value CHECK and re-adds it with the six new types appended
(current list from `010_sor_telemetry_events.sql`):

```sql
-- migrations/013_sor_policy_events.sql
-- Widen audit_events.event_type CHECK to accept the six Policy SoR event types:
-- policy_state, policy_sync, policy_decision, content_sync, content_access, context_update.

-- UP:
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_event_type_check;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_event_type_check
  CHECK (event_type IN (
    'tool_call','wakeup','phase','registry_sync','finalize','model_switch',
    'model_recovered','all_models_exhausted','run_paused','run_resumed',
    'reservation','reservation_rejection','provider_completion','retry',
    'policy_state','policy_sync','policy_decision','content_sync','content_access','context_update'
  ));

-- DOWN:
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_event_type_check;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_event_type_check
  CHECK (event_type IN (
    'tool_call','wakeup','phase','registry_sync','finalize','model_switch',
    'model_recovered','all_models_exhausted','run_paused','run_resumed',
    'reservation','reservation_rejection','provider_completion','retry'
  ));
```

Precedent is **exactly** 008/009/010: DROP then re-ADD the CHECK with a widened/restored
value list. Because each migration's UP/DOWN is self-contained, the round-trip is
sequential and the constraint name `audit_events_event_type_check` is preserved. All six
types land in ONE CHECK (not six mini-widenings) — one additive change (§12.2/§15).

**Must land in the same commit/change as the `events.ts` union widening (§21.1).**

#### C3.2 `migrations/014_agent_registry_policy.sql`

Adds the Policy SoR columns to `agent_registry` (§9.2, §21.3):

```sql
-- migrations/014_agent_registry_policy.sql
-- Add Policy SoR versioning columns to agent_registry.
-- policy_hash is nullable and backfilled (canonicalized) at first manager boot (§21.3),
-- NOT by SQL here. policy_version defaults 1 (legacy rows = seeded v1).

-- UP:
ALTER TABLE agent_registry
  ADD COLUMN policy_hash TEXT,
  ADD COLUMN policy_version INTEGER NOT NULL DEFAULT 1;

-- DOWN:
ALTER TABLE agent_registry
  DROP COLUMN policy_version,
  DROP COLUMN policy_hash;
```

**Backfill semantics (§21.3) — enforced in `ensurePolicyRegistry`, not SQL:**
- Legacy rows stay authoritative, `policy_version = 1` (treated as **seeded v1**).
- `policy_hash` computed from the **canonicalized existing `rules`** and persisted at
  **first manager boot** (`ensurePolicyRegistry`), before any drift check.
- `metadata.capabilityTools[]/capabilityMcp[]` reconciled at first boot (snapshot from the
  current `FleetAgentDef`).
- Fresh installs seed exactly per §9.4 (capability snapshot, `policyVersion = 1`).

### C4. Event contract (§12.2, §21.1, §21.2) — `src/sor/events.ts`

In the **same change** as 013, extend the TS event layer:

- `SorEventType` union gains: `"policy_state" | "policy_sync" | "policy_decision" |
  "content_sync" | "content_access" | "context_update"`.
- `VALID_TYPES` gains the same six (append — never reorder/remove existing).
- `normalizeEvent` accepts them (it is already generic over `event_type` once the union
  allows them; add explicit accept-tests). Truncation caps `TOOL_INPUT_CAP`/`TOOL_OUTPUT_CAP`
  (20 000) apply to all SoR events (§4.2).

**Locked payload shapes (§12.2 / §21.2)** — carried in `payload`:

```text
base:        { sorType, sourceId, namespace:"fleet", version, hash, actor, ts }
policy_decision: { decision:"ALLOW"|"DENY", action, result:"ok"|"blocked"|"error", reason }
policy_state:    { mode:"sor"|"compatibility"|"fail-closed", policyVersion, policyHash, sourceHash }
policy_sync:     { kind:"seeded"|"reconciled"|"updated"|"drift-detected", prevVersion, document? }
content_sync:    { kind:"added"|"updated"|"removed"|"unchanged", status }        // Phase 3 (types only now)
content_access:  { sessionId, mode:"aggregate"|"percall", count, topSources[] }  // Phase 3 (types only now)
context_update:  { prevVersion }                                                 // Phase 4 (types only now)
```

- `policy_sync.document` (full policy document) embedded on `seeded|reconciled|updated`,
  **omitted** on `drift-detected` — the chain is the policy version store (FR-22, §12.3).
- `content_sync`/`content_access`/`context_update` event types are added to the union and
  the CHECK now (so the check and TS never diverge per §21.1), but their emitters belong to
  Phases 3–4; they are simply representable/verify-able now. This is the **only** concession,
  and it is forced by the single-CHEK-widening + lockstep rule.

**Emitter responsibilities (§12.2 / FR-10):**
- `policy_state` — worker init, always (per session).
- `policy_sync` — manager/CLI, always (per mutation/drift).
- `policy_decision` — worker PEP, **always per tool call** in `sor`/`fail-closed` modes.

### C5. Mode resolution semantics (§9.5, §14, P-I3/P-I4)

`loadRolePolicy` outcomes split into **THREE** (§9.5): `absent` (no row / seed failed)
⇒ **compatibility** (declared, with mode-honesty P-I4); `invalid`/`hash-mismatch` ⇒
**fail-closed** (zero grants); `valid` ⇒ **sor**. Compatibility is ONLY for genuine
no-SOR-configured (absence); an invalid present policy is never compatibility.

Resolved **once per spawn** in `agentRunner.ts` and immutable for the session; the resolved
mode/hash/version/doc are injected as env. Resolution order:

```text
1. No SOR config at all (no DATABASE_URL / policy subsystem disabled)  ⇒  compatibility
   (declared; today's static def.tools behavior).
2. DB configured + reachable; policy row present and canonical-valid    ⇒  sor
3. DB configured + reachable + ZERO rows for the role (loadRolePolicy ⇒ absent /
   seed failed)                                                        ⇒  compatibility
   (declared, P-I4 mode honesty). Never fail-closed: absence is genuine no-SOR-configured.
4. Policy present but invalid/malformed/hash-mismatch / undecodable      ⇒  fail-closed
   (zero grants — every protected tool denied). P-I3: invalid presence NEVER degrades to
   compatibility; only genuine absence does.
5. DB configured but unreachable / row fetch fails after config          ⇒  fail-closed
   for protected actions (§9.5 locked gate). Not compatibility.
```

Empty-but-valid policy document (FR-11): valid zero-grant, mode stays `sor`.

**Env injection (§9.7):** `SOR_POLICY_MODE`, `SOR_POLICY_HASH`, `SOR_POLICY_VERSION`,
`SOR_POLICY_JSON_B64`. Absent env in the worker ⇒ declared `compatibility` baseline (mode
honesty — the worker still emits `policy_state {mode:"compatibility"}`). This preserves the
existing keyless/`npm run dry` path and `orchestrator.ts` (which never calls models).

### C6. Policy modules

#### C6.1 `src/fleet/policy.ts` — document, validation, hash, codec

- `PolicyDocument` / `RulePredicate` types per §9.3.
- `validatePolicyDocument(doc): { ok: true } | { ok: false; reason: string }` — schemaVersion
  must be 1; `meta.subject_role` must equal the target role; `allowedTools`/`mcpAllow` are
  string arrays; `toolRules` values are `RulePredicate[]`; unknown operators rejected.
- `canonicalPolicyHash(doc)` — `sha256Hex(canonicalJson(doc))` reusing the audit signer's
  `canonicalJson` discipline (§7.4 policy/context rule). Use `node:crypto` `createHash`.
- Document codec `SOR_POLICY_JSON_B64`: `btoa(JSON.stringify(doc))` / inverse
  `JSON.parse(atob(b64))` (UTF-8-safe via `TextEncoder`/`TextDecoder`). This is the sole
  decoder/encoder for the injected env and for `policy_sync.document`.
- `emptyPolicy(role)`/`capabilitySnapshot(def, role)` — seed source (§9.4): current
  `def.tools ∪ def.mcpAllow`, empty `toolRules`.

#### C6.2 `src/fleet/policyEval.ts` — PEP evaluator (FR-6, FR-11, K5)

Pure function:
```ts
export type PepDecision = { allowed: boolean; decision: "ALLOW"|"DENY"; reason: string };
export function evaluateToolCall(
	toolName: string,
	input: unknown,                       // parsed tool arguments
	effective: { allowedTools: string[]; mcpAllow: string[] },
	rules: Record<string, RulePredicate[]>,
): PepDecision;
```
Semantics (locked, §9.3):
- Tool name with no entry in `allowedTools ∪ mcpAllow` ⇒ **DENY** `unknown tool` (implicit
  deny — unknown tools never execute, §9.3 last bullet). Note: the current loop already
  handles unknown tools as a soft `unknown tool` result; the PEP makes it a hard
  side-effectless DENY for protected actions.
- Then `∀ r ∈ toolRules[tool]`: `op:"deny" ⇒ r.when(input) must be false`, and
  `op:"require" ⇒ r.when(input) must be true`; any violation ⇒ DENY with the rule's reason.
- `ArgumentMatcher` DSL is a Phase 2 implementation detail (§19); implement a minimal
  `{ path, oneOf?|notOneOf?|match? }` matcher against the parsed input as the concrete
  vocabulary, with `match` as a RegExp string. Document that the DSL is restricted to these
  three matchers in v1.
- Empty `allowedTools/mcpAllow/toolRules` and an ALLOW for an empty rule set ⇒ ALLOW only if
  tool is in `allowedTools∪mcpAllow` (zero-grant document grants nothing — FR-11).

`policyEval.ts` is pure and fully unit-testable (no env, no DB).

### C7. PEP integration in `src/fleet/loop.ts` (K5, FR-6)

Insert a PEP step **before** `impl.exec` (currently line ~725), replacing the soft
`unknown tool` branch's DENY behavior for protected actions:

```text
for each tool call:
  input = JSON.parse(arguments)           (existing)
  [existing sor?.toolCall ...]
  if (mode === "sor" || mode === "fail-closed"):
      decision = evaluateToolCall(name, input, effectiveRegistry, toolRules)
      emit policy_decision { decision, action, result, reason }   (non-fatal append)
      if (!decision.allowed):
          result = { ok:false, content: denied-reason }           // NOT impl.exec
          continue/messages.push(denied)                          // zero side effects
  // ALLOW path only:
  impl = registry[name]...
  out = await impl.exec(input, wtCtx)                              (unchanged)
```

- Registry name check stays (a tool not in the capability registry is already no-op);
  the PEP is the **authorization** boundary on top of capability gating (K5 — tool-list
  exposure is never the final boundary).
- Deny path leaves **zero side effects** (impl.exec not called), records
  `policy_decision {decision:"DENY", result:"blocked", reason}`.
- `compatibility` mode skips the PEP (static `def.tools` allowed — today's behavior), but the
  session `policy_state {mode:"compatibility"}` is still emitted.
- Appends stay NON-FATAL (P-I5): `policy_decision` emission errors are caught+warned, never
  abort or downgrade a decision (a deny is a deny regardless of audit success).

### C8. Registry & snapshot wiring

#### C8.1 `src/db/audit.ts` — replace dormant `syncAgentRegistry` (§21.5)

Replace with (names from §21.5):
- `ensurePolicyRegistry(pool, defsByRole)` — idempotent; ensures `agent_registry` rows for
  all six roles exist (insert-only seed per role absent) with **policy_version=1**, `rules`
  as the capability snapshot (§9.4), `policy_hash` computed from canonicalized `rules`,
  `source_hash` = canonical hash of the current `FleetAgentDef`, and `metadata` snapshot
  (`systemPromptSha`, `skillsDir`, `capabilityTools[]`, `capabilityMcp[]`). For **legacy**
  rows (14-backfilled), it computes/persists `policy_hash` from existing `rules` at first
  boot (§21.3) before any drift check. Fresh installs seed exactly per §9.4.
- `loadRolePolicy(pool, role)` — reads one role's validated document +
  `policy_hash`/`policy_version`; shallow validation; on mismatch returns a
  `{ ok:false, reason }` for fail-closed handling (P-I3).
- `reconcileRolePolicy(pool, role, doc)` — validates doc, writes the **next** `policyVersion`
  (always, even on unchanged content — §4.3), updates `source_hash` to current ceiling,
  emits `policy_sync {kind:"reconciled"|"updated", prevVersion, document}`.
- Drift: `ensurePolicyRegistry`/load detects `source_hash` mismatch against the current
  `FleetAgentDef` and emits `policy_sync {kind:"drift-detected"}` (no `document`) — **no
  automatic write to `rules`** (FR-7, P-I2).
- **All appends NON-FATAL** (warn+continue on SOR-write error; never abort a manager/worker
  run) — §12.1/K7/FR-21.

#### C8.2 `src/agentRunner.ts` — mode resolution + snapshot injection (§9.7)

- Resolve mode per C5.
- In `sor`/`fail-closed`, load the role policy via `loadRolePolicy`, validate, and inject
  `SOR_POLICY_MODE/HASH/VERSION/JSON_B64` into the worker spawn env. In `fail-closed`, an
  invalid present policy means no real document is usable, so inject mode `fail-closed`, an
  empty-grant document as `SOR_POLICY_JSON_B64`, and a sentinel `SOR_POLICY_HASH` (the
  empty-grant doc hash) so the worker builds a zero effective registry. In `compatibility`
  (including a configured + reachable DB with **zero rows** for the role), omit policy env
  (worker defaults to declared compatibility, P-I4).
- Sub-case (mode honesty): a configured + reachable DB whose `loadRolePolicy` returns
  `absent` (no row / seed failed) resolves to **compatibility**, never fail-closed — the
  worker declares `policy_state {mode:"compatibility"}`, exactly like the no-SOR-config case
  (§9.5).
- No model calls here (manager side). Snapshot is resolved at spawn, immutable for the
  session (P-I4).

#### C8.3 `src/runtime/worker/main.ts` — parse env, build effective registry, emit `policy_state`

- Parse `SOR_POLICY_*`. Absent ⇒ mode `compatibility`.
- Build **effective registry = ceiling ∩ grant** (§9.1/P-I1): for `sor`, intersect the role's
  `def.tools ∪ def.mcpAllow` with the injected `allowedTools ∪ mcpAllow`; for `fail-closed`,
  zero tools; for `compatibility`, static `def.tools`.
- Emit `policy_state { mode, policyVersion, policyHash, sourceHash }` at init (always, per
  session).
- **Dry-run/stub sessions (§C8.3):** `runWorker` returns `stubResult` without forking in
  dry-run and `emitWakeup` is a dry-run no-op. Mirror that exactly: dry-run/stub sessions do
  **NOT** emit `policy_state` at all (no `{mode:"compatibility"}` event, no DB append) — a
  policy event is never appended during `npm run dry` even when a DB is configured. Assert
  this in a test (zero policy-event DB-appends on the dry-run path).
- Feed the effective registry + `toolRules` + mode into the loop's PEP (C7). The worker never
  reads policy from the DB itself — it receives the manager's snapshot (locked design: DB
  access stays centralized manager-side; workers stay thin, §8.2).

#### C8.4 Policy events append via `appendAuditEvent` directly — not `sorEmit`

`src/fleet/sorEmit.ts` is **not** event-agnostic: `buildToolEmission` hardcodes
`event_type: "tool_call"` and `createSorEmitSink` only emits tool-call rows. It must NOT be
used for policy events. Policy events (`policy_state`, `policy_sync`, `policy_decision`)
append via the **event-agnostic `appendAuditEvent`** in `src/db/audit.ts` directly — wrapped
NON-FATAL (warn + continue), mirroring the orchestrator's `sorEmit` wrapper
(`src/orchestrator.ts`). **Expect no code change in `sorEmit.ts`**; instead add a test that
round-trips a `policy_decision` through `normalizeEvent` → `appendAuditEvent`
(recording-pool style, like `src/__tests__/audit.test.ts`), asserting the row lands with
`event_type: "policy_decision"`, `payload` intact, `prev_hash`/`hash` chained, and that a
forced DB-append failure warns and continues (NON-FATAL).

### C9. CLI (`src/index.ts`) — `sor:policy`

```
sor:policy seed                                  # insert-only seed of all roles from current FleetAgentDef snapshot (§9.4)
sor:policy reconcile <role> <file>               # validate file, next policyVersion, update source_hash, emit policy_sync
sor:policy show <role>                           # print role's document + policy_version + policy_hash + source_hash
```

- `seed` is insert-only: errors (insert conflicts) if a role already exists — no overwrite.
- `reconcile` requires a valid policy document file (schema + `subject_role` == role);
  rejects malformed docs at the CLI (`{ok:false, reason}`), never writes.
- Privileged: these are manager/CLI entry points only (§8.1 policy write = manager, cli).
  Agents never call them.
- All policy writes emit `policy_sync` (document embedded) — NON-FATAL append.

### C10. Phase 2 tests (test-led)

**Migration tests:**
- [ ] P1.1 013 UP/DOWN round-trip: after UP, CHECK accepts a `policy_decision` insert; after
      DOWN, the same insert fails (old CHECK restored).
- [ ] P1.2 014 UP adds nullable `policy_hash` + `policy_version NOT NULL DEFAULT 1`; DOWN drops
      both; legacy row (pre-014 insert, no cols) backfills correctly via `ensurePolicyRegistry`.
- [ ] P1.3 header/filename agreement + sequential numbering (extends F5.1); full
      `006→014` sequential UP/DOWN round-trip (§21.6). In the same change that adds 013/014,
      bump the migrations test's last-file assertion from
      `files[files.length-1] === "012_sor_key_rotation.sql"` to
      `"014_agent_registry_policy.sql"`, and refresh the header-check to tolerate the
      corrected 011/012 headers (F5.1).

**`events.ts` tests (lockstep with 013):**
- [ ] P2.1 `VALID_TYPES` contains all six; existing 14 untouched.
- [ ] P2.2 `normalizeEvent` accepts each new type with a locked-shape payload.
- [ ] P2.3 the FIRST parity test tying the TS union to the 013 UP CHECK: a
      widened-DB-with-old-TS scenario is impossible in one commit — assert every entry of
      `VALID_TYPES` (the TS array) is ⊆ the 013 UP CHECK literal set, extracting the CHECK
      literals from `013_sor_policy_events.sql` in the style of `migrations.test.ts`
      (mirroring how that suite asserts over the migration CHECK).
- [ ] P2.4 policy-event append round-trip: `normalizeEvent(policy_decision)` →
      `appendAuditEvent` inserts a row with `event_type: "policy_decision"`, `payload`
      intact, `prev_hash`/`hash` chained; append travels through `appendAuditEvent` (not
      `buildToolEmission`, which hardcodes `tool_call`).

**`policy.ts` / `policyEval.ts` tests:**
- [ ] P3.1 validate rejects wrong schemaVersion, role mismatch, unknown rule op, non-array tools.
- [ ] P3.2 canonicalPolicyHash stable under key order; equals `sha256Hex(canonicalJson(doc))`;
      differs on any field change.
- [ ] P3.3 codec round-trip base64 (incl. non-ASCII role/tool strings).
- [ ] P3.4 evaluateToolCall: allowed tool ⇒ ALLOW; unknown tool ⇒ DENY; `deny` predicate
      matching ⇒ DENY; `require` predicate failing ⇒ DENY; multiple predicates ALL satisfy ⇒
      ALLOW; empty-grant doc ⇒ zero ALLOWs (FR-11); empty toolRules + tool in allowedTools ⇒
      ALLOW.

**Loop/worker (integration, no model calls):**
- [ ] P4.1 (sor mode) denied tool: `impl.exec` NOT invoked (spy/marker), side-effectless
      result, `policy_decision DENY` emitted.
- [ ] P4.2 allowed tool: normal exec; `policy_decision ALLOW` emitted per call.
- [ ] P4.3 fail-closed mode: every tool (including one in the ceiling) denied; zero grants.
- [ ] P4.4 compatibility mode: PEP skipped, static def.tools behavior, still emits
      `policy_state {mode:"compatibility"}`.
- [ ] P4.5 unknown tool denied with zero side effects.
- [ ] P4.6 `policy_state` emitted at worker init with correct mode/version/hash/sourceHash.
- [ ] P4.7 dry-run/stub session emits NO `policy_state` (mirrors `emitWakeup` no-op) and
      performs zero policy DB-appends during `npm run dry` even when a DB is configured.

**Registry/audit (`audit.ts`) tests:**
- [ ] P5.1 `ensurePolicyRegistry` seeds all roles (insert-only, v1, snapshot, hash computed) on
      a fresh DB; idempotent on re-run.
- [ ] P5.2 legacy 014-backfilled row: `policy_hash` computed from canonicalized existing `rules`
      at first boot, `policy_version=1`, before drift.
- [ ] P5.3 `loadRolePolicy` splits outcomes three ways: `absent` (zero rows for the role /
      seed failed) ⇒ routes to **compatibility** (declared, P-I4); `invalid`/`hash-mismatch`
      ⇒ routes to **fail-closed**; `valid` ⇒ routes to **sor**.
- [ ] P5.4 `reconcileRolePolicy` bumps policy_version (even on unchanged content), updates
      source_hash, emits `policy_sync {kind:"reconciled", document}`; drift-only path emits
      `{kind:"drift-detected"}` with NO document and does NOT write rules (FR-7/AT-5).
- [ ] P5.5 appends NON-FATAL: a forced SOR-write failure in a policy append warns and continues.
- [ ] P5.6 unit test for the mode-resolution function (extracted into `src/agentRunner.ts`
      as a pure, unit-testable function, per §C5) covering ALL branches: `valid` ⇒ `sor`;
      `absent` (no row / seed failed) ⇒ `compatibility`; `invalid`/`hash-mismatch` ⇒
      `fail-closed`; DB unreachable after config ⇒ `fail-closed`; plus the FR-11
      empty-but-valid policy ⇒ stays `sor` with zero grants.

**CLI tests:**
- [ ] P6.1 `seed` creates rows once, refuses to overwrite existing; `reconcile` validates the
      file and bumps version; `show` prints the document tuple.
- [ ] P6.2 `reconcile` rejects malformed file / role mismatch without any write.

**Acceptance mapping (AT-3, AT-4, AT-5, AT-6):**
- [ ] P7.1 AT-3: denied unauthorized tool ⇒ `impl.exec` never runs (covered by P4.1).
- [ ] P7.2 AT-4: code capability cannot exceed policy authorization — a new def tool absent
      from the policy doc yields no grant (P4.3 / P5.2).
- [ ] P7.3 AT-5: drift cannot silently grant — mismatch only records drift, no rules write
      (P5.4).
- [ ] P7.4 AT-6: policy version/hash reconstructible from `policy_state` → `policy_sync`
      (full document) for a historical version (forensic reread test).

**sor:verify gate:** after all Phase 2 commits, `npm run sor:verify` stays green (§12.3, AT-9).

### C11. Phase 2 definition of done (spec §17.3, mapped)

- [ ] Migrations `013` + `014` up/down round-trip; 013 CHECK widening includes all six types and
      `src/sor/events.ts` union moves in lockstep (§21.1) — **§C3, §C4, P1.x, P2.x**.
- [ ] 014 legacy backfill per §21.3 (legacy rows = seeded v1; `policy_hash` at first boot) —
      **§C3.2, P5.2**.
- [ ] `ensurePolicyRegistry`/`loadRolePolicy`/`reconcileRolePolicy` replace dormant
      `syncAgentRegistry`; appends stay NON-FATAL — **§C8.1, P5.x**.
- [ ] Mode resolution at spawn (§9.5) with `SOR_POLICY_*` env injection; worker builds the
      effective registry and emits `policy_state` — **§C5, §C8.2, §C8.3, P4.6**.
- [ ] PEP before `impl.exec` enforces FR-6 + FR-11 (input-level `toolRules`; unknown tools
      deny) — **§C7, P4.1–P4.5**.
- [ ] `policy_decision` per call in `sor`/`fail-closed`; `policy_sync` on mutations; payloads
      per §12.2 with truncation caps (§4.2) — **§C4, §C7, §C8**.
- [ ] CLI `sor:policy seed | reconcile <role> <file> | show <role>` wired in `src/index.ts` —
      **§C9, P6.x**.
- [ ] FR-6..FR-11 held; AT-3, AT-4, AT-5, AT-6 green; typecheck + tests + `sor:verify` green —
      **§C10, §C12**.

### C12. Phase 2 build order (each step ends green: `npm run typecheck && npm test`, then re-check `npm run sor:verify`)

Branch `feat/sor/policy-phase2` (from green Phase 1/gap-fix tree).

1. `migrations/013_sor_policy_events.sql` **+** `src/sor/events.ts` union + `VALID_TYPES` +
   lockstep tests → commit `feat(sor): add policy event types to check and TS layer` (§21.1 — one change).
2. `migrations/014_agent_registry_policy.sql` + migration round-trip tests →
   `feat(sor): add policy versioning columns to agent_registry`.
3. `src/fleet/policy.ts` + tests → `feat(sor): policy document schema, validation and codec`.
4. `src/fleet/policyEval.ts` + tests → `feat(sor): policy evaluator (PEP)`.
5. `src/db/audit.ts`: replace `syncAgentRegistry` with registry/load/reconcile + tests →
   `feat(sor): policy registry, load and reconcile`.
6. `src/agentRunner.ts` mode resolution + `SOR_POLICY_*` injection →
   `feat(sor): resolve policy mode and inject worker snapshot`.
7. `src/runtime/worker/main.ts` env parse + effective registry + `policy_state` →
   `feat(sor): build effective registry and emit policy_state in worker`.
8. `src/fleet/loop.ts` PEP-before-exec + tests → `feat(sor): enforce policy before tool exec`.
9. `src/index.ts` `sor:policy` CLI + tests → `feat(sor): policy seed/reconcile/show CLI`.
10. `appendAuditEvent` round-trip test for `policy_decision` (recording-pool style; no
    `sorEmit.ts` change) →
    `test(sor): policy_decision appends via appendAuditEvent directly`.
11. Final acceptance pass: AT-3..AT-6 suites + `npm run sor:verify` →
    `test(sor): policy acceptance (AT-3..AT-6)`.

---

## PART D — Overall build order (Phase 1 → Gap fixes → Phase 2)

Dependency ordering. Each numbered step ends green
(`npm run typecheck && npm test`, and `npm run sor:verify` where the chain is involved).

| # | Work | Branch | Commit subject (one or more) |
|---|---|---|---|
| D1 | **Phase 1 kernel** (§A6) | `feat/sor/kernel-phase1` | `feat(sor): kernel identity…hash…provenance…access…barrel` |
| D2 | **Repair vs trigger** (B1) | `fix/sor-repair-trigger` | `fix(sor): disable append-only trigger within repair transaction` |
| D3 | **Key rotation signing** (B2) | `fix/sor-key-rotation-signing` | `fix(sor): sign first post-rotation append with current key id` |
| D4 | **ensureChain key id** (B3) | `fix/sor-ensure-chain-key` | `fix(sor): ensureChain uses current key id` |
| D5 | **Untested modules + tests** (B4) | `test/sor-gap-hardening` | `test(sor): cover keyRegistry, repairChain, ensureChain, quotaSignals` + `refactor(sor): expose repairChainForPool for testability` |
| D6 | **Housekeeping** (B5) | same as D5 | `fix(sor): correct migration headers; document SOR_KEY_* in .env.example` |
| D7 | **Phase 2 Policy SoR v1** (§C12) | `feat/sor/policy-phase2` | per §C12 step subjects |

Rationale for ordering:
- D2 before D3: repairing is needed to reliably test rotation fixes on existing corruptish
  data; and B1 fixes the tool you'll use if D3 ever leaves a poisoned chain.
- D3 before D5: the rotation tests (F2.x) are the first to exercise `repairChainForPool` on
  post-rotation state and give the refactor a concrete scenario.
- D6 last in the gap section because `.env.example` + header doc writes should not churn
  while D2–D5 are stabilizing code.
- D7 last: Phase 2 reuses the (now green) hash/`events.ts`/key/registry foundation and adds
  events on top of a fixed, verifiable chain. `sor:verify` re-checked at every Phase-2 step.

Semantic version of commits: `feat(sor)` for kernel/policy capability, `fix(sor)` for the
gap fixes, `test(sor)`/`refactor(sor)` where the dominant change is tests/refactor. Keep
imperative subjects + explanatory bodies (AGENTS.md).

## PART E — Out of scope (explicit)

From spec §18 plus this slice's boundary:
- **Content SoR v1 (Phase 3):** migration 015 + pgvector, markdown ingestion CLI, worker-child
  embedding, chunking, retrieval service + read-only MCP tools, `content_sync`/`content_access`
  emitters, C2 prompt directive. Only the **event types** land in union/CHECK now (forced by
  013 lockstep); no emitters/content code.
- **Context SoR v1 (Phase 4):** migration 016, run-scoped seed, org-constraint CLI, freshness
  markers, `context_update` emitters. Only the event type lands now.
- **Phase 5 unified surface** and **Phase 6 cross-domain ATs** (spec §13/§17.1).
- Weakening the audit chain / append-only trigger / key rotation / NON-FATAL appends
  (all preserved; repair-only trigger disable is the single, transaction-wrapped exception).
- Live/online PEP over IPC in v1 — spawn-time snapshots only (§18).
- Admin policy-editing UI / self-serve admin UI.
- Policy `ArgumentMatcher` DSL beyond the minimal `{path, oneOf|notOneOf|match}` vocabulary
  (rest is a Phase 2+ detail, §19).
- Multi-tenancy (reserved namespace `"fleet"`).
- No new runtime dependencies beyond those already present; no model calls in manager code.

**Do NOT modify** in this slice: `src/sor/signer.ts`, `src/sor/verify.ts`,
`src/orchestrator.ts`, migrations 004/006/008/009/010/011/012 (beyond the B-family header
comment fixes), TUI/dashboard, anything under `.runs/`.

## PART F — Risks & style rules

- **K5** — PEP must gate before `impl.exec`; the loop change must keep the soft unknown-tool
  behavior for `compatibility` while hard-denying in sor/fail-closed. Watch for double
  handling of `unknown tool` (PEP deny + existing no-impl branch); make the PEP authoritative
  and the no-impl branch a dead guard.
- **Lockstep (213:events/013)** — widening the CHECK without the TS union (or vice versa)
  breaks every `sorEmit` call; keep them one commit and add a parity test (P2.3).
- **Key-rotation interlock** — after D3, `sor_chain.key_id`, row `key_id`, and embedded
  `key_id` must all be the same value; the F2 suite asserts all three.
- **Repair safety** — trigger disable/enable must live inside the same transaction as the
  ACCESS EXCLUSIVE lock, with `finally` restore; never ship "repair leaves the table
  writable" behavior.
- **Naming** — "Fleet" (product) vs `fleet/` (worker-fleet concept) vs `FleetAgentDef`
  vs `SOR` (spec) vs `sor:` (CLI/audit trail) are distinct; keep code-level lowercase `sor`
  and audit-trail `sor:` meanings per AGENTS.md.
- No comments unless asked; tabs over spaces (match `src/sor/signer.ts` / `src/db/audit.ts`);
  explicit `.ts` import extensions; commit per logical unit; every commit green.

---

## Spec ambiguities resolved (implementation interpretation)

1. **Three non-policy event types in 013.** Spec §15/§21.1 mandate all six types (incl.
   `content_sync`/`content_access`/`context_update`) in the single 013 widening and in the
   TS union, even though their emitters are Phase 3/4. I treat adding their **types** now as
   the correct lockstep move (they must be representable/verify-able to keep the CHECK/TS in
   sync), but build **no emitters/content/context code** in this slice. Reconcile modes stay
   policy-only.
2. **`fail-closed` env injection.** §9.7 injects `SOR_POLICY_*`; for an invalid-present
   policy (fail-closed) the snapshot can't be a real document, so I inject mode
   `fail-closed`, a **zero-grant document** as `JSON_B64`, and its hash. This keeps the
   worker's registry-building code uniform (one code path) and satisfies P-I3 (zero grants)
   without a special "no doc" worker mode.
3. **`ArgumentMatcher` DSL.** Spec defers the exact DSL (§19) but mandates semantics; I select
   the minimal `{path, oneOf|notOneOf|match}` vocabulary as the v1 concrete matcher and flag
   it as extendable, keeping `policyEval` a pure function.
4. **Repair mechanism.** Spec §12.1 says repair is preserved; it doesn't say how it bypasses
   the trigger. I choose per-transaction `DISABLE/ENABLE TRIGGER` (named trigger, in-tx, with
   `finally` restore) over `session_replication_role` (requires elevated role, broader) — the
   minimal, safe, self-documenting choice. Only repair does this.
5. **`sor_chain` tail verification** — spec doesn't require it; included as optional
   nice-to-have (B5) so it can be skipped without blocking green.
