import { describe, expect, it } from "vitest";
import { C2_GROUNDING_DIRECTIVE } from "../c2Directive.ts";

describe("C2_GROUNDING_DIRECTIVE (T4)", () => {
	it("contains the 'knowledge source unavailable' marker", () => {
		expect(C2_GROUNDING_DIRECTIVE).toContain("knowledge source unavailable");
	});

	it("contains the 'no authoritative content found' marker", () => {
		expect(C2_GROUNDING_DIRECTIVE).toContain("no authoritative content found");
	});

	it("contains provenance marker (or tuple field names)", () => {
		const directive = C2_GROUNDING_DIRECTIVE;
		expect(directive).toContain("provenance");
		expect(directive).toContain("source");
		expect(directive).toContain("document");
		expect(directive).toContain("section");
		expect(directive).toContain("version");
		expect(directive).toContain("content_hash");
	});

	it("contains model-memory / not-grounded marker", () => {
		const directive = C2_GROUNDING_DIRECTIVE;
		const hasModelMemory = directive.includes("model memory");
		const hasModelMemoryAlt = directive.includes("model-memory");
		const hasNotGrounded = directive.includes("not grounded");
		expect(hasModelMemory || hasModelMemoryAlt || hasNotGrounded).toBe(true);
	});

	it("contains retrieval marker", () => {
		expect(C2_GROUNDING_DIRECTIVE).toContain("retrieval");
	});

	it("is a non-empty string suitable for prepending/appending to systemPrompt", () => {
		expect(typeof C2_GROUNDING_DIRECTIVE).toBe("string");
		expect(C2_GROUNDING_DIRECTIVE.length).toBeGreaterThan(0);
		expect(C2_GROUNDING_DIRECTIVE.trim()).toBe(C2_GROUNDING_DIRECTIVE);
	});
});
