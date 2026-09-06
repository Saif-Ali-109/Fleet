// AT → file manifest: single source of truth for the one-pass AT runner.
// One comment per entry is the no-comments exception — the mapping must be self-documenting.

export const AT_SUITE_INCLUDE: readonly string[] = [
	// AT-3 (PEP never runs impl.exec) + AT-4 (capability ≤ grant, fail-closed)
	"src/__tests__/fleetLoopPolicy.test.ts",
	// AT-4 (capability ceiling)
	"src/__tests__/workerPolicySnapshot.test.ts",
	// AT-5 (drift cannot silently grant)
	"src/db/__tests__/policyRegistry.test.ts",
	// AT-5 (drift discipline)
	"src/__tests__/policyCli.test.ts",
	// AT-6 (policy reconstructible from chain)
	"src/sor/__tests__/policyForensics.test.ts",
	// AT-1 (provenance tuple) + AT-2 (unavailable ≠ no-match) + AT-3..AT-6 regression
	"src/fleet/__tests__/contentAcceptance.test.ts",
	// AT-7 (context versioned; freshness explicit/honored)
	"src/fleet/__tests__/contextIntegration.test.ts",
	// §13 unified surface cross-domain composition
	"src/fleet/__tests__/sorClientAcceptance.test.ts",
	// AT-8 (derived index not authoritative)
	"src/fleet/__tests__/at8DerivedIndexNotAuthoritative.test.ts",
	// AT-9 (chain verifiable)
	"src/sor/__tests__/at9ChainVerifiable.test.ts",
	// AT-10 (no memory grounding)
	"src/fleet/__tests__/at10NoMemoryGrounding.test.ts",
] as const;
