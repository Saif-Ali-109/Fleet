// P5.6 — unit tests for the policy mode-resolution function and the env
// snapshot injection helpers in src/agentRunner.ts (plan-sor.md §C5/C8.2/C10).
// Pure/injected fakes only — no real DB, no worker fork.

import { describe, expect, it, vi } from "vitest";
import {
	isSorPolicyConfigured,
	type PolicyModeResolution,
	policyForkEnv,
	resolvePolicyMode,
} from "../agentRunner.ts";
import type { LoadedRolePolicy } from "../db/audit.ts";
import {
	canonicalPolicyHash,
	emptyPolicy,
	type PolicyDocument,
} from "../fleet/policy.ts";
import type { Role } from "../types.ts";

const ROLE: Role = "coder";

function validLoaded(doc: PolicyDocument, version = 3): LoadedRolePolicy {
	return {
		status: "valid",
		policy: {
			policyHash: canonicalPolicyHash(doc),
			policyVersion: version,
			sourceHash: "source-hash",
			document: doc,
		},
	};
}

function docWith(overrides: Partial<PolicyDocument> = {}): PolicyDocument {
	return {
		schemaVersion: 1,
		meta: { subject_role: ROLE },
		allowedTools: ["bash", "read", "grep"],
		mcpAllow: [],
		toolRules: {},
		...overrides,
	};
}

describe("resolvePolicyMode (P5.6)", () => {
	it("(branch 1) no SOR config ⇒ declared compatibility and never touches the DB", async () => {
		const load = vi.fn(async (): Promise<LoadedRolePolicy> => {
			throw new Error("DB must not be queried without SOR config");
		});
		const res = await resolvePolicyMode({
			role: ROLE,
			sorConfigured: () => false,
			loadRolePolicy: load,
		});
		expect(res).toEqual({ mode: "compatibility" });
		expect(load).not.toHaveBeenCalled();
	});

	it("(branch 2) configured + reachable + canonical-valid row ⇒ sor", async () => {
		const doc = docWith();
		const load = vi.fn(async () => validLoaded(doc));
		const res = await resolvePolicyMode({
			role: ROLE,
			sorConfigured: () => true,
			loadRolePolicy: load,
		});
		expect(res).toEqual({
			mode: "sor",
			policyVersion: 3,
			policyHash: canonicalPolicyHash(doc),
			documentJson: JSON.stringify(doc),
		});
		expect(load).toHaveBeenCalledWith(ROLE);
	});

	it("(branch 3) configured + reachable + zero rows ⇒ declared compatibility, never fail-closed", async () => {
		const load = vi.fn(
			async (): Promise<LoadedRolePolicy> => ({
				status: "absent",
				policy: null,
			}),
		);
		const res = await resolvePolicyMode({
			role: ROLE,
			sorConfigured: () => true,
			loadRolePolicy: load,
		});
		expect(res.mode).toBe("compatibility");
		expect(res.absent).toBe(true);
		expect(res.policyVersion).toBeUndefined();
		expect(res.policyHash).toBeUndefined();
		expect(res.documentJson).toBeUndefined();
	});

	it("(branch 4) invalid present policy ⇒ fail-closed with a zero-grant snapshot", async () => {
		const load = vi.fn(
			async (): Promise<LoadedRolePolicy> => ({
				status: "invalid",
				policy: null,
				reason: "policy hash mismatch",
			}),
		);
		const res = await resolvePolicyMode({
			role: ROLE,
			sorConfigured: () => true,
			loadRolePolicy: load,
		});
		expect(res.mode).toBe("fail-closed");
		expect(res.policyVersion).toBeUndefined();
		const sentinel = emptyPolicy(ROLE);
		expect(res.policyHash).toBe(canonicalPolicyHash(sentinel));
		expect(JSON.parse(res.documentJson ?? "{}")).toEqual(sentinel);
	});

	it("(branch 4b) malformed/undecodable row routing — treats invalid as fail-closed", async () => {
		const load = vi.fn(
			async (): Promise<LoadedRolePolicy> => ({
				status: "invalid",
				policy: null,
				reason: "invalid policy document: schemaVersion must be 1",
			}),
		);
		const res = await resolvePolicyMode({
			role: ROLE,
			sorConfigured: () => true,
			loadRolePolicy: load,
		});
		expect(res.mode).toBe("fail-closed");
		expect(JSON.parse(res.documentJson ?? "{}")).toEqual(emptyPolicy(ROLE));
	});

	it("(branch 5) configured but unreachable DB ⇒ fail-closed, not compatibility", async () => {
		const load = vi.fn(async (): Promise<LoadedRolePolicy> => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
		});
		const res = await resolvePolicyMode({
			role: ROLE,
			sorConfigured: () => true,
			loadRolePolicy: load,
		});
		expect(res.mode).toBe("fail-closed");
		expect(res.policyVersion).toBeUndefined();
		const sentinel = emptyPolicy(ROLE);
		expect(res.policyHash).toBe(canonicalPolicyHash(sentinel));
		expect(JSON.parse(res.documentJson ?? "{}")).toEqual(sentinel);
	});

	it("(FR-11) empty-but-valid policy ⇒ stays sor with zero grants", async () => {
		const emptyDoc = emptyPolicy(ROLE);
		const load = vi.fn(async () => validLoaded(emptyDoc, 2));
		const res = await resolvePolicyMode({
			role: ROLE,
			sorConfigured: () => true,
			loadRolePolicy: load,
		});
		expect(res.mode).toBe("sor");
		expect(res.policyVersion).toBe(2);
		const parsed = JSON.parse(res.documentJson ?? "{}") as PolicyDocument;
		expect(parsed.allowedTools).toEqual([]);
		expect(parsed.mcpAllow).toEqual([]);
		expect(parsed.toolRules).toEqual({});
		expect(canonicalPolicyHash(parsed)).toBe(canonicalPolicyHash(emptyDoc));
	});
});

