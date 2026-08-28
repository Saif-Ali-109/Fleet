import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultPolicy, loadPolicy } from "../workforce/policy.ts";

let root = "";
const savedEnv = process.env.WORKFORCE_POLICY_PATH;

function writePolicyFile(policy: string): string {
	const p = join(root, "policy.json");
	writeFileSync(p, policy, "utf8");
	return p;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "workforce-policy-"));
	delete process.env.WORKFORCE_POLICY_PATH;
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	if (savedEnv === undefined) {
		delete process.env.WORKFORCE_POLICY_PATH;
	} else {
		process.env.WORKFORCE_POLICY_PATH = savedEnv;
	}
});

describe("defaultPolicy", () => {
	it("returns the built-in defaults", () => {
		expect(defaultPolicy()).toEqual({
			max_concurrent_workers: 10,
			max_per_backend: { gemini: 6, openrouter: 3, ollama: 2 },
			auto_hire_roles: ["coder", "tester"],
			gate_hire_roles: ["security-auditor"],
			deny_hire_roles: [],
			authorized_roles: [
				"analyzer",
				"planner",
				"coder",
				"tester",
				"reviewer",
				"pr",
			],
		});
	});
});

describe("loadPolicy", () => {
	it("returns the default policy when no path and no env var are set", () => {
		expect(loadPolicy()).toEqual(defaultPolicy());
	});

	it("returns the default policy for an empty path argument", () => {
		expect(loadPolicy("")).toEqual(defaultPolicy());
	});

	it("loads a policy from an explicit path", () => {
		const p = writePolicyFile(
			JSON.stringify({
				max_concurrent_workers: 3,
				max_per_backend: { gemini: 2 },
				auto_hire_roles: ["coder"],
				gate_hire_roles: [],
				deny_hire_roles: ["pr"],
				authorized_roles: ["coder"],
			}),
		);
		expect(loadPolicy(p)).toEqual({
			max_concurrent_workers: 3,
			max_per_backend: { gemini: 2 },
			auto_hire_roles: ["coder"],
			gate_hire_roles: [],
			deny_hire_roles: ["pr"],
			authorized_roles: ["coder"],
		});
	});

	it("reads the policy path from WORKFORCE_POLICY_PATH when no arg is given", () => {
		const p = writePolicyFile(
			JSON.stringify({ max_concurrent_workers: 5, auto_hire_roles: [] }),
		);
		process.env.WORKFORCE_POLICY_PATH = p;
		const policy = loadPolicy();
		expect(policy.max_concurrent_workers).toBe(5);
		expect(policy.auto_hire_roles).toEqual([]);
	});

	it("fills missing fields from the defaults", () => {
		const p = writePolicyFile(JSON.stringify({ max_concurrent_workers: 7 }));
		const policy = loadPolicy(p);
		expect(policy.max_concurrent_workers).toBe(7);
		expect(policy.max_per_backend).toEqual(defaultPolicy().max_per_backend);
		expect(policy.auto_hire_roles).toEqual(defaultPolicy().auto_hire_roles);
		expect(policy.authorized_roles).toEqual(defaultPolicy().authorized_roles);
	});

	it("rejects non-number max_concurrent_workers", () => {
		const p = writePolicyFile(
			JSON.stringify({ max_concurrent_workers: "lots" }),
		);
		expect(loadPolicy(p).max_concurrent_workers).toBe(10);
	});

	it("rejects arrays in place of max_per_backend", () => {
		const p = writePolicyFile(
			JSON.stringify({
				max_per_backend: ["gemini", "openrouter"],
				auto_hire_roles: "coder",
				gate_hire_roles: "guard",
				deny_hire_roles: { role: "pr" },
				authorized_roles: 5,
			}),
		);
		const policy = loadPolicy(p);
		expect(policy.max_per_backend).toEqual(defaultPolicy().max_per_backend);
		expect(policy.auto_hire_roles).toEqual(defaultPolicy().auto_hire_roles);
		expect(policy.gate_hire_roles).toEqual(defaultPolicy().gate_hire_roles);
		expect(policy.deny_hire_roles).toEqual(defaultPolicy().deny_hire_roles);
		expect(policy.authorized_roles).toEqual(defaultPolicy().authorized_roles);
	});

	it("falls back to the default when the file is not valid JSON", () => {
		const p = writePolicyFile("not json {");
		expect(loadPolicy(p)).toEqual(defaultPolicy());
	});

	it("falls back to the default when the file does not exist", () => {
		expect(loadPolicy(join(root, "missing.json"))).toEqual(defaultPolicy());
	});
});
