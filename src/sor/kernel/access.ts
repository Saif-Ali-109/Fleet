// SoR Kernel — access model enforcement (FR-5, §8.1).

import type { SorType } from "./types.ts";

export type AccessPrincipal = "agent" | "manager" | "cli" | "service";
export type AccessOperation = "read" | "write";
export type AccessDomain = SorType | "audit";

export interface AccessDecision {
	allowed: boolean;
	domain: AccessDomain;
	operation: AccessOperation;
	principal: AccessPrincipal;
	note?: string;
}

// Locked permission table (§8.1).
const PERMISSIONS: Record<
	AccessDomain,
	{ read: AccessPrincipal[]; write: AccessPrincipal[] }
> = {
	content: {
		read: ["agent", "manager", "cli", "service"],
		write: ["manager", "cli", "service"],
	},
	policy: {
		read: ["agent", "manager", "cli", "service"],
		write: ["manager", "cli"],
	},
	context: {
		read: ["agent", "manager", "cli", "service"],
		write: ["manager", "cli"],
	},
	audit: {
		read: ["agent", "manager", "cli", "service"],
		write: ["manager", "service"], // append-only: update/delete always denied
	},
};

function denyNote(
	domain: AccessDomain,
	operation: AccessOperation,
	principal: AccessPrincipal,
): string {
	if (domain === "audit" && operation === "write") {
		return `audit domain is append-only; '${principal}' may not write it (update/delete always denied)`;
	}
	return `principal '${principal}' may not ${operation} the '${domain}' domain`;
}

export function checkAccess(
	domain: AccessDomain,
	operation: AccessOperation,
	principal: AccessPrincipal,
): AccessDecision {
	const allowed = PERMISSIONS[domain][operation].includes(principal);
	return {
		allowed,
		domain,
		operation,
		principal,
		...(!allowed ? { note: denyNote(domain, operation, principal) } : {}),
	};
}

export function assertReadAllowed(
	domain: AccessDomain,
	principal: AccessPrincipal,
): void {
	const decision = checkAccess(domain, "read", principal);
	if (!decision.allowed) {
		throw new Error(decision.note);
	}
}

export function assertWriteAllowed(
	domain: AccessDomain,
	principal: AccessPrincipal,
): void {
	const decision = checkAccess(domain, "write", principal);
	if (!decision.allowed) {
		throw new Error(decision.note);
	}
}

export function isAppendOnly(domain: AccessDomain): boolean {
	return domain === "audit";
}
