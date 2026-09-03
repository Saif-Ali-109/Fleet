import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AT_SUITE_INCLUDE } from "../sor/atSuiteFiles.ts";

describe("AT suite manifest", () => {
	const cwd = process.cwd();

	it("every manifest entry resolves to an existing file on disk", () => {
		const missing = AT_SUITE_INCLUDE.filter(
			(f) => !existsSync(resolve(cwd, f)),
		);
		expect(missing, `Missing AT suite files: ${missing.join(", ")}`).toEqual(
			[],
		);
	});

	it("no duplicate entries", () => {
		expect(new Set(AT_SUITE_INCLUDE).size).toBe(AT_SUITE_INCLUDE.length);
	});

	it("every entry ends with .test.ts", () => {
		for (const f of AT_SUITE_INCLUDE) {
			expect(f.endsWith(".test.ts"), `${f} must end with .test.ts`).toBe(true);
		}
	});

	it("manifest contains exactly 11 files", () => {
		expect(AT_SUITE_INCLUDE.length).toBe(11);
	});

	it("covers AT-1 through AT-10", () => {
		const joined = AT_SUITE_INCLUDE.join(" ");

		// AT-1: contentAcceptance carries provenance tuple assertions
		expect(joined).toContain("contentAcceptance");
		// AT-2: contentAcceptance carries unavailable ≠ no-match
		// (same file as AT-1, covered above)
		// AT-3: fleetLoopPolicy carries PEP-before-impl.exec
		expect(joined).toContain("fleetLoopPolicy");
		// AT-4: fleetLoopPolicy or workerPolicySnapshot
		expect(joined).toContain("workerPolicySnapshot");
		// AT-5: policyRegistry or policyCli
		expect(joined).toContain("policyRegistry");
		expect(joined).toContain("policyCli");
		// AT-6: policyForensics
		expect(joined).toContain("policyForensics");
		// AT-7: contextIntegration
		expect(joined).toContain("contextIntegration");
		// AT-8: at8DerivedIndexNotAuthoritative
		expect(joined).toContain("at8DerivedIndexNotAuthoritative");
		// AT-9: at9ChainVerifiable
		expect(joined).toContain("at9ChainVerifiable");
		// AT-10: at10NoMemoryGrounding
		expect(joined).toContain("at10NoMemoryGrounding");
	});
});