describe("policyForkEnv (snapshot injection, spec §9.7)", () => {
	it("compatibility ⇒ no SOR_POLICY_* env at all", () => {
		expect(policyForkEnv({ mode: "compatibility", absent: true })).toEqual({});
		expect(policyForkEnv({ mode: "compatibility" })).toEqual({});
	});

	it("sor ⇒ MODE/HASH/VERSION/JSON_B64 and the b64 decodes to the document", () => {
		const doc = docWith();
		const resolved: PolicyModeResolution = {
			mode: "sor",
			policyVersion: 5,
			policyHash: canonicalPolicyHash(doc),
			documentJson: JSON.stringify(doc),
		};
		const env = policyForkEnv(resolved);
		expect(env.SOR_POLICY_MODE).toBe("sor");
		expect(env.SOR_POLICY_VERSION).toBe("5");
		expect(env.SOR_POLICY_HASH).toBe(canonicalPolicyHash(doc));
		expect(JSON.parse(atob(env.SOR_POLICY_JSON_B64 ?? ""))).toEqual(doc);
	});

	it("fail-closed ⇒ MODE/HASH/JSON_B64 with the empty-grant sentinel, no VERSION", () => {
		const resolved: PolicyModeResolution = {
			mode: "fail-closed",
			policyHash: canonicalPolicyHash(emptyPolicy(ROLE)),
			documentJson: JSON.stringify(emptyPolicy(ROLE)),
		};
		const env = policyForkEnv(resolved);
		expect(env.SOR_POLICY_MODE).toBe("fail-closed");
		expect(env.SOR_POLICY_VERSION).toBeUndefined();
		expect(env.SOR_POLICY_HASH).toBe(canonicalPolicyHash(emptyPolicy(ROLE)));
		expect(JSON.parse(atob(env.SOR_POLICY_JSON_B64 ?? ""))).toEqual(
			emptyPolicy(ROLE),
		);
	});
});

describe("isSorPolicyConfigured", () => {
	it("false when DATABASE_URL is unset or empty", () => {
		const saved = process.env.DATABASE_URL;
		delete process.env.DATABASE_URL;
		try {
			expect(isSorPolicyConfigured()).toBe(false);
			process.env.DATABASE_URL = "";
			expect(isSorPolicyConfigured()).toBe(false);
		} finally {
			if (saved === undefined) delete process.env.DATABASE_URL;
			else process.env.DATABASE_URL = saved;
		}
	});

	it("true when DATABASE_URL is set (policy subsystem configured)", () => {
		const saved = process.env.DATABASE_URL;
		process.env.DATABASE_URL = "postgresql://test";
		try {
			expect(isSorPolicyConfigured()).toBe(true);
		} finally {
			if (saved === undefined) delete process.env.DATABASE_URL;
			else process.env.DATABASE_URL = saved;
		}
	});
});
