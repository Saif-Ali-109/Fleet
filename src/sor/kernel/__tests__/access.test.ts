import { describe, expect, it } from "vitest";
import {
	type AccessDomain,
	type AccessPrincipal,
	assertReadAllowed,
	assertWriteAllowed,
	checkAccess,
	isAppendOnly,
} from "../access.ts";

const DOMAINS: AccessDomain[] = ["content", "policy", "context", "audit"];
const PRINCIPALS: AccessPrincipal[] = ["agent", "manager", "cli", "service"];

describe("read grants (T9.1)", () => {
	it("allows every read cell for all four domains", () => {
		for (const domain of DOMAINS) {
			for (const principal of PRINCIPALS) {
				const d = checkAccess(domain, "read", principal);
				expect(
					d.allowed,
					`expected ${principal} read ${domain} to be allowed`,
				).toBe(true);
				expect(() => assertReadAllowed(domain, principal)).not.toThrow();
			}
		}
	});
});

describe("content write (T9.2)", () => {
	it("allows manager, cli, service and denies agent", () => {
		expect(checkAccess("content", "write", "manager").allowed).toBe(true);
		expect(checkAccess("content", "write", "cli").allowed).toBe(true);
		expect(checkAccess("content", "write", "service").allowed).toBe(true);

		const denied = checkAccess("content", "write", "agent");
		expect(denied.allowed).toBe(false);
		expect(denied.note).toBeTruthy();
		expect(() => assertWriteAllowed("content", "agent")).toThrow();
	});
});

describe("policy write (T9.3)", () => {
	it("allows manager, cli and denies agent + service", () => {
		expect(checkAccess("policy", "write", "manager").allowed).toBe(true);
		expect(checkAccess("policy", "write", "cli").allowed).toBe(true);

		for (const principal of ["agent", "service"] as AccessPrincipal[]) {
			const denied = checkAccess("policy", "write", principal);
			expect(denied.allowed).toBe(false);
			expect(denied.note).toBeTruthy();
			expect(() => assertWriteAllowed("policy", principal)).toThrow();
		}
	});
});

describe("context write (T9.4)", () => {
	it("allows manager, cli and denies agent + service", () => {
		expect(checkAccess("context", "write", "manager").allowed).toBe(true);
		expect(checkAccess("context", "write", "cli").allowed).toBe(true);

		for (const principal of ["agent", "service"] as AccessPrincipal[]) {
			const denied = checkAccess("context", "write", principal);
			expect(denied.allowed).toBe(false);
			expect(denied.note).toBeTruthy();
			expect(() => assertWriteAllowed("context", principal)).toThrow();
		}
	});
});

describe("audit (T9.5)", () => {
	it("is the only append-only domain", () => {
		expect(isAppendOnly("audit")).toBe(true);
		for (const domain of ["content", "policy", "context"] as AccessDomain[]) {
			expect(isAppendOnly(domain)).toBe(false);
		}
	});

	it("allows read for every principal", () => {
		for (const principal of PRINCIPALS) {
			expect(checkAccess("audit", "read", principal).allowed).toBe(true);
		}
	});

	it("audit writes deny cli (append-only; update/delete never)", () => {
		// write column: manager, service
		expect(checkAccess("audit", "write", "manager").allowed).toBe(true);
		expect(checkAccess("audit", "write", "service").allowed).toBe(true);
		for (const principal of ["agent", "cli"] as AccessPrincipal[]) {
			const denied = checkAccess("audit", "write", principal);
			expect(denied.allowed).toBe(false);
			expect(denied.note).toMatch(/append-only/);
			expect(() => assertWriteAllowed("audit", principal)).toThrow(
				/append-only/,
			);
		}
	});
});

describe("assert notes (T9.6)", () => {
	it("throws a clear note on every denied write", () => {
		const deniedWrites: Array<[AccessDomain, AccessPrincipal]> = [
			["content", "agent"],
			["policy", "agent"],
			["policy", "service"],
			["context", "agent"],
			["context", "service"],
			["audit", "agent"],
			["audit", "cli"],
		];
		for (const [domain, principal] of deniedWrites) {
			const note = checkAccess(domain, "write", principal).note;
			expect(note).toBeTruthy();
			expect(() => assertWriteAllowed(domain, principal)).toThrow(note!);
		}
	});

	it("throws for a denied write with an informative message", () => {
		expect(() => assertWriteAllowed("policy", "agent")).toThrow(
			/may not write the 'policy' domain/,
		);
		expect(() => assertWriteAllowed("audit", "cli")).toThrow(/append-only/);
	});
});
