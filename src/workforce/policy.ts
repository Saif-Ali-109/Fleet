// Workforce policy — governs which roles may be hired, on which backends,
// and up to what concurrency limits. Loadable from a JSON file (via
// WORKFORCE_POLICY_PATH or an explicit path) or falls back to a default.

import { readFileSync } from "node:fs";
import path from "node:path";

export interface WorkforcePolicy {
	max_concurrent_workers: number;
	max_per_backend: Record<string, number>;
	auto_hire_roles: string[];
	gate_hire_roles: string[];
	deny_hire_roles: string[];
	authorized_roles: string[];
}

const CORE_ROLES = ["analyzer", "planner", "coder", "tester", "reviewer", "pr"];

export function defaultPolicy(): WorkforcePolicy {
	return {
		max_concurrent_workers: 10,
		max_per_backend: { gemini: 6, openrouter: 3, ollama: 2 },
		auto_hire_roles: ["coder", "tester"],
		gate_hire_roles: ["security-auditor"],
		deny_hire_roles: [],
		authorized_roles: [...CORE_ROLES],
	};
}

function normalize(raw: Partial<WorkforcePolicy>): WorkforcePolicy {
	const base = defaultPolicy();
	return {
		max_concurrent_workers:
			typeof raw.max_concurrent_workers === "number"
				? raw.max_concurrent_workers
				: base.max_concurrent_workers,
		max_per_backend:
			raw.max_per_backend &&
			typeof raw.max_per_backend === "object" &&
			!Array.isArray(raw.max_per_backend)
				? raw.max_per_backend
				: base.max_per_backend,
		auto_hire_roles: Array.isArray(raw.auto_hire_roles)
			? raw.auto_hire_roles
			: base.auto_hire_roles,
		gate_hire_roles: Array.isArray(raw.gate_hire_roles)
			? raw.gate_hire_roles
			: base.gate_hire_roles,
		deny_hire_roles: Array.isArray(raw.deny_hire_roles)
			? raw.deny_hire_roles
			: base.deny_hire_roles,
		authorized_roles: Array.isArray(raw.authorized_roles)
			? raw.authorized_roles
			: base.authorized_roles,
	};
}

export function loadPolicy(pathArg?: string): WorkforcePolicy {
	const candidate = pathArg?.length
		? pathArg
		: process.env.WORKFORCE_POLICY_PATH;
	if (!candidate?.length) {
		return defaultPolicy();
	}
	try {
		const resolved = path.resolve(candidate);
		const parsed = JSON.parse(
			readFileSync(resolved, "utf8"),
		) as Partial<WorkforcePolicy>;
		return normalize(parsed);
	} catch {
		return defaultPolicy();
	}
}
