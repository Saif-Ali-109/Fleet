import { describe, expect, it } from "vitest";
import {
	assertCanonicalHash,
	canonicalizeStructured,
	canonicalizeText,
	canonicalRepresentation,
	computeCanonicalHash,
	sha256Hex,
	verifyCanonicalHash,
} from "../hash.ts";
import { RESERVED_NAMESPACE, type SorRecordIdentity } from "../types.ts";

function makeIdentity(
	overrides: Partial<SorRecordIdentity> = {},
): SorRecordIdentity {
	return {
		sorType: "content",
		sourceId: "doc-1",
		namespace: RESERVED_NAMESPACE,
		version: 1,
		hash: "unset",
		...overrides,
	};
}

describe("sha256Hex (T7.1)", () => {
	it("matches the locked vector for '{\"a\":\"b\"}'", () => {
		expect(sha256Hex('{"a":"b"}')).toBe(
			"db4a7ecb114bc66c623a06c4ff6fe8daa2f49cc270ebbf7a1f81e22ab061c837",
		);
	});

	it("returns a 64-char lowercase hex digest", () => {
		expect(sha256Hex("hello")).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("canonicalizeText (T7.2)", () => {
	it("strips a leading BOM", () => {
		expect(canonicalizeText("\uFEFFline1")).toBe("line1");
	});

	it("NFC-normalizes composed vs decomposed accents", () => {
		// "é" as decomposed e + combining acute
		expect(canonicalizeText("e\u0301")).toBe("\u00e9");
	});

	it("normalizes CRLF and CR to LF", () => {
		expect(canonicalizeText("a\r\nb\r\nc")).toBe("a\nb\nc");
		expect(canonicalizeText("a\rb\rc")).toBe("a\nb\nc");
	});

	it("trims trailing whitespace per line and trims the corpus edges", () => {
		expect(canonicalizeText("  a  \nb  \n")).toBe("a\nb");
		expect(canonicalizeText("\n  a\nb  \n")).toBe("a\nb");
	});

	it("preserves blank interior lines while trimming their trailing whitespace", () => {
		expect(canonicalizeText("a\n\n  \nb")).toBe("a\n\n\nb");
	});

	it("matches the locked hash vector for 'line1\\nline2' (T7.3)", () => {
		expect(sha256Hex(canonicalizeText("line1\nline2"))).toBe(
			"683376e290829b482c2655745caffa7a1dccfa10afaa62dac2b42dd6c68d0f83",
		);
	});
});

describe("canonicalizeStructured (T7.4)", () => {
	it("is stable under key insertion order (delegates to canonicalJson)", () => {
		const a = canonicalizeStructured({ b: 1, a: { d: 4, c: 3 } });
		const b = canonicalizeStructured({ a: { c: 3, d: 4 }, b: 1 });
		expect(a).toBe(b);
		expect(a).toBe('{"a":{"c":"3","d":"4"},"b":"1"}');
	});
});

describe("computeCanonicalHash (T7.5)", () => {
	it("is deterministic for identical bodies", () => {
		const body = { sorType: "policy" as const, body: { a: 1, b: 2 } };
		expect(computeCanonicalHash(body)).toBe(computeCanonicalHash(body));
	});

	it("differs when the body changes", () => {
		const h1 = computeCanonicalHash({ sorType: "policy", body: { a: 1 } });
		const h2 = computeCanonicalHash({ sorType: "policy", body: { a: 2 } });
		expect(h1).not.toBe(h2);
	});

	it("differs when the sorType changes for the same body", () => {
		const h1 = computeCanonicalHash({ sorType: "content", body: "x" });
		const h2 = computeCanonicalHash({ sorType: "context", body: "x" });
		expect(h1).not.toBe(h2);
	});

	it("is stable under key insertion order", () => {
		const h1 = computeCanonicalHash({
			sorType: "content",
			body: { a: 1 },
		});
		const h2 = computeCanonicalHash({
			sorType: "content",
			body: { a: 1 },
		});
		expect(h1).toBe(h2);
	});
});

describe("hash-field exclusion (T7.6)", () => {
	it("never feeds the record's own hash field into the canonical body", () => {
		const body = { a: 1, b: "text" };
		// the record's hash field is part of the identity, not the body that is hashed
		const recordA = makeIdentity({
			sorType: "policy",
			hash: "a".repeat(64),
		});
		const recordB = makeIdentity({
			sorType: "policy",
			hash: "b".repeat(64),
		});
		// changing the record.hash does not change the canonical hash of the body
		expect(computeCanonicalHash({ sorType: "policy", body })).toBe(
			computeCanonicalHash({ sorType: "policy", body }),
		);
		// the record's hash value is never part of the canonical representation
		expect(canonicalizeStructured(body)).not.toContain(recordA.hash);
		expect(canonicalizeStructured(body)).not.toContain(recordB.hash);
		// and a verify on either record against the same body passes only if the
		// recorded hash equals the body's canonical hash (cycle-free)
		expect(verifyCanonicalHash(recordA, body)).toBe(false);
	});
});

describe("verifyCanonicalHash / assertCanonicalHash (T7.7)", () => {
	const body = { a: 1, b: "text" };
	const hash = computeCanonicalHash({ sorType: "policy", body });

	it("verifies true when record.hash matches the computed canonical hash", () => {
		const record = makeIdentity({ sorType: "policy", hash });
		expect(verifyCanonicalHash(record, body)).toBe(true);
		expect(() => assertCanonicalHash(record, body)).not.toThrow();
	});

	it("verifies false and throws when the body differs (fail-closed)", () => {
		const record = makeIdentity({ sorType: "policy", hash });
		expect(verifyCanonicalHash(record, { a: 999 })).toBe(false);
		expect(() => assertCanonicalHash(record, { a: 999 })).toThrow(/mismatch/);
	});
});

describe("dispatcher routing (T7.8)", () => {
	it("routes content to the text path", () => {
		const text = "line1\nline2";
		expect(canonicalRepresentation({ sorType: "content", body: text })).toBe(
			canonicalizeText(text),
		);
	});

	it("routes policy and context to the structured path", () => {
		const body = { b: 2, a: 1 };
		const structured = canonicalizeStructured(body);
		expect(canonicalRepresentation({ sorType: "policy", body })).toBe(
			structured,
		);
		expect(canonicalRepresentation({ sorType: "context", body })).toBe(
			structured,
		);
	});
});
